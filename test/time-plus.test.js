import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  let nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
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
  const call = async (path, body, token, method = "POST") => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
    };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
      .padEnd(16, "0")
      .slice(0, 64);
    const r = await call("/login", {
      email,
      password,
      native: true,
      device: { id, platform: "android", model: "T", secret: secrets.get(id) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (
    await call(
      "/admin/workplaces",
      {
        name: "Office",
        latitude: 26.9,
        longitude: 75.8,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email: `${key}@example.test`,
        password: PW,
        workplace_id: site,
        date_of_joining: "2026-01-01",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("pay", { role: "payroll" });
  await add("mgr");
  await add("emp");
  return {
    db,
    call,
    owner,
    people,
    site,
    add,
    signIn,
    app,
    setNow: (iso) => (nowMs = Date.parse(iso)),
  };
}

const IST = (s) => new Date(Date.parse(`${s}+05:30`)).toISOString();
async function worked(db, w, key, date, dayType = "full_day") {
  await db
    .prepare(
      "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,day_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      w.people[key].id,
      w.site,
      "Office",
      26.9,
      75.8,
      150,
      50,
      IST(`${date}T09:30:00`),
      26.9,
      75.8,
      10,
      IST(`${date}T18:30:00`),
      dayType,
    );
}

test("shift templates and department assignment", async (t) => {
  const w = await world(t);
  const { call, people, db, app } = w;
  const hr = people.hr.token;
  assert.equal(
    (await call("/admin/shift-policies/seed-templates", {}, people.emp.token))
      .status,
    403,
  );
  assert.equal(
    (await call("/admin/shift-policies/seed-templates", {}, hr)).data.added,
    5,
  );
  assert.equal(
    (await call("/admin/shift-policies/seed-templates", {}, hr)).data.added,
    0,
  );
  const list = (await call("/admin/shift-policies", undefined, hr)).data;
  assert.deepEqual(list.map((p) => p.kind).sort(), [
    "fixed",
    "flexible",
    "night",
    "rotational",
    "rotational",
  ]);
  const night = list.find((p) => p.kind === "night");
  const flex = list.find((p) => p.kind === "flexible");
  assert.equal(
    (
      await call(
        "/admin/shift-policies",
        {
          name: "Odd",
          start_time: "09:00",
          earliest_out: "18:00",
          kind: "weird",
        },
        hr,
      )
    ).status,
    400,
  );
  // Department beats branch and company, a person beats the department, a roster day beats everyone.
  const dept = (await call("/admin/departments", { name: "Collections" }, hr))
    .data.id;
  await db
    .prepare("UPDATE users SET department_id=? WHERE id IN (?,?)")
    .run(dept, people.emp.id, people.mgr.id);
  assert.equal(
    (
      await call(
        "/admin/shift-policies/assign",
        { target: "company", policy_id: flex.id },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/shift-policies/assign",
        { target: "department", id: dept, policy_id: night.id },
        hr,
      )
    ).status,
    200,
  );
  const user = (k) =>
    db.prepare("SELECT * FROM users WHERE id=?").get(people[k].id);
  assert.equal(
    (await app.policyFor(await user("emp"), "2026-11-05")).startMinutes,
    22 * 60,
  );
  assert.equal(
    (await app.policyFor(await user("pay"), "2026-11-05")).startMinutes,
    10 * 60,
  );
  const fixed = list.find((p) => p.kind === "fixed");
  await call(
    "/admin/shift-policies/assign",
    { target: "employee", id: people.mgr.id, policy_id: fixed.id },
    hr,
  );
  assert.equal(
    (await app.policyFor(await user("mgr"), "2026-11-05")).startMinutes,
    9 * 60 + 30,
  );
  assert.equal(
    (await call("/admin/shift-policies", undefined, hr)).data.find(
      (p) => p.id === night.id,
    ).departments,
    1,
  );
  // A night shift needs the full nine hours: punch in 22:00, earliest out is 07:00 the next day.
  const { evaluatePunchIn } = await import("../server/policy.js");
  const rules = await app.policyFor(await user("emp"), "2026-11-05");
  const r = evaluatePunchIn(
    rules,
    Date.parse("2026-11-05T22:00:00+05:30"),
    "Asia/Kolkata",
  );
  assert.equal(r.late, false);
  assert.equal(
    new Date(r.requiredOutAt).toISOString(),
    new Date(Date.parse("2026-11-06T07:00:00+05:30")).toISOString(),
  );
});

test("comp-off: claim on a day off, approval, balance, expiry; and the team leave calendar", async (t) => {
  const w = await world(t);
  const { call, people, db, app, setNow } = w;
  const hr = people.hr.token;
  await db
    .prepare("UPDATE users SET manager_id=? WHERE id=?")
    .run(people.mgr.id, people.emp.id);
  // Sundays are off by default. 2026-11-01 and 2026-10-25 are Sundays; 2026-11-02 is a Monday.
  await worked(db, w, "emp", "2026-11-01");
  await worked(db, w, "emp", "2026-11-02");
  await worked(db, w, "emp", "2026-10-25", "half_day");
  await worked(db, w, "emp", "2026-10-04");
  const claim = (body, token = people.emp.token) =>
    call("/comp-off", body, token);
  assert.equal(
    (await claim({ worked_on: "2026-11-02", days: 1, reason: "Month end" }))
      .status,
    409,
  );
  assert.equal(
    (await claim({ worked_on: "2026-11-08", days: 1, reason: "x" })).status,
    400,
  );
  assert.equal(
    (await claim({ worked_on: "2026-10-04", days: 1, reason: "Old" })).status,
    400,
  );
  assert.equal(
    (await claim({ worked_on: "2026-11-01", days: 0.7, reason: "x" })).status,
    400,
  );
  assert.equal(
    (
      await claim(
        { worked_on: "2026-11-01", days: 1, reason: "Audit work" },
        people.mgr.token,
      )
    ).status,
    409,
  ); // mgr has no attendance
  assert.equal(
    (await claim({ worked_on: "2026-10-25", days: 1, reason: "Half" })).status,
    409,
  );
  const half = await claim({
    worked_on: "2026-10-25",
    days: 0.5,
    reason: "Half day on Sunday",
  });
  assert.equal(half.status, 201, JSON.stringify(half.data));
  const full = await claim({
    worked_on: "2026-11-01",
    days: 1,
    reason: "Audit work",
  });
  assert.equal(full.status, 201);
  assert.equal(
    (await claim({ worked_on: "2026-11-01", days: 1, reason: "again" })).status,
    409,
  );

  // The manager decides, a stranger cannot, and approvals are counted.
  assert.equal(
    (await call("/comp-off/pending", undefined, people.mgr.token)).data.length,
    2,
  );
  assert.deepEqual(
    (await call("/comp-off/pending", undefined, people.pay.token)).data,
    [],
  );
  assert.ok(
    (await call("/me", undefined, people.mgr.token)).data.approvals_pending >=
      2,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${full.data.id}/decision`,
        { decision: "approved" },
        people.pay.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${full.data.id}/decision`,
        { decision: "rejected" },
        people.mgr.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${full.data.id}/decision`,
        { decision: "approved" },
        people.emp.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${full.data.id}/decision`,
        { decision: "approved" },
        people.mgr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${half.data.id}/decision`,
        { decision: "approved" },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/comp-off/${full.data.id}/decision`,
        { decision: "approved" },
        hr,
      )
    ).status,
    409,
  );
  const mine = (await call("/comp-off/mine", undefined, people.emp.token)).data;
  assert.equal(mine.balance, 1.5);
  assert.equal(mine.credits.length, 2);
  assert.equal(
    mine.credits.find((c) => c.id === full.data.id).valid_until,
    "2027-01-04",
  );
  const bal = (
    await call("/leave/balances", undefined, people.emp.token)
  ).data.find((b) => b.code === "CO");
  assert.equal(bal.balance, 1.5);
  // Cancelling is only for pending claims.
  await worked(db, w, "emp", "2026-10-18");
  const extra = await claim({
    worked_on: "2026-10-18",
    days: 1,
    reason: "Another Sunday",
  });
  assert.equal(
    (await call(`/comp-off/${extra.data.id}/cancel`, {}, people.mgr.token))
      .status,
    409,
  );
  assert.equal(
    (await call(`/comp-off/${extra.data.id}/cancel`, {}, people.emp.token))
      .status,
    200,
  );
  assert.equal(
    (await call(`/comp-off/${full.data.id}/cancel`, {}, people.emp.token))
      .status,
    409,
  );

  // Unused comp-off expires after the validity period but never below zero.
  assert.equal(
    (await call("/admin/comp-off/settings", { valid_days: 3 }, hr, "PUT"))
      .status,
    400,
  );
  const co = (await call("/admin/leave-types", undefined, hr)).data.find(
    (x) => x.code === "CO",
  );
  await call(
    "/admin/leave/adjust",
    {
      user_id: people.emp.id,
      leave_type_id: co.id,
      days: -1,
      note: "Used for a day off",
    },
    hr,
  );
  setNow("2027-01-20T10:00:00+05:30");
  const { expireCompOffs } = await import("../server/routes/compoff.js");
  assert.equal(await expireCompOffs(app), 2);
  assert.equal(
    (await call("/comp-off/mine", undefined, people.emp.token)).data.balance,
    0,
  );
  assert.equal(await expireCompOffs(app), 0);
  const expired = (await call("/admin/comp-off", undefined, hr)).data.filter(
    (c) => c.status === "approved",
  );
  assert.equal(
    expired.reduce((a, c) => a + c.expired_days, 0),
    0.5,
  );
  setNow("2026-11-05T10:00:00+05:30");

  // Team calendar: who is away, and how many are in.
  const type = await db
    .prepare("SELECT id FROM leave_types WHERE code='CO'")
    .get();
  const req = Number(
    (
      await db
        .prepare(
          "INSERT INTO leave_requests(company_id,user_id,leave_type_id,from_date,to_date,days,leave_year,status,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          1,
          people.emp.id,
          type.id,
          "2026-11-10",
          "2026-11-11",
          2,
          2026,
          "approved",
          "2026-11-05",
        )
    ).lastInsertRowid,
  );
  for (const d of ["2026-11-10", "2026-11-11"])
    for (const sess of ["first", "second"])
      await db
        .prepare(
          "INSERT INTO leave_days(request_id,user_id,day,session,paid) VALUES(?,?,?,?,1)",
        )
        .run(req, people.emp.id, d, sess);
  assert.equal(
    (
      await call(
        "/team/leave-calendar?from=2026-11-09&to=2026-11-12",
        undefined,
        people.emp.token,
      )
    ).status,
    403,
  );
  const cal = (
    await call(
      "/team/leave-calendar?from=2026-11-09&to=2026-11-12",
      undefined,
      people.mgr.token,
    )
  ).data;
  assert.equal(cal.team_size, 1);
  assert.deepEqual(
    cal.days.map((d) => d.away.length),
    [0, 1, 1, 0],
  );
  assert.deepEqual(
    cal.days.map((d) => d.in_count),
    [1, 0, 0, 1],
  );
  const all = (
    await call(
      "/team/leave-calendar?from=2026-11-09&to=2026-11-12",
      undefined,
      hr,
    )
  ).data;
  assert.ok(all.team_size >= 4);
  assert.equal(all.days[1].away[0].name, "EMP");
  assert.equal(
    (
      await call(
        "/team/leave-calendar?from=2026-11-09&to=2027-03-12",
        undefined,
        hr,
      )
    ).status,
    400,
  );
});
