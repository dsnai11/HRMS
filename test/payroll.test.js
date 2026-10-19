import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { addDays, eachDay, monthRange, weekday } from "../server/calendar.js";
import {
  decryptJson,
  encryptJson,
  encryptionKey,
  mask,
} from "../server/crypto-store.js";

const PW = "Temporary-pass-123";
const IST = (s) => Date.parse(`${s}+05:30`);
const secrets = new Map();

async function payrollWorld(t, nowIso = "2026-11-05T10:00:00+05:30") {
  let nowMs = Date.parse(nowIso);
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
  const call = async (path, body, token, method = "POST", headers = {}) => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
      res,
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
        latitude: 26.9124,
        longitude: 75.7873,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const branch = (
    await call(
      "/admin/branches",
      { name: "Bengaluru", state: "Karnataka" },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const email = `${key}@example.test`;
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email,
        password: PW,
        workplace_id: site,
        branch_id: branch,
        date_of_joining: "2026-01-01",
        gender: "male",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(email) };
    return people[key];
  };
  await add("pay", { role: "payroll" });
  await add("hr", { role: "hr" });
  await add("boss", { role: "admin" });
  for (const k of ["e1", "e2", "e3", "e4"]) await add(k);
  const attend = async (key, month, absent = []) => {
    for (const d of eachDay(monthRange(month).from, monthRange(month).to)) {
      if (weekday(d) === 0 || absent.includes(d)) continue;
      await db
        .prepare(
          "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,day_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          people[key].id,
          site,
          "Office",
          26.9124,
          75.7873,
          150,
          50,
          new Date(IST(`${d}T09:30:00`)).toISOString(),
          26.9124,
          75.7873,
          10,
          new Date(IST(`${d}T18:30:00`)).toISOString(),
          "full_day",
        );
    }
  };
  return {
    db,
    call,
    owner,
    people,
    site,
    branch,
    attend,
    setNow: (iso) => (nowMs = Date.parse(iso)),
    signIn,
    add,
  };
}
// Standard setup: structure, Karnataka PT, salaries, opening balances and October attendance.
async function prepared(t, nowIso) {
  const w = await payrollWorld(t, nowIso);
  const { call, people } = w;
  const pay = people.pay.token;
  assert.equal(
    (await call("/admin/payroll/components/seed-defaults", {}, pay)).status,
    201,
  );
  assert.equal(
    (await call("/admin/payroll/pt-slabs/preset", { state: "Karnataka" }, pay))
      .status,
    201,
  );
  assert.equal(
    (
      await call(
        "/admin/leave-settings",
        { attendance_start_date: "2026-10-01" },
        people.hr.token,
        "PATCH",
      )
    ).status,
    200,
  );
  const salary = (key, body) =>
    call(
      `/admin/employees/${people[key].id}/salary`,
      { effective_from: "2026-04-01", ...body },
      pay,
    );
  assert.equal((await salary("e1", { monthly_gross: 60000 })).status, 201);
  assert.equal(
    (await salary("e2", { monthly_gross: 20000, esi_applicable: true })).status,
    201,
  );
  assert.equal((await salary("e4", { monthly_gross: 200000 })).status, 201);
  const opening = (key, income) =>
    call(
      "/admin/payroll/opening",
      {
        user_id: people[key].id,
        tax_year: 2026,
        taxable_income: income,
        tds_deducted: 0,
      },
      pay,
    );
  assert.equal((await opening("e1", 360000)).status, 200);
  assert.equal((await opening("e4", 1200000)).status, 200);
  await w.attend("e1", "2026-10");
  await w.attend("e2", "2026-10", [
    "2026-10-05",
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
    "2026-10-12",
    "2026-10-13",
  ]);
  await w.attend("e4", "2026-10");
  return w;
}
const itemOf = async (w, token, runId, key) =>
  (
    await w.call(
      `/admin/payroll/runs/${runId}/items/${w.people[key].id}`,
      undefined,
      token,
    )
  ).data;

test("payroll setup is permission-checked and validated", async (t) => {
  const w = await payrollWorld(t);
  const { call, people } = w;
  const pay = people.pay.token;
  // Only payroll staff and administrators can see payroll at all.
  for (const who of ["hr", "e1"]) {
    assert.equal(
      (await call("/admin/payroll/components", undefined, people[who].token))
        .status,
      403,
      who,
    );
    assert.equal(
      (await call("/admin/payroll/runs", undefined, people[who].token)).status,
      403,
      who,
    );
  }
  assert.equal(
    (await call("/admin/payroll/components", undefined, pay)).status,
    200,
  );
  assert.equal(
    (await call("/me", undefined, pay)).data.permissions.includes(
      "payroll.approve",
    ),
    false,
  );

  // Salary structure.
  assert.equal(
    (await call("/admin/payroll/components/seed-defaults", {}, pay)).data
      .created,
    3,
  );
  assert.equal(
    (await call("/admin/payroll/components/seed-defaults", {}, pay)).data
      .created,
    0,
    "idempotent",
  );
  const preview = await call(
    "/admin/payroll/salary-preview",
    { monthly_gross: 60000 },
    pay,
  );
  assert.deepEqual(
    preview.data.map((l) => l.amount),
    [30000, 12000, 18000],
  );
  assert.equal(
    (await call("/admin/payroll/salary-preview", { monthly_gross: -1 }, pay))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/components",
        { code: "x", name: "Bad", calc: "fixed", value: 1 },
        pay,
      )
    ).status,
    400,
    "code too short",
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/components",
        { code: "CONV", name: "Conveyance", calc: "fixed", value: 1600 },
        pay,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/components",
        { code: "conv", name: "Dup", calc: "fixed", value: 1 },
        pay,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/components",
        { code: "ODD", name: "Odd", calc: "magic" },
        pay,
      )
    ).status,
    400,
  );
  assert.deepEqual(
    (
      await call("/admin/payroll/salary-preview", { monthly_gross: 60000 }, pay)
    ).data.map((l) => l.amount),
    [30000, 12000, 16400, 1600],
  );
  const components = (await call("/admin/payroll/components", undefined, pay))
    .data;
  const special = components.find((c) => c.code === "SPECIAL");
  assert.equal(
    (
      await call(
        `/admin/payroll/components/${special.id}`,
        { calc: "fixed", value: 100 },
        pay,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/admin/payroll/salary-preview", { monthly_gross: 60000 }, pay))
      .status,
    422,
    "no balancing component",
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/components/${special.id}`,
        { calc: "balance" },
        pay,
        "PATCH",
      )
    ).status,
    200,
  );

  // Settings.
  const settings = (await call("/admin/payroll/settings", undefined, pay)).data;
  assert.deepEqual(
    [
      settings.pf.enabled,
      settings.pf.applyWageCode50Rule,
      settings.pf.restrictToCeiling,
      settings.encryption_configured,
    ],
    [true, true, true, false],
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/settings",
        { pf: { enabled: "yes" } },
        pay,
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/settings",
        { esi: { enabled: false } },
        pay,
        "PATCH",
      )
    ).data.esi.enabled,
    false,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/settings",
        { esi: { enabled: true } },
        pay,
        "PATCH",
      )
    ).data.esi.enabled,
    true,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/settings",
        { pf: { enabled: false } },
        people.e1.token,
        "PATCH",
      )
    ).status,
    403,
  );

  // Professional-tax slabs.
  assert.ok(
    (await call("/admin/payroll/pt-presets", undefined, pay)).data.includes(
      "Maharashtra",
    ),
  );
  assert.equal(
    (await call("/admin/payroll/pt-slabs/preset", { state: "Atlantis" }, pay))
      .status,
    400,
  );
  assert.equal(
    (await call("/admin/payroll/pt-slabs/preset", { state: "Karnataka" }, pay))
      .data.rows,
    2,
  );
  assert.equal(
    (await call("/admin/payroll/pt-slabs/preset", { state: "Karnataka" }, pay))
      .status,
    201,
    "reloading replaces rather than duplicates",
  );
  const slabs = (await call("/admin/payroll/pt-slabs", undefined, pay)).data;
  assert.equal(slabs.length, 2);
  const extra = await call(
    "/admin/payroll/pt-slabs",
    { state: "Kerala", from_amount: 12000, amount: 120 },
    pay,
  );
  assert.equal(extra.status, 201);
  assert.equal(
    (
      await call(
        "/admin/payroll/pt-slabs",
        { state: "Kerala", from_amount: 500, to_amount: 100, amount: 1 },
        pay,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/pt-slabs/${extra.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );

  // Salaries.
  const set = (who, body) =>
    call(`/admin/employees/${people[who].id}/salary`, body, pay);
  assert.equal(
    (await set("e1", { monthly_gross: 60000 })).status,
    400,
    "effective date required",
  );
  assert.equal(
    (await set("e1", { effective_from: "2026-04-01", monthly_gross: 0 }))
      .status,
    400,
  );
  assert.equal(
    (
      await set("e1", {
        effective_from: "2026-04-01",
        monthly_gross: 60000,
        tax_regime: "flat",
      })
    ).status,
    400,
  );
  assert.equal(
    (await set("e1", { effective_from: "2026-04-01", monthly_gross: 60000 }))
      .status,
    201,
  );
  assert.equal(
    (await set("e1", { effective_from: "2026-04-01", monthly_gross: 61000 }))
      .status,
    409,
    "one salary per effective date",
  );
  assert.equal(
    (await set("e1", { effective_from: "2026-10-01", monthly_gross: 66000 }))
      .status,
    201,
    "a revision keeps the history",
  );
  const history = (
    await call(`/admin/employees/${people.e1.id}/salary`, undefined, pay)
  ).data;
  assert.deepEqual(
    history.map((h) => h.monthly_gross),
    [66000, 60000],
  );
  assert.equal(
    history[1].lines.reduce((s, l) => s + l.amount, 0),
    60000,
  );
  assert.equal(
    (
      await call(
        "/admin/employees/999999/salary",
        { effective_from: "2026-04-01", monthly_gross: 1 },
        pay,
      )
    ).status,
    400,
  );
  const list = (await call("/admin/payroll/salaries?q=e1", undefined, pay))
    .data;
  assert.equal(
    list.items[0].monthly_gross,
    66000,
    "the latest revision is the current salary",
  );
  assert.equal(
    (await call("/admin/payroll/salaries", undefined, people.hr.token)).status,
    403,
  );

  // One-off adjustments.
  const adj = {
    user_id: people.e1.id,
    month: "2026-10",
    kind: "earning",
    name: "Award",
    amount: 5000,
  };
  assert.equal(
    (await call("/admin/payroll/adjustments", { ...adj, amount: 0 }, pay))
      .status,
    400,
  );
  assert.equal(
    (await call("/admin/payroll/adjustments", { ...adj, kind: "gift" }, pay))
      .status,
    400,
  );
  const created = await call("/admin/payroll/adjustments", adj, pay);
  assert.equal(created.status, 201);
  assert.equal(
    (await call("/admin/payroll/adjustments?month=2026-10", undefined, pay))
      .data.length,
    1,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/adjustments/${created.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/admin/payroll/adjustments?month=bad", undefined, pay)).status,
    400,
  );
});

test("a payroll run computes pay, locks on approval, and gives employees their payslips", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const pay = people.pay.token,
    boss = people.boss.token;

  // Only completed months can be run.
  assert.equal(
    (await call("/admin/payroll/runs", { month: "2026-11" }, pay)).status,
    422,
    "this month is not over",
  );
  assert.equal(
    (await call("/admin/payroll/runs", { month: "2026-12" }, pay)).status,
    422,
  );
  assert.equal(
    (await call("/admin/payroll/runs", { month: "oct" }, pay)).status,
    400,
  );
  assert.equal(
    (await call("/admin/payroll/runs", { month: "2026-10" }, people.hr.token))
      .status,
    403,
  );
  const created = await call("/admin/payroll/runs", { month: "2026-10" }, pay);
  assert.equal(created.status, 201);
  assert.equal(created.data.computed, 3);
  assert.ok(
    created.data.skipped.some(
      (s) => s.name === "E3" && s.reason === "no_salary",
    ),
  );
  assert.equal(
    (await call("/admin/payroll/runs", { month: "2026-10" }, pay)).status,
    409,
  );
  const runId = created.data.id;

  // E1: full month, ₹60,000, Karnataka.
  const e1 = await itemOf(w, pay, runId, "e1");
  assert.deepEqual(
    e1.earnings.map((e) => e.amount),
    [30000, 12000, 18000],
  );
  assert.deepEqual(
    [e1.paid_days, e1.lop_days, e1.gross_earnings],
    [31, 0, 60000],
  );
  assert.deepEqual(
    [e1.pf.employee, e1.pf.employerEps, e1.pf.employerEpf, e1.pf.edli],
    [3000, 2083, 917, 125],
  );
  assert.equal(e1.professional_tax, 200);
  assert.equal(e1.tds.this_month, 0);
  assert.equal(e1.net_pay, 56800);
  assert.equal(e1.employer_cost, 63250);
  assert.equal(e1.employee.name, "E1");

  // E2: 7 days lost, covered by ESI.
  const e2 = await itemOf(w, pay, runId, "e2");
  assert.deepEqual([e2.paid_days, e2.lop_days], [24, 7]);
  assert.deepEqual(
    e2.earnings.map((e) => e.amount),
    [7742, 3097, 4645],
  );
  assert.equal(e2.gross_earnings, 15484);
  assert.deepEqual(
    [e2.pf.employee, e2.pf.employerEps, e2.pf.employerEpf],
    [929, 645, 284],
  );
  assert.deepEqual([e2.esi.employee, e2.esi.employer], [117, 504]);
  assert.equal(e2.professional_tax, 0);
  assert.equal(e2.net_pay, 14438);

  // E4: high earner pays monthly tax on the projected year.
  const e4 = await itemOf(w, pay, runId, "e4");
  assert.equal(e4.tds.annual_tax, 292500);
  assert.equal(e4.tds.this_month, 48750);
  assert.equal(e4.net_pay, 200000 - 3000 - 200 - 48750);

  const view = (await call(`/admin/payroll/runs/${runId}`, undefined, pay))
    .data;
  assert.equal(view.totals.employees, 3);
  assert.equal(view.totals.gross, 60000 + 15484 + 200000);
  assert.equal(view.totals.net, 56800 + 14438 + 148050);
  assert.equal(view.items.length, 3);
  assert.equal(
    (await call("/admin/payroll/runs", undefined, pay)).data[0].net,
    view.totals.net,
  );

  // Adjustments change a draft on recompute.
  const bonus = await call(
    "/admin/payroll/adjustments",
    {
      user_id: people.e1.id,
      month: "2026-10",
      kind: "earning",
      name: "Spot award",
      amount: 5000,
    },
    pay,
  );
  await call(
    "/admin/payroll/adjustments",
    {
      user_id: people.e1.id,
      month: "2026-10",
      kind: "deduction",
      name: "Salary advance",
      amount: 2000,
    },
    pay,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/recompute`, {}, pay)).status,
    200,
  );
  const e1b = await itemOf(w, pay, runId, "e1");
  assert.equal(e1b.gross_earnings, 65000);
  assert.equal(e1b.pf.employee, 3000, "one-off awards are not PF wages");
  assert.equal(e1b.net_pay, 65000 - 3000 - 200 - 2000);
  assert.equal(
    (
      await call(
        `/admin/payroll/adjustments/${bonus.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/recompute`, {}, pay)).status,
    200,
  );
  assert.equal(
    (await itemOf(w, pay, runId, "e1")).net_pay,
    60000 - 3000 - 200 - 2000,
  );

  // Nothing is visible to employees until approval.
  assert.equal(
    (await call("/payslips", undefined, people.e1.token)).data.length,
    0,
  );
  assert.equal(
    (await call(`/payslips/${runId}`, undefined, people.e1.token)).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${runId}/export?type=bank`,
        undefined,
        pay,
      )
    ).status,
    409,
    "no bank file before approval",
  );

  // Approval: only an administrator.
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/approve`, {}, pay)).status,
    403,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/paid`, {}, pay)).status,
    409,
    "approve first",
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/approve`, {}, boss)).status,
    200,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/approve`, {}, boss)).status,
    409,
  );
  // …and then the month is frozen.
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}/recompute`, {}, pay)).status,
    409,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}`, undefined, pay, "DELETE"))
      .status,
    409,
  );
  const late = {
    user_id: people.e1.id,
    month: "2026-10",
    kind: "earning",
    name: "Late",
    amount: 1,
  };
  assert.equal(
    (await call("/admin/payroll/adjustments", late, pay)).status,
    409,
  );
  const frozen = { effective_from: "2026-10-15", monthly_gross: 70000 };
  assert.equal(
    (await call(`/admin/employees/${people.e1.id}/salary`, frozen, pay)).status,
    409,
    "cannot revise a locked month without confirming arrears",
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e1.id}/salary`,
        { ...frozen, effective_from: "2026-11-01" },
        pay,
      )
    ).status,
    201,
  );

  // Payslips.
  const mine = (await call("/payslips", undefined, people.e1.token)).data;
  assert.deepEqual(
    [mine.length, mine[0].month, mine[0].net],
    [1, "2026-10", 54800],
  );
  const slip = (await call(`/payslips/${runId}`, undefined, people.e1.token))
    .data;
  assert.equal(slip.company, "Alpha Ltd");
  assert.equal(slip.net_pay, 54800);
  assert.equal(slip.warnings, undefined, "review notes stay internal");
  assert.equal(
    (await call(`/payslips/${runId}`, undefined, people.e3.token)).status,
    404,
    "no payslip for someone not in the run",
  );
  assert.equal(
    (await call("/payslips", undefined, people.e3.token)).data.length,
    0,
  );

  // Paid.
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${runId}/paid`,
        { paid_on: "31/10/2026" },
        pay,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${runId}/paid`,
        { paid_on: "2026-11-01" },
        pay,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${runId}`, undefined, pay)).data.run
      .status,
    "paid",
  );
  assert.equal(
    (await call("/payslips", undefined, people.e1.token)).data[0].status,
    "paid",
  );
  // A draft run for another month can be discarded.
  w.setNow("2026-12-05T10:00:00+05:30");
  const sept = await call("/admin/payroll/runs", { month: "2026-09" }, pay);
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${sept.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
});

test("income tax carries across months from approved runs and opening balances", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const run1 = (
    await call("/admin/payroll/runs", { month: "2026-10" }, people.pay.token)
  ).data.id;
  assert.equal(
    (await itemOf(w, people.pay.token, run1, "e4")).tds.this_month,
    48750,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run1}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  // November: the same annual projection, so the same monthly tax, with October's TDS counted as paid.
  w.setNow("2026-12-05T10:00:00+05:30");
  await w.attend("e4", "2026-11");
  const run2 = (
    await call("/admin/payroll/runs", { month: "2026-11" }, people.pay.token)
  ).data.id;
  const nov = await itemOf(w, people.pay.token, run2, "e4");
  assert.deepEqual(
    [nov.tds.months_left, nov.tds.already_deducted, nov.tds.projected_income],
    [5, 48750, 2400000],
  );
  assert.equal(nov.tds.annual_tax, 292500);
  assert.equal(nov.tds.this_month, 48750);
  // A rise in pay from December is caught up over the remaining months.
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e4.id}/salary`,
        { effective_from: "2026-12-01", monthly_gross: 300000 },
        people.pay.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run2}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  w.setNow("2027-01-05T10:00:00+05:30");
  await w.attend("e4", "2026-12");
  const run3 = (
    await call("/admin/payroll/runs", { month: "2026-12" }, people.pay.token)
  ).data.id;
  const dec = await itemOf(w, people.pay.token, run3, "e4");
  assert.equal(
    dec.tds.projected_income,
    1200000 + 200000 + 200000 + 300000 + 3 * 300000,
  );
  assert.ok(dec.tds.this_month > 48750, "higher pay means higher monthly tax");
  assert.equal(dec.tds.already_deducted, 97500);
});

test("bank, PAN and UAN details are encrypted, masked and audited", async (t) => {
  const original = process.env.DATA_ENCRYPTION_KEY;
  t.after(() =>
    original === undefined
      ? delete process.env.DATA_ENCRYPTION_KEY
      : (process.env.DATA_ENCRYPTION_KEY = original),
  );
  delete process.env.DATA_ENCRYPTION_KEY;
  const w = await prepared(t);
  const { call, people, db } = w;
  const pay = people.pay.token;
  const put = (body, who = "e1") =>
    call(`/admin/employees/${people[who].id}/private`, body, pay, "PUT");

  // Without a key nothing sensitive is stored.
  assert.equal((await put({ pan: "ABCDE1234F" })).status, 503);
  assert.equal(
    (await call(`/admin/employees/${people.e1.id}/private`, undefined, pay))
      .data.encryption_configured,
    false,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM employee_private").get()).n,
    0,
  );

  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.equal(
    (
      await put({
        pan: "abcde1234f",
        bank_account: "123456789012",
        ifsc: "hdfc0001234",
        bank_name: "HDFC Bank",
        uan: "101234567890",
      })
    ).status,
    200,
  );
  for (const bad of [
    { pan: "BADPAN" },
    { uan: "123" },
    { ifsc: "XYZ" },
    { bank_account: "12ab" },
    { esi_ip: "99" },
  ])
    assert.equal((await put(bad)).status, 400, JSON.stringify(bad));
  const masked = (
    await call(`/admin/employees/${people.e1.id}/private`, undefined, pay)
  ).data;
  assert.equal(
    masked.data.pan,
    "••••••1234F".slice(0, 6) + "234F",
    "all but the last four hidden",
  );
  assert.equal(masked.data.bank_account, "••••••••9012");
  assert.equal(
    masked.data.bank_name,
    "HDFC Bank",
    "non-sensitive fields stay readable",
  );
  const raw = (await db.prepare("SELECT data FROM employee_private").get())
    .data;
  assert.ok(
    !raw.includes("123456789012") &&
      !raw.includes("ABCDE1234F") &&
      !raw.includes("HDFC"),
    "nothing is stored in the clear",
  );
  assert.equal(decryptJson(raw, encryptionKey()).bank_account, "123456789012");
  const before = (
    await db
      .prepare(
        "SELECT COUNT(*) n FROM audit WHERE action='sensitive_data_viewed'",
      )
      .get()
  ).n;
  const full = (
    await call(
      `/admin/employees/${people.e1.id}/private?reveal=1`,
      undefined,
      pay,
    )
  ).data;
  assert.equal(full.data.bank_account, "123456789012");
  assert.equal(full.data.ifsc, "HDFC0001234");
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='sensitive_data_viewed'",
        )
        .get()
    ).n,
    before + 1,
    "revealing is logged",
  );
  // Updating one field keeps the others; an empty value removes it.
  assert.equal((await put({ pan: "" })).data.data.pan, undefined);
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e1.id}/private?reveal=1`,
        undefined,
        pay,
      )
    ).data.data.uan,
    "101234567890",
  );
  // Employees see only a masked copy of their own; others cannot read payroll data.
  assert.equal(
    (await call("/profile/private", undefined, people.e1.token)).data.data
      .bank_account,
    "••••••••9012",
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e1.id}/private`,
        undefined,
        people.e2.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e1.id}/private`,
        undefined,
        people.hr.token,
      )
    ).status,
    403,
  );

  // Exports use the stored details and flag the missing ones.
  const run = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  const reg = (
    await call(
      `/admin/payroll/runs/${run}/export?type=register`,
      undefined,
      pay,
    )
  ).data;
  assert.match(reg, /Employee code,Name,Department,Paid days/);
  assert.match(reg, /"E1"/);
  const pf = (
    await call(`/admin/payroll/runs/${run}/export?type=pf`, undefined, pay)
  ).data;
  assert.match(pf, /"101234567890","E1"/);
  assert.match(pf, /"MISSING","E2"/);
  const esi = (
    await call(`/admin/payroll/runs/${run}/export?type=esi`, undefined, pay)
  ).data;
  assert.match(esi, /"MISSING","E2"/);
  assert.ok(!esi.includes('"E1"'), "only people covered by ESI are listed");
  assert.match(
    (await call(`/admin/payroll/runs/${run}/export?type=pt`, undefined, pay))
      .data,
    /"E1"/,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/export?type=bank`, undefined, pay))
      .status,
    409,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/export?type=nope`, undefined, pay))
      .status,
    400,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  const bank = (
    await call(`/admin/payroll/runs/${run}/export?type=bank`, undefined, pay)
  ).data;
  assert.match(
    bank,
    /"E\d{4}","E1","HDFC Bank","123456789012","HDFC0001234","56800","Salary Oct 2026"/,
  );
  assert.match(bank, /"E\d{4}","E2","","MISSING","MISSING","14438"/);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM audit WHERE action='bank_advice_exported'",
        )
        .get()
    ).n,
    1,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${run}/export?type=register`,
        undefined,
        people.e1.token,
      )
    ).status,
    403,
  );
});

test("encryption helper detects tampering, wrong keys and bad keys", () => {
  const key = randomBytes(32);
  const text = encryptJson({ a: 1, b: "secret" }, key);
  assert.deepEqual(decryptJson(text, key), { a: 1, b: "secret" });
  assert.notEqual(
    encryptJson({ a: 1 }, key),
    encryptJson({ a: 1 }, key),
    "a fresh nonce each time",
  );
  assert.throws(() => decryptJson(text, randomBytes(32)));
  const parts = text.split(".");
  parts[3] = Buffer.from("tampered").toString("base64url");
  assert.throws(() => decryptJson(parts.join("."), key));
  assert.throws(() => decryptJson("v9.a.b.c", key), /Unknown/);
  assert.equal(encryptionKey({}), null);
  assert.throws(
    () =>
      encryptionKey({
        DATA_ENCRYPTION_KEY: Buffer.from("short").toString("base64"),
      }),
    /32 bytes/,
  );
  assert.equal(
    encryptionKey({ DATA_ENCRYPTION_KEY: key.toString("base64") }).length,
    32,
  );
  assert.deepEqual(["", "abc", "1234567890"].map(mask), [
    "",
    "••••",
    "••••••7890",
  ]);
});

test("payroll can require a second person to approve, and stays within its company", async (t) => {
  const w = await prepared(t);
  const { call, people, owner } = w;
  assert.equal(
    (
      await call(
        "/admin/payroll/settings",
        { approval: { separateApprover: true } },
        people.boss.token,
        "PATCH",
      )
    ).status,
    200,
  );
  // The administrator prepares the run, so they cannot also approve it.
  const run = (
    await call("/admin/payroll/runs", { month: "2026-10" }, people.boss.token)
  ).data.id;
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    403,
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, owner)).status,
    200,
  );
  // Another company cannot reach this company's payroll.
  const beta = (
    await call("/admin/companies", { name: "Beta", code: "BETA" }, owner)
  ).data.id;
  const inBeta = { "X-Company-Id": String(beta) };
  assert.equal(
    (await call(`/admin/payroll/runs/${run}`, undefined, owner, "GET", inBeta))
      .status,
    404,
  );
  assert.equal(
    (await call("/admin/payroll/runs", undefined, owner, "GET", inBeta)).data
      .length,
    0,
  );
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${run}/items/${people.e1.id}`,
        undefined,
        owner,
        "GET",
        inBeta,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.e1.id}/salary`,
        undefined,
        owner,
        "GET",
        inBeta,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/admin/payroll/components", undefined, owner, "GET", inBeta))
      .data.length,
    0,
  );
});

test("a back-dated revision pays the difference, and the PF on it, as arrears", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const pay = people.pay.token;
  const run = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    200,
  );

  const revise = (key, body, extra = {}) =>
    call(
      `/admin/employees/${people[key].id}/salary${extra.preview ? "-arrears" : ""}`,
      { effective_from: "2026-10-01", ...body },
      pay,
    );
  const raise = { monthly_gross: 22000, esi_applicable: true };
  // A preview shows what would be paid, month by month, without changing anything.
  const preview = (await revise("e2", raise, { preview: true })).data;
  assert.deepEqual(
    preview.rows.map((r) => [
      r.month,
      r.old_gross,
      r.new_gross,
      r.gross_diff,
      r.pf_diff,
    ]),
    [["2026-10", 15484, 17032, 1548, 93]],
  );
  assert.deepEqual(
    [preview.total_gross, preview.total_pf, preview.pay_in_month],
    [1548, 93, "2026-11"],
  );
  assert.equal(
    (await call(`/admin/employees/${people.e2.id}/salary`, undefined, pay)).data
      .length,
    1,
    "nothing was saved",
  );
  // Without confirmation a back-dated revision is refused.
  const refused = await revise("e2", raise);
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /arrears/);
  const done = await revise("e2", { ...raise, arrears: true });
  assert.equal(done.status, 201);
  assert.equal(done.data.arrears.total_gross, 1548);
  const adjustments = (
    await call("/admin/payroll/adjustments?month=2026-11", undefined, pay)
  ).data;
  assert.deepEqual(
    adjustments
      .filter((a) => a.employee_name === "E2")
      .map((a) => [a.kind, a.name, a.amount, a.taxable]),
    [
      ["earning", "Arrears Oct 2026", 1548, 1],
      ["deduction", "PF on arrears (employee)", 93, 0],
    ],
  );
  // The approved October run is untouched.
  assert.equal((await itemOf(w, pay, run, "e2")).gross_earnings, 15484);

  // A retrospective reduction becomes a recovery.
  const cut = await revise("e1", { monthly_gross: 54000, arrears: true });
  assert.equal(cut.data.arrears.total_gross, -6000);
  const recovery = (
    await call("/admin/payroll/adjustments?month=2026-11", undefined, pay)
  ).data.find((a) => a.employee_name === "E1");
  assert.deepEqual([recovery.kind, recovery.amount], ["deduction", 6000]);

  // November's payroll carries both, and the new salary ends ESI cover (22,000 is above the 21,000 limit).
  w.setNow("2026-12-05T10:00:00+05:30");
  await w.attend("e1", "2026-11");
  await w.attend("e2", "2026-11");
  const nov = (await call("/admin/payroll/runs", { month: "2026-11" }, pay))
    .data.id;
  const e2 = await itemOf(w, pay, nov, "e2");
  assert.equal(e2.gross_earnings, 22000 + 1548);
  assert.deepEqual(
    [e2.esi.employee, e2.esi.employer],
    [0, 0],
    "no longer covered",
  );
  assert.deepEqual(
    e2.deductions.map((d) => [d.code, d.amount]),
    [
      ["PF", 1320],
      ["ADJ", 93],
    ],
  );
  assert.equal(e2.net_pay, 23548 - 1320 - 93);
  const e1 = await itemOf(w, pay, nov, "e1");
  assert.equal(
    e1.net_pay,
    54000 - 6000 - 3000 - 200,
    "reduced pay, less the recovery, PF and professional tax",
  );
});

test("loans are recovered by instalment, and reimbursement claims are paid with the run", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const pay = people.pay.token;
  const e1 = people.e1.token;

  // A 30,000 loan over three months from October.
  const loan = await call(
    "/admin/payroll/loans",
    {
      user_id: people.e1.id,
      principal: 30000,
      installments: 3,
      start_month: "2026-10",
    },
    pay,
  );
  assert.equal(loan.status, 201, JSON.stringify(loan.data));
  const detail = (
    await call(`/admin/payroll/loans/${loan.data.id}`, undefined, pay)
  ).data;
  assert.deepEqual(
    detail.schedule.map((s) => [s.month, s.amount]),
    [
      ["2026-10", 10000],
      ["2026-11", 10000],
      ["2026-12", 10000],
    ],
  );
  assert.equal(
    (await call("/loans", undefined, e1)).data[0].schedule.length,
    3,
  );

  // A claim type with a yearly limit; the limit is enforced per tax year.
  const type = (
    await call(
      "/admin/claim-types",
      { name: "Travel", annual_limit: 5000 },
      pay,
    )
  ).data.id;
  const claim = await call(
    "/claims",
    {
      claim_type_id: type,
      expense_date: "2026-10-10",
      amount: 3000,
      description: "Client visit",
      reference: "BILL-1",
    },
    e1,
  );
  assert.equal(claim.status, 201, JSON.stringify(claim.data));
  const over = await call(
    "/claims",
    {
      claim_type_id: type,
      expense_date: "2026-10-11",
      amount: 2500,
      description: "Another",
    },
    e1,
  );
  assert.equal(over.status, 409);
  assert.match(over.data.error, /yearly limit/);
  // You cannot decide your own claim; payroll can, and a rejection needs a reason.
  assert.equal(
    (
      await call(
        `/claims/${claim.data.id}/decide`,
        { decision: "approved" },
        e1,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/claims/${claim.data.id}/decide`,
        { decision: "rejected" },
        pay,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/claims/${claim.data.id}/decide`,
        { decision: "approved", approved_amount: 2800 },
        pay,
      )
    ).status,
    200,
  );

  // October's run recovers the instalment and pays the claim, neither being taxed.
  const run = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  const slip = await itemOf(w, pay, run, "e1");
  assert.deepEqual(
    slip.deductions
      .filter((d) => d.code === "ADJ")
      .map((d) => [d.name, d.amount]),
    [["Loan recovery", 10000]],
  );
  const reimb = slip.earnings.find((e) => e.name === "Reimbursement: Travel");
  assert.equal(reimb.amount, 2800);
  assert.equal(
    slip.taxable_earnings,
    slip.gross_earnings - 2800 - 0,
    "reimbursement is not taxable",
  );
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  const after = (
    await call(`/admin/payroll/loans/${loan.data.id}`, undefined, pay)
  ).data;
  assert.deepEqual(
    after.schedule.map((s) => s.status),
    ["deducted", "pending", "pending"],
  );
  assert.equal((await call("/claims", undefined, e1)).data[0].status, "paid");

  // Skipping November's instalment pushes it to the end; cancelling stops the rest.
  assert.equal(
    (
      await call(
        `/admin/payroll/loans/${loan.data.id}/skip`,
        { month: "2026-11" },
        pay,
      )
    ).status,
    200,
  );
  const skipped = (
    await call(`/admin/payroll/loans/${loan.data.id}`, undefined, pay)
  ).data;
  assert.deepEqual(skipped.schedule.map((s) => s.month).sort(), [
    "2026-10",
    "2026-12",
    "2027-01",
  ]);
  assert.equal(
    (
      await call(
        `/admin/payroll/loans/${loan.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/admin/payroll/loans/${loan.data.id}`, undefined, pay)).data
      .status,
    "cancelled",
  );
});

test("leave encashment, statutory bonus, gratuity and the statutory files", async (t) => {
  const w = await prepared(t);
  const { call, people, db } = w;
  const pay = people.pay.token;

  // ---- leave encashment: only for types marked encashable, and it can be reversed
  const el = await call(
    "/admin/leave-types",
    {
      name: "Earned leave",
      code: "EL",
      quota_per_year: 24,
      accrual: "monthly",
      encashable: true,
    },
    people.hr.token,
  );
  assert.equal(el.status, 201, JSON.stringify(el.data));
  const tooMany = await call(
    `/admin/employees/${people.e1.id}/leave-encashment`,
    { leave_type_id: el.data.id, days: 200, pay_in_month: "2026-11" },
    pay,
  );
  assert.equal(tooMany.status, 409);
  const enc = await call(
    `/admin/employees/${people.e1.id}/leave-encashment`,
    { leave_type_id: el.data.id, days: 2, pay_in_month: "2026-11" },
    pay,
  );
  assert.equal(enc.status, 201, JSON.stringify(enc.data));
  assert.deepEqual([enc.data.amount, enc.data.rate], [2000, 1000]);
  const bal = async () =>
    (await call("/leave/balances", undefined, people.e1.token)).data[0].balance;
  assert.equal(await bal(), 20, "two days came off the balance");
  assert.equal(
    (
      await call(
        `/admin/payroll/encashments/${enc.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(await bal(), 22, "reversing gives the days back");

  // ---- an approved run to report on
  const run = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  assert.equal(
    (await call(`/admin/payroll/runs/${run}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  // Identity numbers are needed for the statutory files.
  const original = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  t.after(() =>
    original === undefined
      ? delete process.env.DATA_ENCRYPTION_KEY
      : (process.env.DATA_ENCRYPTION_KEY = original),
  );
  const file = (type, q = "") =>
    call(`/admin/payroll/runs/${run}/export?type=${type}${q}`, undefined, pay);
  assert.equal((await file("ecr")).status, 409, "no UANs yet");
  const ident = {
    e1: { pan: "ABCDE1234F", uan: "101234567890" },
    e2: { pan: "BCDEF2345G", uan: "101234567891", esi_ip: "1234567890" },
    e4: { pan: "CDEFG3456H", uan: "101234567892" },
  };
  for (const [k, v] of Object.entries(ident))
    assert.equal(
      (await call(`/admin/employees/${people[k].id}/private`, v, pay, "PUT"))
        .status,
      200,
    );

  // ECR: eleven fields per member, joined with #~#.
  const ecr = (await file("ecr")).data.split("\r\n");
  assert.equal(ecr.length, 3);
  const e2 = ecr.find((l) => l.startsWith("101234567891")).split("#~#");
  assert.equal(e2.length, 11);
  assert.deepEqual(e2.slice(0, 2).concat(e2.slice(2, 4)), [
    "101234567891",
    "E",
    "15484",
    "7742",
  ]);
  assert.equal(e2[9], "7", "days of non-contributory service");

  // ESIC upload: six columns; only the ESI-covered employee, days as whole numbers.
  const esic = (await file("esic")).data.replace(/^\uFEFF/, "").split("\r\n");
  assert.equal(esic.length, 2);
  assert.equal(esic[0].split(",").length, 6);
  assert.deepEqual(
    esic[1]
      .split(",")
      .slice(0, 4)
      .map((x) => x.replaceAll('"', "")),
    ["1234567890", "E2", "24", "15484"],
  );

  // Form 130 data and the Form 138 quarter, taken from approved runs and opening balances.
  const stmt = (
    await call("/admin/payroll/tax-statement?year=2026", undefined, pay)
  ).data;
  const s4 = stmt.rows.find((r) => r.name === "E4");
  assert.deepEqual(
    [s4.gross, s4.taxable, s4.tds, s4.pt],
    [200000, 1400000, 48750, 200],
    "this month plus the opening balance",
  );
  const q3 = (await file("x")).status; // unknown export type
  assert.equal(q3, 400);
  const f138 = await call(
    "/admin/payroll/tax-statement?year=2026&form=138&quarter=3&format=csv",
    undefined,
    pay,
  );
  assert.equal(f138.status, 200);
  assert.match(f138.data, /CDEFG3456H/);
  assert.match(f138.data, /2026-10/);
  const f138q1 = (
    await call(
      "/admin/payroll/tax-statement?year=2026&form=138&quarter=1&format=csv",
      undefined,
      pay,
    )
  ).data;
  assert.doesNotMatch(
    f138q1,
    /CDEFG3456H/,
    "October is not in the first quarter",
  );

  // ---- bonus needs 30 days of work; with two months E2 qualifies on wages capped at 7,000
  w.setNow("2026-12-05T10:00:00+05:30");
  for (const k of ["e1", "e2", "e4"]) await w.attend(k, "2026-11");
  const nov = (await call("/admin/payroll/runs", { month: "2026-11" }, pay))
    .data.id;
  assert.equal(
    (await call(`/admin/payroll/runs/${nov}/approve`, {}, people.boss.token))
      .status,
    200,
  );
  const bonus = (await call("/admin/payroll/bonus?year=2026", undefined, pay))
    .data;
  const b2 = bonus.rows.find((r) => r.name === "E2");
  assert.deepEqual(
    [b2.eligible, b2.days, b2.base, b2.amount],
    [true, 54, 12419, 1035],
    "7,000 x 24/31 + 7,000 x 30/30, at 8.33%",
  );
  assert.equal(
    bonus.rows.find((r) => r.name === "E1").eligible,
    false,
    "wages above 21,000",
  );
  const apply = await call(
    "/admin/payroll/bonus",
    { year: 2026, pay_in_month: "2026-12" },
    pay,
  );
  assert.deepEqual(apply.data, { added: 1 });
  assert.equal(
    (
      await call(
        "/admin/payroll/bonus",
        { year: 2026, pay_in_month: "2026-12" },
        pay,
      )
    ).status,
    409,
    "cannot be added twice",
  );
  const line = (
    await call("/admin/payroll/adjustments?month=2026-12", undefined, pay)
  ).data;
  assert.deepEqual(
    line.map((a) => [a.name, a.amount, a.taxable]),
    [["Statutory bonus 2026-27", 1035, 1]],
  );

  // ---- gratuity: eligible after five years, wages at least half of gross
  await db
    .prepare("UPDATE users SET date_of_joining='2018-03-01' WHERE id=?")
    .run(people.e1.id);
  const g = (
    await call(
      `/admin/employees/${people.e1.id}/gratuity?as_of=2026-10-05`,
      undefined,
      pay,
    )
  ).data;
  assert.deepEqual(
    [g.wages, g.service_years, g.counted_years, g.eligible, g.payable],
    [30000, 8, 9, true, 155769],
  );
  const liability = (
    await call(
      "/admin/payroll/gratuity-liability?as_of=2026-10-05",
      undefined,
      pay,
    )
  ).data;
  assert.equal(liability.rows.find((r) => r.name === "E1").payable, 155769);
  assert.equal(liability.rows.find((r) => r.name === "E4").error, undefined);
});

test("PF and ESI challan summaries add up the run", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const pay = people.pay.token;
  const run = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  const csvOf = async (type) =>
    (
      await call(
        `/admin/payroll/runs/${run}/export?type=${type}`,
        undefined,
        pay,
      )
    ).data
      .replace(/^﻿/, "")
      .split("\r\n")
      .map((l) => l.split(",").map((c) => c.replaceAll('"', "")));
  const esi = await csvOf("esi_challan");
  const pf = await csvOf("pf_challan");
  assert.deepEqual(esi[1], [
    "2026-10",
    "1",
    "15484",
    "117",
    "504",
    "621",
    "2026-11-15",
  ]);
  assert.deepEqual(pf[1], [
    "2026-10",
    "3",
    "137742",
    "9047",
    "4811",
    "289",
    "289",
    "14436",
    "2026-11-15",
  ]);
});

test("labour welfare fund applies in the months the state's rule names", async (t) => {
  const w = await prepared(t);
  const { call, people } = w;
  const pay = people.pay.token;
  // Karnataka branch. A rule for ₹20 from the employee and ₹40 from the employer, paid in June and December only.
  assert.equal(
    (
      await call(
        "/admin/payroll/lwf-rules",
        {
          state: "Karnataka",
          employee_amount: 20,
          employer_amount: 40,
          months: "6, 12",
        },
        people.hr.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/lwf-rules",
        {
          state: "Karnataka",
          employee_amount: 20,
          employer_amount: 40,
          months: "13",
        },
        pay,
      )
    ).status,
    400,
  );
  const rule = await call(
    "/admin/payroll/lwf-rules",
    {
      state: "karnataka",
      employee_amount: 20,
      employer_amount: 40,
      months: "6, 12",
      max_wage: 100000,
    },
    pay,
  );
  assert.equal(rule.status, 201, JSON.stringify(rule.data));
  assert.equal(
    (
      await call(
        "/admin/payroll/lwf-rules",
        { state: "KARNATAKA", employee_amount: 1, months: "6" },
        pay,
      )
    ).status,
    409,
    "one rule per state",
  );
  // October is not a deduction month.
  const oct = (await call("/admin/payroll/runs", { month: "2026-10" }, pay))
    .data.id;
  const e1 = await itemOf(w, pay, oct, "e1");
  assert.equal(
    e1.deductions.some((d) => d.code === "LWF"),
    false,
  );
  assert.equal(e1.employer.lwf, 0);
  // Switch the rule to October and recompute: e1 (60,000) pays; e4 (200,000) is over the wage limit.
  await w.db.prepare("UPDATE lwf_rules SET months='10'").run();
  assert.equal(
    (await call(`/admin/payroll/runs/${oct}/recompute`, {}, pay)).status,
    200,
  );
  const e1b = await itemOf(w, pay, oct, "e1");
  assert.deepEqual(
    e1b.deductions.filter((d) => d.code === "LWF").map((d) => d.amount),
    [20],
  );
  assert.equal(e1b.employer.lwf, 40);
  assert.equal(
    e1b.employer_cost,
    e1b.gross_earnings +
      e1b.employer.pf_epf +
      e1b.employer.pf_eps +
      e1b.employer.edli +
      e1b.employer.pf_admin +
      e1b.employer.esi +
      40,
  );
  assert.equal(
    (await itemOf(w, pay, oct, "e4")).deductions.some((d) => d.code === "LWF"),
    false,
    "above the wage limit",
  );
  const report = (
    await call(`/admin/payroll/runs/${oct}/export?type=lwf`, undefined, pay)
  ).data
    .replace(/^﻿/, "")
    .split("\r\n");
  assert.equal(report.length, 3, "header plus two covered employees");
  assert.equal(
    (
      await call(
        `/admin/payroll/lwf-rules/${rule.data.id}`,
        undefined,
        pay,
        "DELETE",
      )
    ).status,
    200,
  );
});
