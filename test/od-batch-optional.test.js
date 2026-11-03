import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  let nowMs = Date.parse("2026-11-10T11:00:00+05:30");
  const prevKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((resolve) => {
        if (prevKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
        else process.env.DATA_ENCRYPTION_KEY = prevKey;
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
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(phones.get(token) ?? {}),
      },
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
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const add = async (key, extra = {}) => {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, workplace_id: site, date_of_joining: "2026-01-01", ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return { id: r.data.id, token: await login(`${key}@example.test`) };
  };
  const boss = await add("boss");
  const emp = await add("emp", { manager_id: boss.id });
  const other = await add("other", { manager_id: boss.id });
  await db.prepare("UPDATE companies SET attendance_start_date='2026-10-01'").run();
  return { db, call, owner, boss, emp, other, setNow: (iso) => (nowMs = Date.parse(iso)) };
}

test("short leave counts the day in full once approved", async (t) => {
  const { db, call, boss, emp } = await world(t);
  assert.equal((await call("/regularizations", { kind: "short_leave", date: "2026-11-10", reason: "Bank visit" }, emp.token)).status, 400);
  const r = await call("/regularizations", { kind: "short_leave", date: "2026-11-10", in_time: "11:30", out_time: "18:30", reason: "Bank visit" }, emp.token);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await call(`/regularizations/${r.data.id}/decision`, { decision: "approved" }, boss.token)).status, 200);
  const shift = await db.prepare("SELECT s.* FROM shifts s JOIN regularizations r ON r.shift_id=s.id WHERE r.id=?").get(r.data.id);
  assert.deepEqual([shift.source, shift.day_type], ["short_leave", "full_day"]);
});

test("Multiple OD asks for each working day in the range, one message to the approver", async (t) => {
  const { db, call, boss, emp } = await world(t);
  assert.equal((await call("/regularizations/batch", { from_date: "2026-11-09", to_date: "2026-11-06", reason: "Tour" }, emp.token)).status, 400);
  assert.equal((await call("/regularizations/batch", { from_date: "2026-11-01", to_date: "2026-12-15", reason: "Tour" }, emp.token)).status, 400);
  // Friday to Monday: Sunday the 8th is the weekly off.
  const r = await call("/regularizations/batch", { from_date: "2026-11-06", to_date: "2026-11-09", reason: "Branch audit, Kota" }, emp.token);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.deepEqual(r.data.days, ["2026-11-06", "2026-11-07", "2026-11-09"]);
  assert.equal(r.data.skipped, 1);
  const mine = (await call("/regularizations", undefined, emp.token)).data.filter((x) => x.batch_id === r.data.batch_id);
  assert.equal(mine.length, 3);
  assert.ok(mine.every((x) => x.kind === "on_duty" && x.status === "pending"));
  const told = await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND title LIKE '%OD on 3 days%'").get(boss.id);
  assert.equal(Number(told.n), 1);
  // The same days cannot be asked for again while they wait.
  assert.equal((await call("/regularizations/batch", { from_date: "2026-11-06", to_date: "2026-11-07", reason: "Again" }, emp.token)).status, 409);
  // Planned ahead is allowed, up to 30 days.
  const ahead = await call("/regularizations/batch", { from_date: "2026-11-16", to_date: "2026-11-17", reason: "Collections camp" }, emp.token);
  assert.equal(ahead.status, 201, JSON.stringify(ahead.data));
  for (const x of mine) assert.equal((await call(`/regularizations/${x.id}/decision`, { decision: "approved" }, boss.token)).status, 200);
  const cal = (await call("/attendance/calendar?month=2026-11", undefined, emp.token)).data;
  const day = (d) => cal.days.find((x) => x.date === d);
  assert.deepEqual([day("2026-11-06").present, day("2026-11-06").source], [1, "on_duty"]);
  assert.equal(day("2026-11-08").status, "weekly_off");
});

test("optional holidays: choose within the limit, approved by the manager, a holiday for that person only", async (t) => {
  const { call, owner, boss, emp, other, setNow } = await world(t);
  assert.equal((await call("/admin/holidays", { items: [{ date: "2026-11-20", name: "Guru Nanak Jayanti" }, { date: "2026-11-25", name: "Choice day" }], optional: true }, owner)).status, 201);
  let s = (await call("/optional-holidays?year=2026", undefined, emp.token)).data;
  assert.equal(s.limit, 1);
  assert.equal(s.holidays.length, 2);
  assert.equal((await call("/optional-holidays", { year: 2026, dates: ["2026-11-20", "2026-11-25"] }, emp.token, "PUT")).status, 422);
  assert.equal((await call("/optional-holidays", { year: 2026, dates: ["2026-11-21"] }, emp.token, "PUT")).status, 400);
  s = (await call("/optional-holidays", { year: 2026, dates: ["2026-11-20"] }, emp.token, "PUT")).data;
  assert.deepEqual([s.counts.applied, s.counts.remaining], [1, 0]);
  // Changing the pick withdraws the pending one.
  s = (await call("/optional-holidays", { year: 2026, dates: ["2026-11-25"] }, emp.token, "PUT")).data;
  assert.deepEqual(s.holidays.map((h) => h.choice?.status ?? null), [null, "pending"]);
  s = (await call("/optional-holidays", { year: 2026, dates: ["2026-11-20"] }, emp.token, "PUT")).data;
  const inbox = (await call("/optional-holidays/inbox", undefined, boss.token)).data;
  assert.equal(inbox.length, 1);
  assert.equal((await call("/optional-holidays/inbox", undefined, other.token)).data.length, 0);
  assert.equal((await call(`/optional-holidays/${inbox[0].id}/decision`, { decision: "approved" }, other.token)).status, 403);
  assert.ok((await call("/me", undefined, boss.token)).data.approvals_pending >= 1);
  assert.equal((await call(`/optional-holidays/${inbox[0].id}/decision`, { decision: "approved" }, boss.token)).status, 200);
  s = (await call("/optional-holidays?year=2026", undefined, emp.token)).data;
  assert.equal(s.counts.approved, 1);
  // After the day: a holiday for the person who chose it, a working day for others.
  setNow("2026-11-21T10:00:00+05:30");
  const mine = (await call("/attendance/calendar?month=2026-11", undefined, emp.token)).data.days.find((d) => d.date === "2026-11-20");
  const theirs = (await call("/attendance/calendar?month=2026-11", undefined, other.token)).data.days.find((d) => d.date === "2026-11-20");
  assert.equal(mine.status, "holiday");
  assert.equal(theirs.status, "absent");
  // HR sets the yearly limit.
  assert.equal((await call("/admin/optional-holiday-limit", { limit: 2 }, owner, "PUT")).status, 200);
  assert.equal((await call("/optional-holidays?year=2026", undefined, emp.token)).data.counts.remaining, 1);
});

test("Form 16 can be matched to the employee by the PAN in the file name", async (t) => {
  const { call, owner, emp } = await world(t);
  const saved = await call(`/admin/employees/${emp.id}/private`, { pan: "ABCDE1234F" }, owner, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  const r = await call("/admin/form16", { fy: "2025-26", pan: "abcde1234f", mime: "application/pdf", data: pdf }, owner);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.employee, "EMP");
  assert.equal((await call("/admin/form16", { fy: "2025-26", pan: "ZZZZZ9999Z", mime: "application/pdf", data: pdf }, owner)).status, 404);
  assert.equal((await call("/form16", undefined, emp.token)).data.length, 1);
});
