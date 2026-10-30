import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

async function world(t) {
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
    (await call("/login", { email, password, native: true, device: { id: `dev-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 60), platform: "android", model: "T" } })).data.token;
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const people = {};
  for (const [key, role] of [["hr", "hr"], ["hr2", "hr"], ["emp", "employee"], ["boss", "employee"], ["ic", "employee"], ["vig", "employee"]]) {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: "Temporary-pass-123", role }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`, "Temporary-pass-123") };
  }
  return { db, call, owner, people };
}

test("grievances go to HR, never to the person named; POSH only to the Internal Committee", async (t) => {
  const { db, call, owner, people } = await world(t);
  const { hr, hr2, emp, boss, ic } = people;
  const g = await call("/cases", { kind: "grievance", category: "Manager or colleague", subject: "Unfair shift changes", description: "My shift is changed every week without notice.", against_user_id: hr.id }, emp.token);
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.match(g.data.code, /^GR-[0-9A-F]{8}$/);
  assert.equal(g.data.follow_key, undefined);
  // HR named in it cannot see it; another HR can.
  assert.equal((await call("/admin/cases", undefined, hr.token)).data.cases.length, 0);
  assert.equal((await call(`/admin/cases/${g.data.id}`, undefined, hr.token)).status, 404);
  const list = (await call("/admin/cases", undefined, hr2.token)).data;
  assert.deepEqual(list.kinds, ["grievance"]);
  assert.equal(list.cases[0].reporter_name, "EMP");
  const detail = (await call(`/admin/cases/${g.data.id}`, undefined, hr2.token)).data;
  assert.equal(detail.against.name, "HR");
  assert.ok(!detail.handlers.some((h) => h.id === hr.id), "the person named is never a handler");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM audit WHERE action='case_viewed'").get()).n, 1);
  // Employees do not handle cases at all.
  assert.equal((await call("/admin/cases", undefined, boss.token)).status, 403);
  // Assignment only to a handler; resolving needs an outcome; the reporter hears about it.
  assert.equal((await call(`/admin/cases/${g.data.id}`, { assigned_to: hr.id }, hr2.token, "PATCH")).status, 400);
  assert.equal((await call(`/admin/cases/${g.data.id}`, { assigned_to: hr2.id, status: "investigating" }, hr2.token, "PATCH")).status, 200);
  assert.equal((await call(`/admin/cases/${g.data.id}/messages`, { body: "Spoke to the branch manager.", internal: true }, hr2.token)).status, 201);
  assert.equal((await call(`/admin/cases/${g.data.id}/messages`, { body: "We are looking into it." }, hr2.token)).status, 201);
  assert.equal((await call(`/admin/cases/${g.data.id}`, { status: "resolved" }, hr2.token, "PATCH")).status, 400);
  assert.equal((await call(`/admin/cases/${g.data.id}`, { status: "resolved", outcome: "Roster fixed for three months." }, hr2.token, "PATCH")).status, 200);
  const mine = (await call("/cases/mine", undefined, emp.token)).data[0];
  assert.deepEqual([mine.status, mine.outcome], ["resolved", "Roster fixed for three months."]);
  assert.deepEqual(mine.messages.map((m) => m.body), ["We are looking into it."], "internal notes stay internal");
  assert.equal((await call(`/cases/${g.data.id}/reply`, { body: "Thank you" }, emp.token)).status, 201);
  assert.equal((await call(`/cases/${g.data.id}/reply`, { body: "x" }, boss.token)).status, 404, "only the reporter replies");

  // POSH: never anonymous; HR does not see it; only the committee does.
  assert.equal((await call("/cases", { kind: "posh", category: "Sexually coloured remarks", subject: "Remarks", description: "Repeated remarks.", anonymous: true }, emp.token)).status, 400);
  assert.equal((await call("/admin/case-committees/posh", { user_ids: [ic.id] }, hr.token, "PUT")).status, 403, "only admins name committees");
  assert.equal((await call("/admin/case-committees/posh", { user_ids: [ic.id] }, owner, "PUT")).status, 200);
  const p = await call("/cases", { kind: "posh", category: "Sexually coloured remarks", subject: "Remarks at the branch", description: "Repeated remarks by a colleague.", against_user_id: boss.id, incident_date: "2026-01-10" }, emp.token);
  assert.equal(p.status, 201, JSON.stringify(p.data));
  assert.ok(!(await call("/admin/cases", undefined, hr2.token)).data.cases.some((c) => c.kind === "posh"));
  assert.equal((await call(`/admin/cases/${p.data.id}`, undefined, hr2.token)).status, 404);
  const icList = (await call("/admin/cases", undefined, ic.token)).data;
  assert.deepEqual([icList.kinds, icList.cases.map((c) => c.code)], [["posh"], [p.data.code]]);
  assert.equal((await call("/me", undefined, ic.token)).data.case_kinds[0], "posh");
  // 90 days for the inquiry.
  const due = (await db.prepare("SELECT due_date,created_at FROM cases WHERE id=?").get(p.data.id));
  assert.equal((Date.parse(due.due_date) - Date.parse(due.created_at.slice(0, 10))) / 86400000, 90);
});

test("anonymous whistleblower reports keep no link to the reporter; follow-up is by code and key", async (t) => {
  const { db, call, owner, people } = await world(t);
  const { emp, vig, hr } = people;
  assert.equal((await call("/admin/case-committees/whistleblower", { user_ids: [vig.id] }, owner, "PUT")).status, 200);
  const w = await call("/cases", { kind: "whistleblower", category: "Loan or KYC irregularity", subject: "Loans without KYC", description: "Branch is disbursing gold loans without KYC.", anonymous: true }, emp.token);
  assert.equal(w.status, 201, JSON.stringify(w.data));
  assert.ok(w.data.follow_key.length >= 20);
  const row = await db.prepare("SELECT * FROM cases WHERE id=?").get(w.data.id);
  assert.deepEqual([row.reporter_id, row.anonymous, row.branch_id], [null, 1, null]);
  assert.notEqual(row.follow_key_hash, w.data.follow_key, "only a hash of the key is kept");
  const raised = await db.prepare("SELECT actor_id FROM audit WHERE action='case_raised'").get();
  assert.equal(raised.actor_id, null, "the activity log does not name the reporter");
  assert.equal((await call("/cases/mine", undefined, emp.token)).data.length, 0);
  // The committee sees it without a name; HR does not see it.
  const seen = (await call("/admin/cases", undefined, vig.token)).data.cases[0];
  assert.deepEqual([seen.code, seen.reporter_name, seen.anonymous], [w.data.code, null, true]);
  assert.equal((await call("/admin/cases", undefined, hr.token)).data.cases.length, 0);
  // Follow-up with the code and key; a wrong key gets nothing.
  assert.equal((await call("/cases/follow", { code: w.data.code, key: "wrong-key-wrong-key" }, emp.token)).status, 404);
  assert.equal((await call(`/admin/cases/${w.data.id}/messages`, { body: "Which branch, and since when?" }, vig.token)).status, 201);
  const view = (await call("/cases/follow", { code: w.data.code.toLowerCase(), key: w.data.follow_key }, emp.token)).data;
  assert.deepEqual(view.messages.map((m) => [m.author, m.body]), [["Committee / HR", "Which branch, and since when?"]]);
  assert.equal((await call("/cases/follow/reply", { code: w.data.code, key: w.data.follow_key, body: "Kota branch, since August." }, emp.token)).status, 201);
  const detail = (await call(`/admin/cases/${w.data.id}`, undefined, vig.token)).data;
  assert.deepEqual(detail.messages.map((m) => [m.from_reporter, m.author]), [[0, "VIG"], [1, null]]);
  assert.equal(detail.reporter, null);
  assert.equal((await db.prepare("SELECT author_id FROM case_messages WHERE from_reporter=1").get()).author_id, null);
  // Closed is final.
  assert.equal((await call(`/admin/cases/${w.data.id}`, { status: "closed", outcome: "Audit found 14 loans; branch staff disciplined." }, vig.token, "PATCH")).status, 200);
  assert.equal((await call("/cases/follow/reply", { code: w.data.code, key: w.data.follow_key, body: "more" }, emp.token)).status, 409);
});
