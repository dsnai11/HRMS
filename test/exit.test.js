import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { eachDay, monthRange, weekday } from "../server/calendar.js";

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
    clockTo: (iso) => (nowMs = Date.parse(iso)),
  };
}

const IST = (s) => Date.parse(`${s}+05:30`);
async function attend(db, w, key, from, to) {
  for (const d of eachDay(from, to)) {
    if (weekday(d) === 0) continue;
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
        new Date(IST(`${d}T09:30:00`)).toISOString(),
        26.9,
        75.8,
        10,
        new Date(IST(`${d}T18:30:00`)).toISOString(),
        "full_day",
      );
  }
}

test("an exit runs from resignation to settlement, clearance and letters", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    pay = people.pay.token,
    emp = people.emp.token;
  await w.add("boss", { role: "admin" });
  assert.equal(
    (await call("/admin/payroll/components/seed-defaults", {}, pay)).status,
    201,
  );
  assert.equal(
    (
      await call(
        "/admin/leave-settings",
        { attendance_start_date: "2026-11-01" },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.emp.id}/salary`,
        { effective_from: "2026-04-01", monthly_gross: 60000 },
        pay,
      )
    ).status,
    201,
  );
  await db
    .prepare("UPDATE users SET date_of_joining='2018-03-01' WHERE id=?")
    .run(people.emp.id);
  assert.equal(
    (
      await call(
        "/admin/leave-types",
        {
          name: "Earned leave",
          code: "EL",
          quota_per_year: 24,
          accrual: "monthly",
          encashable: true,
        },
        hr,
      )
    ).status,
    201,
  );
  // A loan whose instalments have not started yet.
  const loan = await call(
    "/admin/payroll/loans",
    {
      user_id: people.emp.id,
      principal: 30000,
      installments: 3,
      start_month: "2026-12",
    },
    pay,
  );
  assert.equal(loan.status, 201);
  await attend(db, w, "emp", "2026-11-01", "2026-11-20");

  // The employee resigns; only one exit at a time; they may withdraw while it is pending.
  const mine = (await call("/exit/mine", undefined, emp)).data;
  assert.equal(mine.notice_days, 30);
  assert.equal(
    (await call("/exit/resign", { reason: "Better opportunity" }, emp)).status,
    201,
  );
  assert.equal(
    (await call("/exit/resign", { reason: "again" }, emp)).status,
    409,
  );
  assert.equal((await call("/exit/withdraw", {}, emp)).status, 200);
  assert.equal(
    (await call("/exit/resign", { reason: "Better opportunity" }, emp)).status,
    201,
  );
  assert.equal((await call("/admin/exits", undefined, emp)).status, 403);
  const exit = (await call("/admin/exits?status=pending", undefined, hr))
    .data[0];
  assert.deepEqual(
    [exit.employee_name, exit.notice_days, exit.status],
    ["EMP", 30, "pending"],
  );
  assert.equal(
    (await call(`/admin/exits/${exit.id}/decide`, { decision: "rejected" }, hr))
      .status,
    400,
  );
  // Accepted with an earlier last day than the notice period ends (30 days from 5 Nov would be 5 Dec).
  assert.equal(
    (
      await call(
        `/admin/exits/${exit.id}/decide`,
        { decision: "accepted", last_working_day: "2026-11-20" },
        hr,
      )
    ).status,
    200,
  );
  w.clockTo("2026-12-05T10:00:00+05:30");
  const d = (await call(`/admin/exits/${exit.id}`, undefined, hr)).data;
  assert.equal(d.clearance.length, 6);

  // Settlement preview: notice shortfall, leave encashment (tax-exempt on resignation), gratuity.
  const preview = (
    await call(`/admin/exits/${exit.id}/settlement-preview`, undefined, pay)
  ).data;
  const by = Object.fromEntries(preview.lines.map((l) => [l.key, l]));
  assert.deepEqual(
    [by.notice.kind, by.notice.amount],
    ["deduction", 30000],
    "15 days short of 30, at 60,000 / 30 a day",
  );
  assert.deepEqual(
    [by.encashment.kind, by.encashment.amount, by.encashment.taxable],
    ["earning", 22000, false],
    "22 days at basic 30,000 / 30",
  );
  assert.deepEqual([by.gratuity.amount, by.gratuity.taxable], [155769, false]);
  assert.equal(preview.loan_total, 30000);
  assert.equal(preview.pay_in_month, "2026-11");
  // HR cannot see payroll figures.
  assert.equal(
    (
      await call(
        `/admin/exits/${exit.id}/settlement-preview`,
        undefined,
        people.mgr.token,
      )
    ).status,
    403,
  );

  // Post it, leaving out the notice recovery; HR adds a one-off.
  const post = await call(
    `/admin/exits/${exit.id}/settlement`,
    {
      exclude: ["notice"],
      extras: [{ kind: "earning", name: "Retention bonus", amount: 5000 }],
    },
    pay,
  );
  assert.equal(post.status, 201, JSON.stringify(post.data));
  assert.equal(
    (await call(`/admin/exits/${exit.id}/settlement`, {}, pay)).status,
    409,
    "already posted",
  );
  const adj = (
    await call("/admin/payroll/adjustments?month=2026-11", undefined, pay)
  ).data;
  assert.deepEqual(
    adj
      .map((a) => [a.name.replace(/\(.*/, "").trim(), a.amount, a.taxable])
      .sort(),
    [
      ["Gratuity", 155769, 0],
      ["Leave encashment", 22000, 0],
      ["Retention bonus", 5000, 1],
    ],
  );
  const el = (await call("/leave/balances", undefined, emp)).data[0];
  assert.equal(el.balance, 2, "24 accrued by December less the 22 encashed");

  // The final run pays salary only up to the last working day, the settlement lines and the loan.
  const created = await call("/admin/payroll/runs", { month: "2026-11" }, pay);
  const run = created.data.id;
  const item = (
    await call(
      `/admin/payroll/runs/${run}/items/${people.emp.id}`,
      undefined,
      pay,
    )
  ).data;
  assert.equal(item.paid_days, 20, "days after 20 Nov are not paid");
  assert.equal(item.gross_earnings, 40000 + 22000 + 155769 + 5000);
  const recovered = item.deductions.filter((x) => x.name === "Loan recovery");
  assert.deepEqual(
    [recovered.length, recovered.reduce((n, x) => n + x.amount, 0)],
    [3, 30000],
    "all three instalments, at once",
  );

  // Completion needs the clearance, the approved run and the last day to have passed.
  assert.equal(
    (await call(`/admin/exits/${exit.id}/complete`, {}, hr)).status,
    409,
  );
  for (const c of d.clearance)
    assert.equal(
      (
        await call(
          `/admin/exits/${exit.id}/clearance/${c.id}`,
          { cleared: true },
          hr,
        )
      ).status,
      200,
    );
  assert.equal(
    (await call(`/admin/exits/${exit.id}/complete`, {}, hr)).status,
    409,
    "run not approved",
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/exits/${exit.id}/letter?kind=experience`,
        undefined,
        hr,
      )
    ).status,
    409,
    "not complete yet",
  );
  const done = await call(`/admin/exits/${exit.id}/complete`, {}, hr);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(
    (await db.prepare("SELECT active FROM users WHERE id=?").get(people.emp.id))
      .active,
    0,
  );
  assert.equal(
    (await call("/exit/mine", undefined, emp)).status,
    401,
    "signed out",
  );
  const loanAfter = (
    await call(`/admin/payroll/loans/${loan.data.id}`, undefined, pay)
  ).data;
  assert.equal(loanAfter.status, "closed");
  const letter = (
    await call(`/admin/exits/${exit.id}/letter?kind=relieving`, undefined, hr)
  ).data;
  assert.match(letter.paragraphs[0], /20 November 2026/);
  assert.match(letter.paragraphs[0], /1 March 2018/);
});
