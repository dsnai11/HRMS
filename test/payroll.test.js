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
    "cannot revise a locked month",
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
