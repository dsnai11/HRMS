import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { escalateOverdueTraining } from "../server/training-followup.js";

const PW = "Temporary-pass-123";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]).toString("base64");
const secrets = new Map();

async function world(t) {
  let nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const raw = (path, token) => fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64);
    const r = await call("/login", { email, password, native: true, device: { id, platform: "android", model: "T", secret: secrets.get(id) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (await call("/admin/workplaces", { name: "Office", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, workplace_id: site, date_of_joining: "2026-01-01", ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("mgr");
  await add("head");
  await add("emp", { manager_id: people.mgr.id });
  return { db, app, call, raw, owner, people, setNow: (iso) => (nowMs = Date.parse(iso)) };
}

// A course with one lesson and one quiz question, assigned to the employee.
async function course(w, title, extra = {}) {
  const { db, people } = w;
  const companyId = (await db.prepare("SELECT company_id FROM users WHERE id=?").get(people.emp.id)).company_id;
  const t = await db
    .prepare("INSERT INTO trainings(company_id,title,hours,mandatory,kind,pass_mark,max_attempts,created_at) VALUES(?,?,?,?,?,?,?,?) RETURNING id")
    .get(companyId, title, 2, extra.mandatory ?? 0, "course", 70, extra.max_attempts ?? 2, "2026-11-01T00:00:00.000Z");
  const lesson = await db.prepare("INSERT INTO training_lessons(training_id,position,title,kind,body) VALUES(?,?,?,?,?) RETURNING id").get(t.id, 1, "One", "text", "Read");
  await db.prepare("INSERT INTO training_questions(training_id,position,question,options,correct) VALUES(?,?,?,?,?)").run(t.id, 1, "Q", JSON.stringify(["A", "B"]), 0);
  const r = await db.prepare("INSERT INTO training_records(training_id,user_id,due_date) VALUES(?,?,?) RETURNING id").get(t.id, people.emp.id, extra.due ?? "2026-11-10");
  return { training: t.id, lesson: lesson.id, record: r.id };
}
const notes = (w, id) => w.db.prepare("SELECT title,body FROM notifications WHERE user_id=? AND kind='training' ORDER BY id").all(id);

test("HR designs the certificate; a certificate keeps the design it was issued under", async (t) => {
  const w = await world(t);
  const { call, raw, owner, people } = w;
  const hr = people.hr.token;

  const blank = await call("/admin/certificate-design", undefined, hr);
  assert.equal(blank.data.title, "Certificate of Completion");
  assert.equal(blank.data.style, "classic");
  assert.equal((await call("/admin/certificate-design", undefined, people.emp.token)).status, 403);

  const design = { title: "Certificate of Achievement", message: "has passed", style: "modern", color: "#0B5CAD", signatory_name: "A. Signer", signatory_title: "Head of HR" };
  assert.equal((await call("/admin/certificate-design", { ...design, color: "#ffee00" }, hr, "PUT")).status, 400);
  assert.equal((await call("/admin/certificate-design", { ...design, style: "gold" }, hr, "PUT")).status, 400);
  const bad = await call("/admin/certificate-design", { ...design, signature: { mime: "image/png", data: Buffer.from("not an image").toString("base64") } }, hr, "PUT");
  assert.equal(bad.status, 400);
  const saved = await call("/admin/certificate-design", { ...design, signature: { mime: "image/png", data: PNG } }, hr, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.ok(saved.data.signature_url);
  assert.equal(saved.data.seal_url, null);

  // Signature: signed-in staff only.
  assert.equal((await raw(saved.data.signature_url.replace("/api", ""))).status, 401);
  const img = await raw(saved.data.signature_url.replace("/api", ""), people.emp.token);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");

  const c = await course(w, "KYC basics");
  const emp = people.emp.token;
  await call(`/learning/${c.record}/lessons/${c.lesson}/done`, {}, emp);
  const pass = await call(`/learning/${c.record}/quiz`, { answers: [0] }, emp);
  assert.equal(pass.data.passed, true, JSON.stringify(pass.data));
  const mine = (await call("/certificates/mine", undefined, emp)).data;
  const first = (await call(`/certificates/${mine[0].id}`, undefined, emp)).data;
  assert.equal(first.certificate.title, "Certificate of Achievement");
  assert.equal(first.certificate.person, "EMP");
  assert.equal(first.certificate.signatory_name, "A. Signer");
  assert.equal(first.certificate.color, "#0b5cad");
  assert.ok(first.certificate.number.startsWith("LIFC-"));
  assert.ok(first.paragraphs.length, "the plain letter is still there for anything reading it");
  const byRecord = (await call(`/trainings/records/${c.record}/certificate`, undefined, emp)).data;
  assert.equal(byRecord.certificate.signatory_name, "A. Signer");

  // A new signatory, keeping the signature unless removed: the issued certificate does not change.
  const next = await call("/admin/certificate-design", { ...design, title: "New heading", signatory_name: "B. Next", signature: undefined }, hr, "PUT");
  assert.ok(next.data.signature_url, "image kept when not sent");
  assert.notEqual(next.data.signature_url, saved.data.signature_url);
  const again = (await call(`/certificates/${mine[0].id}`, undefined, emp)).data;
  assert.equal(again.certificate.signatory_name, "A. Signer");
  assert.equal(again.certificate.title, "Certificate of Achievement");
  const removed = await call("/admin/certificate-design", { ...design, signature: null }, hr, "PUT");
  assert.equal(removed.data.signature_url, null);
  assert.ok(owner);
});

test("late training climbs to the manager, HR and the department head, once each", async (t) => {
  const w = await world(t);
  const { db, app, call, people, setNow } = w;
  const dept = await db.prepare("INSERT INTO departments(company_id,name,head_id,created_at) SELECT company_id,'Credit',?,'2026-01-01' FROM users WHERE id=? RETURNING id").get(people.head.id, people.emp.id);
  await db.prepare("UPDATE users SET department_id=? WHERE id=?").run(dept.id, people.emp.id);
  const c = await course(w, "AML rules", { mandatory: 1 });
  const soft = await course(w, "Excel tips");

  assert.equal(await escalateOverdueTraining(app), 0);
  setNow("2026-11-11T10:00:00+05:30");
  assert.equal(await escalateOverdueTraining(app), 2);
  assert.equal(await escalateOverdueTraining(app), 0, "not repeated");
  let m = await notes(w, people.mgr.id);
  assert.equal(m.length, 1, "one message for both courses");
  assert.equal(m[0].title, "Overdue training: 2 to follow up");
  assert.match(m[0].body, /EMP: AML rules \(1 day late\)/);
  assert.equal((await notes(w, people.hr.id)).length, 0);

  setNow("2026-11-17T10:00:00+05:30");
  assert.equal(await escalateOverdueTraining(app), 2);
  assert.equal((await notes(w, people.mgr.id)).length, 2);
  assert.equal((await notes(w, people.hr.id)).length, 1);
  assert.equal((await notes(w, people.head.id)).length, 0);

  // Lists
  const list = (await call("/admin/learning-followup", undefined, people.hr.token)).data;
  assert.deepEqual(list.map((r) => r.title).sort(), ["AML rules", "Excel tips"]);
  assert.equal(list[0].days_late, 7);
  assert.equal(list[0].stage, "HR told");
  assert.equal((await call("/admin/learning-followup", undefined, people.emp.token)).status, 403);
  const team = (await call("/learning-team", undefined, people.mgr.token)).data;
  assert.equal(team.has_team, true);
  assert.equal(team.rows.length, 2);
  assert.deepEqual((await call("/learning-team", undefined, people.emp.token)).data, { has_team: false, rows: [] });

  // 15 days: only the mandatory course reaches the head, and it shows on reviews.
  setNow("2026-11-25T10:00:00+05:30");
  assert.equal(await escalateOverdueTraining(app), 1);
  const h = await notes(w, people.head.id);
  assert.equal(h.length, 1);
  assert.match(h[0].title, /EMP, AML rules/);
  assert.equal((await db.prepare("SELECT escalation_level l FROM training_records WHERE id=?").get(soft.record)).l, 2);
  await db.prepare("UPDATE users SET probation_end_date='2026-12-01' WHERE id=?").run(people.emp.id);
  const prob = (await call("/admin/probation", undefined, w.owner)).data.find((p) => p.user_id === people.emp.id);
  assert.deepEqual(prob.overdue_training, ["AML rules"]);
  assert.equal(await escalateOverdueTraining(app), 0);

  // Finished: off the list.
  await call(`/learning/${c.record}/lessons/${c.lesson}/done`, {}, people.emp.token);
  await call(`/learning/${c.record}/quiz`, { answers: [0] }, people.emp.token);
  const after = (await call("/admin/learning-followup", undefined, people.hr.token)).data;
  assert.deepEqual(after.map((r) => r.title), ["Excel tips"]);
});

test("a course that is very late on first sight tells everyone it should have, in one message each", async (t) => {
  const w = await world(t);
  await course(w, "Fraud basics", { mandatory: 1, due: "2026-10-01" });
  assert.equal(await escalateOverdueTraining(w.app), 1);
  assert.equal((await notes(w, w.people.mgr.id)).length, 1);
  // No department head: it goes to HR, who get one message and not two.
  assert.equal((await notes(w, w.people.hr.id)).length, 1);
});

test("using every quiz attempt tells the manager and HR, and HR can allow more", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const c = await course(w, "Policy test", { max_attempts: 2, due: "2026-12-30" });
  const emp = people.emp.token;
  await call(`/learning/${c.record}/lessons/${c.lesson}/done`, {}, emp);
  const one = await call(`/learning/${c.record}/quiz`, { answers: [1] }, emp);
  assert.equal(one.data.attempts_left, 1, JSON.stringify(one.data));
  assert.equal((await notes(w, people.mgr.id)).length, 0);
  await call(`/learning/${c.record}/quiz`, { answers: [1] }, emp);
  const m = await notes(w, people.mgr.id);
  assert.equal(m.length, 1);
  assert.match(m[0].title, /EMP has used all quiz attempts: Policy test/);
  assert.match(m[0].body, /Best score 0%, pass mark 70%/);
  assert.equal((await notes(w, people.hr.id)).length, 1);
  assert.equal((await notes(w, people.emp.id)).length, 0);

  const list = (await call("/admin/learning-followup", undefined, people.hr.token)).data;
  assert.equal(list[0].out_of_attempts, true);
  assert.equal(list[0].days_late, 0);
  assert.equal((await call(`/admin/trainings/records/${list[0].id}/reset`, {}, people.hr.token)).status, 200);
  assert.deepEqual((await call("/admin/learning-followup", undefined, people.hr.token)).data, []);
  const pass = await call(`/learning/${c.record}/quiz`, { answers: [0] }, emp);
  assert.equal(pass.data.passed, true);
});
