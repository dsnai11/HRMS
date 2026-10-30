import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

test("surveys: anonymous answers, eNPS, results only with five or more, groups and audience", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const signIn = async (email, password) =>
    (await call("/login", { email, password, native: true, device: { id: `dev-${email.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 60), platform: "android", model: "T" } })).data.token;
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const dept = async (name) => (await call("/admin/departments", { name }, owner)).data.id;
  const sales = await dept("Sales"),
    ops = await dept("Operations");
  assert.ok(sales && ops);
  const people = [];
  for (let i = 1; i <= 8; i++) {
    const r = await call("/admin/employees", { name: `P${i}`, email: `p${i}@example.test`, password: "Temporary-pass-123", department_id: i <= 6 ? sales : ops, role: i === 1 ? "hr" : "employee" }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    people.push({ id: r.data.id, token: await signIn(`p${i}@example.test`, "Temporary-pass-123") });
  }
  const hr = people[0].token;

  const questions = [
    { type: "enps" },
    { type: "rating", text: "My manager supports me" },
    { type: "choice", text: "Where do you mostly work?", options: ["Branch", "Field", "Head office"] },
    { type: "text", text: "Anything else?" },
  ];
  assert.equal((await call("/admin/surveys", { title: "Pulse", questions, closes_on: "2026-01-01" }, hr)).status, 400, "closing date in the past");
  assert.equal((await call("/admin/surveys", { title: "Pulse", questions: [{ type: "choice", text: "x", options: ["only"] }], closes_on: "2099-01-01" }, hr)).status, 400);
  const s = await call("/admin/surveys", { title: "Q4 pulse", questions, closes_on: "2099-01-01" }, hr);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await call("/surveys", undefined, people[2].token)).data.length, 0, "a draft is not shown");
  assert.equal((await call(`/admin/surveys/${s.data.id}/open`, {}, hr)).data.people, 8);
  const [mine] = (await call("/surveys", undefined, people[2].token)).data;
  assert.equal(mine.questions[0].text.startsWith("How likely"), true);

  const answer = (i, e, r, c, text) => call(`/surveys/${s.data.id}/respond`, { answers: { q1: e, q2: r, q3: c, ...(text ? { q4: text } : {}) } }, people[i].token);
  assert.equal((await answer(1, 11, 3, "Branch")).status, 400, "eNPS is 0 to 10");
  assert.equal((await answer(1, 9, 3, "Moon")).status, 400);
  assert.equal((await answer(1, 9, 4, "Branch", "Good team")).status, 201);
  assert.equal((await answer(1, 9, 4, "Branch")).status, 409, "once each");
  for (const [i, e, r] of [[2, 10, 5], [3, 6, 2], [4, 8, 3]]) assert.equal((await answer(i, e, r, "Field")).status, 201);
  // Four answers: nothing is shown yet.
  let res = (await call(`/admin/surveys/${s.data.id}/results`, undefined, hr)).data;
  assert.deepEqual([res.answered, res.hidden, res.results], [4, true, null]);
  assert.equal((await call(`/admin/surveys/${s.data.id}/results`, undefined, people[3].token)).status, 403, "employees do not see results");
  for (const [i, e, r] of [[5, 3, 1], [6, 10, 5], [7, 9, 4]]) assert.equal((await answer(i, e, r, "Head office", i === 5 ? "Need more staff" : null)).status, 201);
  res = (await call(`/admin/surveys/${s.data.id}/results?by=department`, undefined, hr)).data;
  assert.equal(res.answered, 7);
  const enps = res.results[0];
  // 9,10,6,8,3,10,9: promoters 4, passives 1, detractors 2 -> (4-2)/7 = 29
  assert.deepEqual([enps.promoters, enps.passives, enps.detractors, enps.score], [4, 1, 2, 29]);
  assert.equal(res.results[1].average, 3.4);
  assert.deepEqual(res.results[2].counts, [1, 3, 3]);
  assert.deepEqual(res.results[3].comments, ["Good team", "Need more staff"]);
  // Sales has 5 answers (shown), Operations 2 (hidden); comments are never per group.
  const bySales = res.groups.find((g) => g.name === "Sales"),
    byOps = res.groups.find((g) => g.name === "Operations");
  assert.deepEqual([bySales.answers, bySales.hidden, byOps.answers, byOps.hidden, byOps.results], [5, false, 2, true, null]);
  assert.ok(!bySales.results.some((q) => q.type === "text"));
  // Nothing in the answers says who gave them.
  const cols = (await db.prepare("SELECT * FROM survey_responses LIMIT 1").get());
  assert.deepEqual(Object.keys(cols).sort(), ["answers", "branch_id", "department_id", "id", "submitted_on", "survey_id"]);
  assert.match(cols.submitted_on, /^\d{4}-\d{2}-\d{2}$/, "a date, not a time");

  // A survey for Operations only; closed surveys take no answers.
  const opsOnly = (await call("/admin/surveys", { title: "Ops check-in", questions: [{ type: "rating", text: "Tools are adequate" }], closes_on: "2099-01-01", audience: { department_ids: [ops] } }, hr)).data.id;
  assert.equal((await call(`/admin/surveys/${opsOnly}/open`, {}, hr)).data.people, 2);
  assert.ok(!(await call("/surveys", undefined, people[1].token)).data.some((x) => x.id === opsOnly));
  assert.equal((await call(`/surveys/${opsOnly}/respond`, { answers: { q1: 4 } }, people[1].token)).status, 404);
  assert.equal((await call(`/admin/surveys/${opsOnly}/close`, {}, hr)).status, 200);
  assert.equal((await call(`/surveys/${opsOnly}/respond`, { answers: { q1: 4 } }, people[7].token)).status, 404);
  const list = (await call("/admin/surveys", undefined, hr)).data.surveys;
  assert.deepEqual(list.map((x) => [x.title, x.status, x.answered, x.eligible]), [["Ops check-in", "closed", 0, 2], ["Q4 pulse", "open", 7, 8]]);
});
