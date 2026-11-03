import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

test("resignation: reason and handover, manager and HR told, accepted, interview, withdrawal request", async (t) => {
  const nowMs = Date.parse("2026-11-03T11:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const phones = new Map();
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(phones.get(token) ?? {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const login = async (email, password = PW) => {
    const device = { id: `phone-${email.replace(/[^a-z]/g, "")}`.padEnd(16, "0"), platform: "android", model: "T" };
    const r = (await call("/login", { email, password, native: true, device })).data;
    if (r.deviceSecret) phones.set(r.token, { "X-Device-Id": device.id, "X-Device-Secret": r.deviceSecret });
    return r.token;
  };
  const owner = await login("owner@example.test", "Owner-password-123");
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const add = async (key, extra = {}) => {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, workplace_id: site, date_of_joining: "2024-01-01", ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return { id: r.data.id, token: await login(`${key}@example.test`) };
  };
  const hr = await add("hr", { role: "hr" });
  const boss = await add("boss");
  const mate = await add("mate", { manager_id: boss.id });
  const emp = await add("emp", { manager_id: boss.id });

  const form = (await call("/exit/mine", undefined, emp.token)).data;
  assert.equal(form.exit, null);
  assert.ok(form.reasons.better_opportunity);
  assert.equal((await call("/exit/resign", { reason_category: "nope", reason: "x" }, emp.token)).status, 400);
  const r = await call(
    "/exit/resign",
    {
      reason_category: "higher_studies",
      reason: "Starting an MBA in January.",
      requested_last_day: "2026-11-20",
      personal_email: "emp.home@example.test",
      personal_phone: "98290 11111",
      handover_to: mate.id,
      handover_notes: "Branch audit files are in the shared drive.",
    },
    emp.token,
  );
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.early_release, true, "the last day is before the notice period ends");
  const told = async (id) => (await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND kind='exit'").get(id)).n;
  assert.equal(Number(await told(boss.id)), 1);
  assert.equal(Number(await told(hr.id)), 1);

  // The manager's view, then HR accepts with the asked-for last day.
  assert.equal((await call(`/team/resignations/${r.data.id}/review`, { view: "accept", last_day: "2026-11-20" }, boss.token)).status, 200);
  assert.equal((await call(`/admin/exits/${r.data.id}/decide`, { decision: "accepted", last_working_day: "2026-11-20" }, hr.token)).status, 200);
  let mine = (await call("/exit/mine", undefined, emp.token)).data;
  assert.equal(mine.exit.status, "accepted");
  assert.equal(mine.days_left, 17);
  assert.ok(mine.shortfall > 0, "notice not fully served");
  assert.ok(mine.clearance.length >= 6);
  assert.equal(mine.exit.handover_name, "MATE");

  // Exit interview by the employee clears the interview item.
  assert.equal((await call("/exit/interview", { ratings: { role: 4 }, answers: { main_reason: "Studies" } }, emp.token)).status, 400);
  assert.equal(
    (await call("/exit/interview", { ratings: { role: 4, manager: 5, pay: 3 }, answers: { main_reason: "Studies", liked: "The team" }, would_rejoin: true }, emp.token)).status,
    201,
  );
  mine = (await call("/exit/mine", undefined, emp.token)).data;
  assert.equal(mine.interview.ratings.manager, 5);
  assert.equal(mine.clearance.find((c) => c.item === "Conduct the exit interview").cleared, 1);
  const hrView = (await call(`/admin/exits/${r.data.id}`, undefined, hr.token)).data;
  assert.equal(hrView.reason_label, "Higher studies");
  assert.equal(hrView.interview.answers.liked, "The team");

  // After acceptance the employee asks to withdraw; HR declines, then approves a second ask.
  assert.equal((await call("/exit/withdraw", {}, emp.token)).status, 400);
  assert.equal((await call("/exit/withdraw", { reason: "The MBA start moved to next year." }, emp.token)).data.status, "withdrawal_requested");
  assert.equal((await call("/exit/withdraw", { reason: "again" }, emp.token)).status, 409);
  assert.equal((await call(`/admin/exits/${r.data.id}/withdrawal`, { decision: "declined" }, hr.token)).status, 400);
  assert.equal((await call(`/admin/exits/${r.data.id}/withdrawal`, { decision: "declined", note: "Replacement already hired" }, hr.token)).status, 200);
  assert.equal((await call("/exit/withdraw", { reason: "Please reconsider" }, emp.token)).status, 200);
  assert.equal((await call(`/admin/exits/${r.data.id}/withdrawal`, { decision: "approved" }, hr.token)).status, 200);
  assert.equal((await call("/exit/mine", undefined, emp.token)).data.exit.status, "withdrawn");
});
