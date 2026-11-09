import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, clock: () => Date.parse("2026-11-05T10:00:00+05:30") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64);
    const r = await call("/login", { email, password, native: true, device: { id, platform: "android", model: "T" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
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
  await add("mgr");
  await add("emp", { manager_id: people.mgr.id });
  await add("other");
  return { db, call, people };
}

test("a supervisor sees what they approved and rejected, and nobody else's decisions", async (t) => {
  const { db, call, people } = await world(t);
  const company = (await db.prepare("SELECT company_id c FROM users WHERE id=?").get(people.emp.id)).c;
  const fix = (date, reason) =>
    db
      .prepare("INSERT INTO regularizations(company_id,user_id,date,kind,reason,status,created_at) VALUES(?,?,?,'on_duty',?,'pending','2026-11-01T00:00:00.000Z') RETURNING id")
      .get(company, people.emp.id, date, reason);
  const a = await fix("2026-11-02", "Client visit");
  await db.prepare("UPDATE regularizations SET status='approved',decided_by=?,decided_at='2026-11-03T00:00:00.000Z' WHERE id=?").run(people.mgr.id, a.id);
  const b = await fix("2026-11-03", "Audit visit");
  await db.prepare("UPDATE regularizations SET status='rejected',decided_by=?,decided_at='2026-11-03T00:00:00.000Z' WHERE id=?").run(people.mgr.id, b.id);

  const approved = await call("/approvals/decided?status=approved", undefined, people.mgr.token);
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.deepEqual(approved.data.regularizations.map((r) => r.reason), ["Client visit"]);
  assert.deepEqual(approved.data.leave, []);
  assert.deepEqual(approved.data.od, []);
  const rejected = await call("/approvals/decided?status=rejected", undefined, people.mgr.token);
  assert.deepEqual(rejected.data.regularizations.map((r) => r.employee_name), ["EMP"]);
  assert.equal((await call("/approvals/decided?status=approved", undefined, people.other.token)).data.regularizations.length, 0);
  assert.equal((await call("/approvals/decided?status=nonsense", undefined, people.mgr.token)).status, 400);
});

test("the directory gives a headcount and filter choices, and filters by branch", async (t) => {
  const { db, call, people } = await world(t);
  const company = (await db.prepare("SELECT company_id c FROM users WHERE id=?").get(people.emp.id)).c;
  const branch = await db.prepare("INSERT INTO branches(company_id,name,created_at) VALUES(?,'Kota','2026-01-01') RETURNING id").get(company);
  await db.prepare("UPDATE users SET branch_id=? WHERE id=?").run(branch.id, people.emp.id);
  const s = await call("/directory/summary", undefined, people.other.token);
  assert.equal(s.status, 200, JSON.stringify(s.data));
  assert.equal(s.data.total, 3);
  assert.deepEqual(s.data.branches.map((b) => b.name), ["Kota"]);
  const filtered = await call(`/directory?q=&branch_id=${branch.id}`, undefined, people.other.token);
  assert.deepEqual(filtered.data.map((p) => p.name), ["EMP"]);
});
