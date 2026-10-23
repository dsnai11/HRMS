import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  let nowMs = Date.parse("2026-11-02T10:00:00+05:30");
  const { server, app } = createApp({ db, clock: () => nowMs });
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
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  // Phone-style sign-in, as in the other tests.
  const signIn = async (email, password = PW) => {
    const r = await call("/login", { email, password, native: true, device: { id: `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64), platform: "android", model: "T" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, ...extra },
      owner,
    );
    if (r.status !== 201) return r;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  return { db, call, owner, add, app, tick: (h) => (nowMs += h * 3600000) };
}

import { sendApprovalReminders } from "../server/approval-chain.js";
import { sendScheduledReports } from "../server/scheduled-reports.js";

test("leave passes through a multi-level chain, with reminders and escalation", async (t) => {
  const { db, call, owner, add, app, tick } = await world(t);
  const head = await add("head");
  const mgr = await add("mgr", { manager_id: head.id });
  const hr = await add("hr", { role: "hr" });
  const emp = await add("emp", { manager_id: mgr.id });
  await call("/admin/leave-types/seed-defaults", {}, owner);

  assert.equal((await call("/admin/leave-settings", { leave_chain: ["manager", "bogus"] }, owner, "PATCH")).status, 400);
  const set = await call("/admin/leave-settings", { leave_chain: ["manager", "skip_manager", "hr"], approval_reminder_hours: 24, approval_escalate_hours: 48 }, owner, "PATCH");
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.deepEqual(set.data.leave_chain, ["manager", "skip_manager", "hr"]);

  const lwp = (await call("/leave/balances", undefined, emp.token)).data.find((x) => x.unlimited);
  const req = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: "2026-11-20", to_date: "2026-11-20" }, emp.token);
  assert.equal(req.status, 201, JSON.stringify(req.data));
  const decide = (who) => call(`/leave/requests/${req.data.id}/decision`, { decision: "approved" }, who.token);
  const inbox = async (who) => (await call("/approvals", undefined, who.token)).data.leave.map((r) => [r.id, r.step_name]);

  // Step 1: the manager. The head of department cannot act yet.
  assert.deepEqual(await inbox(mgr), [[req.data.id, "Reporting manager"]]);
  assert.deepEqual(await inbox(head), []);
  assert.equal((await decide(head)).status, 403);
  assert.equal((await decide(mgr)).data.step, "skip_manager");
  // Step 2: the manager's manager.
  assert.deepEqual(await inbox(head), [[req.data.id, "Manager's manager"]]);
  assert.deepEqual(await inbox(mgr), []);
  assert.equal((await decide(head)).data.step, "hr");
  let mine = (await call("/leave/requests", undefined, emp.token)).data[0];
  assert.equal(mine.status, "pending");
  assert.equal(JSON.parse(mine.approvals).length, 2);

  // Waiting at HR: a reminder after a day, escalation after two.
  tick(25);
  assert.deepEqual(await sendApprovalReminders(app), { reminded: 1, escalated: 0 });
  assert.deepEqual(await sendApprovalReminders(app), { reminded: 0, escalated: 0 });
  tick(24);
  assert.deepEqual(await sendApprovalReminders(app), { reminded: 0, escalated: 1 });
  const notes = await db.prepare("SELECT title FROM notifications WHERE user_id=? ORDER BY id").all(hr.id);
  assert.ok(notes.some((n) => n.title.startsWith("Reminder:")));
  assert.ok(notes.some((n) => n.title.startsWith("Escalated:")));

  // Step 3: HR finishes it.
  assert.equal((await decide(hr)).status, 200);
  mine = (await call("/leave/requests", undefined, emp.token)).data[0];
  assert.equal(mine.status, "approved");

  // Someone with no manager's manager skips that step.
  const solo = await add("solo", { manager_id: head.id });
  const r2 = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: "2026-11-23", to_date: "2026-11-23" }, solo.token);
  const d2 = await call(`/leave/requests/${r2.data.id}/decision`, { decision: "approved" }, head.token);
  assert.equal(d2.data.step, "hr");
  // A rejection at any step is final.
  const r3 = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: "2026-11-24", to_date: "2026-11-24" }, emp.token);
  assert.equal((await call(`/leave/requests/${r3.data.id}/decision`, { decision: "rejected" }, mgr.token)).status, 200);
  assert.equal((await call("/leave/requests", undefined, emp.token)).data.find((r) => r.id === r3.data.id).status, "rejected");
});

test("command centre figures and scheduled report emails", async (t) => {
  const { db, call, owner, add, app, tick } = await world(t);
  const hr = await add("hr", { role: "hr", gender: "female", date_of_birth: "1990-05-01", date_of_joining: "2020-01-01" });
  await add("new", { gender: "male", date_of_joining: "2026-11-01" });

  const d = (await call("/admin/insights", undefined, owner)).data;
  assert.equal(d.this_month.month, "2026-11");
  assert.equal(d.this_month.joined, 1);
  assert.ok(d.demographics.gender.some((g) => g.name === "Female" && g.n === 1));
  assert.ok(d.demographics.age.some((g) => g.name === "35–44"));
  assert.ok(d.demographics.tenure.some((g) => g.name === "5–9 years"));

  // Weekly on Monday (2 Nov 2026 is a Monday), to HR.
  assert.equal((await call("/admin/report-schedules", { report: "nope", frequency: "weekly" }, owner)).status, 400);
  const s = await call("/admin/report-schedules", { report: "command_centre", frequency: "weekly", day: 1, recipients: [hr.id] }, owner);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal((await call("/admin/report-schedules", undefined, hr.token)).data.items.length, 1);
  assert.equal(await sendScheduledReports(app), 1);
  assert.equal(await sendScheduledReports(app), 0, "once a day");
  const note = await db.prepare("SELECT title,body FROM notifications WHERE user_id=? AND kind='report'").get(hr.id);
  assert.match(note.title, /^HR Command Centre, 2026-11-02/);
  assert.match(note.body, /Headcount: 2/); // hr and new; the owner is not staff
  tick(24); // Tuesday: not due
  assert.equal(await sendScheduledReports(app), 0);
  assert.equal((await call(`/admin/report-schedules/${s.data.id}`, undefined, owner, "DELETE")).status, 200);
});
