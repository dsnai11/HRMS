import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

// Overtime comes from the punches (after the full-day finish, default 18:30), is claimed up
// to that, approved in full or part by the manager, and paid once through payroll.
test("overtime: claimed from punches, approved by the manager, paid once in payroll", async (t) => {
  let nowMs = Date.parse("2026-10-05T09:30:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, headers = {}, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const person = async (name, extra = {}) => {
    const id = (await call("/admin/employees", { name, email: `${name}@example.test`, password: "Temporary-pass-123", workplace_id: site, ...extra }, owner)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const device = { id: `${name}-device-0000001`, platform: "android", model: "Pixel" };
    const reg = await call("/login", { email: `${name}@example.test`, password: "Temporary-pass-123", native: true, device });
    const row = (await call("/admin/devices", undefined, owner)).data.find((d) => d.user_id === id);
    await call(`/admin/devices/${row.id}`, { status: "approved" }, owner, {}, "PATCH");
    return { id, token: reg.data.token, headers: { "X-Device-Id": device.id, "X-Device-Secret": reg.data.deviceSecret } };
  };
  const boss = await person("boss");
  const emp = await person("emp", { manager_id: boss.id });
  const punch = (who, action, local) => {
    nowMs = Date.parse(local);
    return call("/punch", { action, location: { latitude: 26.9124, longitude: 75.7873, accuracy: 10, timestamp: nowMs }, signals: {} }, who.token, who.headers);
  };
  const claim = (body) => call("/overtime", body, emp.token, emp.headers);

  // Monday: 09:30 to 20:15 is 105 minutes after 18:30. Tuesday: out at 18:40, only 10.
  assert.equal((await punch(emp, "in", "2026-10-05T09:30:00+05:30")).status, 200);
  assert.equal((await punch(emp, "out", "2026-10-05T20:15:00+05:30")).status, 200);
  assert.equal((await punch(emp, "in", "2026-10-06T09:28:00+05:30")).status, 200);
  assert.equal((await punch(emp, "out", "2026-10-06T18:40:00+05:30")).status, 200);
  nowMs = Date.parse("2026-10-07T10:00:00+05:30");

  assert.equal((await claim({ date: "2026-10-05", reason: "Month-end collections" })).status, 409, "off until HR switches it on");
  assert.equal((await call("/admin/overtime-settings", { ot_enabled: true, ot_min_minutes: 10, ot_max_minutes: 5 }, owner, {}, "PATCH")).status, 400);
  assert.equal((await call("/admin/overtime-settings", { ot_enabled: true }, owner, {}, "PATCH")).status, 200);
  const mine = (await call("/overtime", undefined, emp.token, emp.headers)).data;
  assert.deepEqual(mine.suggestions.map((s) => [s.date, s.minutes]), [["2026-10-05", 105]]);

  assert.equal((await claim({ date: "2026-10-07", reason: "x" })).status, 400, "only finished days");
  assert.equal((await claim({ date: "2026-10-06", reason: "x" })).status, 422, "10 minutes is under the 30-minute minimum");
  assert.equal((await claim({ date: "2026-10-05", minutes: 150, reason: "x" })).status, 422, "no more than the punches show");
  assert.equal((await claim({ date: "2026-10-05", minutes: 20, reason: "x" })).status, 422);
  const c = await claim({ date: "2026-10-05", minutes: 90, reason: "Month-end collections" });
  assert.equal(c.status, 201, JSON.stringify(c.data));
  assert.equal((await claim({ date: "2026-10-05", minutes: 60, reason: "again" })).status, 409, "one claim a day");

  // The manager sees it, approves part of it; the employee cannot decide.
  const pending = (await call("/overtime/pending", undefined, boss.token, boss.headers)).data;
  assert.deepEqual(pending.map((p) => [p.employee_name, p.minutes_claimed]), [["emp", 90]]);
  assert.equal((await call(`/overtime/${c.data.id}/decision`, { decision: "approved" }, emp.token, emp.headers)).status, 403);
  assert.equal((await call(`/overtime/${c.data.id}/decision`, { decision: "approved", minutes: 120 }, boss.token, boss.headers)).status, 400);
  assert.equal((await call(`/overtime/${c.data.id}/decision`, { decision: "approved", minutes: 60 }, boss.token, boss.headers)).data.minutes, 60);
  assert.equal((await call(`/overtime/${c.data.id}/cancel`, {}, emp.token, emp.headers)).status, 409);

  // Payroll pays it: basic 15,000 / (26 x 8) = 72.12 an hour, x2, for 1 hour = 144.
  await db.prepare("INSERT INTO employee_salaries(company_id,user_id,effective_from,monthly_gross,created_at) VALUES(1,?,?,?,?)").run(emp.id, "2026-01-01", 30000, new Date().toISOString());
  const sal = (await db.prepare("SELECT id FROM employee_salaries WHERE user_id=?").get(emp.id)).id;
  for (const [code, amount, basic] of [["BASIC", 15000, 1], ["HRA", 6000, 0], ["SPL", 9000, 0]])
    await db.prepare("INSERT INTO employee_salary_lines(salary_id,code,name,amount,is_basic,taxable,esi_wage) VALUES(?,?,?,?,?,1,1)").run(sal, code, code, amount, basic);
  nowMs = Date.parse("2026-11-02T10:00:00+05:30");
  const run = await call("/admin/payroll/runs", { month: "2026-10" }, owner);
  assert.equal(run.status, 201, JSON.stringify(run.data));
  const item = (await call(`/admin/payroll/runs/${run.data.id}/items/${emp.id}`, undefined, owner)).data;
  const ot = (item.data?.earnings ?? item.earnings).find((e) => e.name.startsWith("Overtime"));
  assert.deepEqual([ot.name, ot.amount], ["Overtime (1h 00m)", 144]);
  const ap = await call(`/admin/payroll/runs/${run.data.id}/approve`, {}, owner);
  assert.equal(ap.status, 200, JSON.stringify(ap.data));
  assert.equal((await db.prepare("SELECT paid_run_id FROM overtime_requests WHERE id=?").get(c.data.id)).paid_run_id, run.data.id);
  // The next month's run does not pay it again.
  nowMs = Date.parse("2026-12-02T10:00:00+05:30");
  const next = (await call("/admin/payroll/runs", { month: "2026-11" }, owner)).data.id;
  const again = (await call(`/admin/payroll/runs/${next}/items/${emp.id}`, undefined, owner)).data;
  assert.ok(!(again.data?.earnings ?? again.earnings).some((e) => e.name.startsWith("Overtime")));
});
