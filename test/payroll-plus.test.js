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

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n").toString("base64");

test("investment declarations feed TDS; payslip year-to-date; cost report against budget; salary band flag", async (t) => {
  const w = await prepared(t);
  const { call, people, db } = w;
  const pay = people.pay.token;
  const e1 = people.e1.token;

  // ---- declaration: employee fills in, payroll verifies ----------------------------------------
  const proof = await call(
    "/documents",
    { kind: "other", name: "LIC receipt", mime: "application/pdf", data: PDF },
    e1,
  );
  assert.equal(proof.status, 201, JSON.stringify(proof.data));
  const other = await call(
    "/documents",
    { kind: "other", name: "Not yours", mime: "application/pdf", data: PDF },
    people.e2.token,
  );
  const empty = (await call("/tax-declaration", undefined, e1)).data;
  assert.equal(empty.declaration, null);
  assert.equal(empty.sections.find((s) => s.key === "80C").cap, 150000);
  assert.ok(empty.comparison.new >= 0);

  const items = [
    {
      section: "80C",
      description: "LIC and PPF",
      amount: 200000,
      document_id: proof.data.id,
    },
    { section: "80D", description: "Health insurance", amount: 30000 },
    { section: "HRA", description: "Rent paid", amount: 100000 },
  ];
  assert.equal(
    (
      await call(
        "/tax-declaration",
        {
          regime: "old",
          items: [{ section: "80C", amount: 1, document_id: other.data.id }],
        },
        e1,
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/tax-declaration",
        { regime: "old", items: [{ section: "999", amount: 5 }] },
        e1,
        "PUT",
      )
    ).status,
    400,
  );
  const saved = await call(
    "/tax-declaration",
    { regime: "old", items },
    e1,
    "PUT",
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.declaration.status, "draft");
  // 80C is capped at 150,000, so the allowed total is 150,000 + 30,000 + 100,000.
  assert.equal(saved.data.allowed.total, 280000);
  assert.equal(saved.data.allowed.bySection["80C"], 150000);
  assert.ok(
    saved.data.comparison.old < saved.data.comparison.new + 1 ||
      saved.data.comparison.old >= 0,
  );
  const salaryRow = () =>
    db
      .prepare(
        "SELECT tax_regime,declared_deductions FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC,id DESC",
      )
      .get(people.e1.id);
  assert.equal(
    (await salaryRow()).declared_deductions,
    0,
    "a draft changes nothing",
  );
  assert.equal((await call("/tax-declaration/submit", {}, e1)).status, 200);
  assert.deepEqual(await salaryRow(), {
    tax_regime: "old",
    declared_deductions: 280000,
  });
  assert.equal(
    (await call("/tax-declaration", { items }, e1, "PUT")).status,
    409,
    "locked once submitted",
  );

  // Payroll sees it, and only payroll.
  assert.equal(
    (await call("/admin/tax-declarations", undefined, people.hr.token)).status,
    403,
  );
  const list = (await call("/admin/tax-declarations", undefined, pay)).data;
  assert.equal(list.rows.length, 1);
  assert.equal(list.rows[0].pending_items, 3);
  const detail = (
    await call(`/admin/tax-declarations/${list.rows[0].id}`, undefined, pay)
  ).data;
  const [i80c, i80d, ihra] = detail.items;
  assert.equal(
    (
      await call(
        `/admin/tax-declarations/items/${i80c.id}/proof`,
        undefined,
        pay,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/tax-declarations/items/${i80d.id}/proof`,
        undefined,
        pay,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        `/admin/tax-declarations/items/${i80c.id}/proof`,
        undefined,
        e1,
      )
    ).status,
    403,
  );
  const review = (body) =>
    call(`/admin/tax-declarations/${list.rows[0].id}/review`, body, pay);
  assert.equal(
    (await review({ decision: "verified" })).status,
    409,
    "every item needs a decision",
  );
  assert.equal((await review({ decision: "changes_requested" })).status, 400);
  assert.equal(
    (
      await review({
        decision: "verified",
        items: [
          { id: i80c.id, status: "verified", verified_amount: 150000 },
          { id: i80d.id, status: "rejected", note: "No proof" },
          { id: ihra.id, status: "verified", verified_amount: 60000 },
        ],
      })
    ).status,
    200,
  );
  assert.deepEqual(await salaryRow(), {
    tax_regime: "old",
    declared_deductions: 210000,
  });
  const done = (await call("/tax-declaration", undefined, e1)).data;
  assert.equal(done.declaration.status, "verified");
  assert.equal(done.allowed.total, 210000);
  assert.equal((await review({ decision: "verified" })).status, 409);

  // Window can be closed by payroll.
  assert.equal(
    (
      await call(
        "/admin/tax-declarations/settings",
        { open: false },
        people.hr.token,
        "PUT",
      )
    ).status,
    403,
  );
  await call("/admin/tax-declarations/settings", { open: false }, pay, "PUT");
  assert.equal(
    (await call("/tax-declaration", { items }, people.e2.token, "PUT")).status,
    409,
  );
  await call("/admin/tax-declarations/settings", { open: true }, pay, "PUT");

  // Back to new regime: deductions stop counting. Employee 2 asks for changes round-trip.
  const e2 = people.e2.token;
  await call(
    "/tax-declaration",
    { regime: "old", items: [{ section: "80C", amount: 50000 }] },
    e2,
    "PUT",
  );
  await call("/tax-declaration/submit", {}, e2);
  const d2 = (
    await call("/admin/tax-declarations", undefined, pay)
  ).data.rows.find((r) => r.name === "E2");
  assert.equal(
    (
      await call(
        `/admin/tax-declarations/${d2.id}/review`,
        { decision: "changes_requested", note: "Attach the receipt" },
        pay,
      )
    ).status,
    200,
  );
  const back = (await call("/tax-declaration", undefined, e2)).data;
  assert.equal(back.declaration.status, "changes_requested");
  assert.equal(back.declaration.review_note, "Attach the receipt");
  assert.equal(back.editable, true);
  await call("/tax-declaration", { regime: "new", items: [] }, e2, "PUT");
  await call("/tax-declaration/submit", {}, e2);
  assert.equal(
    (
      await db
        .prepare(
          "SELECT declared_deductions,tax_regime FROM employee_salaries WHERE user_id=?",
        )
        .get(people.e2.id)
    ).declared_deductions,
    0,
  );

  // A salary revision keeps the regime and declared deductions.
  const rev = await call(
    `/admin/employees/${people.e1.id}/salary`,
    { effective_from: "2026-11-01", monthly_gross: 62000 },
    pay,
  );
  assert.equal(rev.status, 201, JSON.stringify(rev.data));
  assert.deepEqual(await salaryRow(), {
    tax_regime: "old",
    declared_deductions: 210000,
  });
  // ...and flags pay that is outside the grade band.
  const grade = (
    await call(
      "/admin/grades",
      { name: "Grade 5", salary_min: 400000, salary_max: 700000 },
      people.hr.token,
    )
  ).data.id;
  await db
    .prepare("UPDATE users SET grade_id=? WHERE id=?")
    .run(grade, people.e1.id);
  const high = await call(
    `/admin/employees/${people.e1.id}/salary`,
    { effective_from: "2026-12-01", monthly_gross: 65000 },
    pay,
  );
  assert.match(high.data.band_warning.message, /outside the Grade 5 band/);
  const ok = await call(
    `/admin/employees/${people.e1.id}/salary`,
    { effective_from: "2027-01-01", monthly_gross: 50000 },
    pay,
  );
  assert.equal(ok.data.band_warning, null);

  // ---- payslips year to date and the cost report ----------------------------------------------------
  const dep = (
    await call("/admin/departments", { name: "Collections" }, people.hr.token)
  ).data.id;
  const dep2 = (
    await call("/admin/departments", { name: "Credit" }, people.hr.token)
  ).data.id;
  await db
    .prepare("UPDATE users SET department_id=? WHERE id IN (?,?)")
    .run(dep, people.e1.id, people.e2.id);
  await db
    .prepare("UPDATE users SET department_id=? WHERE id=?")
    .run(dep2, people.e4.id);
  const run = await call("/admin/payroll/runs", { month: "2026-10" }, pay);
  assert.equal(run.status, 201, JSON.stringify(run.data));
  assert.equal(
    (
      await call(
        `/admin/payroll/runs/${run.data.id}/approve`,
        {},
        people.boss.token,
      )
    ).status,
    200,
  );
  const ytd = await call("/payslips/ytd", undefined, e1);
  assert.equal(ytd.status, 200, JSON.stringify(ytd.data));
  assert.equal(ytd.data.label, "2026-27");
  assert.equal(ytd.data.months.length, 1);
  assert.equal(ytd.data.total.gross, ytd.data.months[0].gross);
  assert.ok(ytd.data.total.net > 0);
  assert.equal(
    (await call("/payslips/ytd?year=2024", undefined, e1)).data.months.length,
    0,
  );

  const rep = (
    await call(
      "/admin/payroll/cost-report?group=department&from=2026-10&to=2026-10",
      undefined,
      pay,
    )
  ).data;
  assert.deepEqual(rep.groups.map((g) => g.name).sort(), [
    "Collections",
    "Credit",
  ]);
  const coll = rep.groups.find((g) => g.name === "Collections");
  assert.equal(coll.employees, 2);
  assert.equal(
    rep.total.employer_cost,
    rep.groups.reduce((a, g) => a + g.employer_cost, 0),
  );
  assert.equal(coll.budget, 0);
  // Budgets: set for a range; variance is actual minus budget.
  assert.equal(
    (
      await call(
        "/admin/payroll/budgets",
        {
          group: "department",
          ref_id: dep,
          from: "2026-10",
          to: "2026-12",
          amount: 100000,
        },
        people.hr.token,
        "PUT",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/budgets",
        {
          group: "department",
          ref_id: dep,
          from: "2026-10",
          to: "2026-12",
          amount: 100000,
        },
        pay,
        "PUT",
      )
    ).data.months,
    3,
  );
  const rep2 = (
    await call(
      "/admin/payroll/cost-report?group=department&from=2026-10&to=2026-10",
      undefined,
      pay,
    )
  ).data;
  const c2 = rep2.groups.find((g) => g.name === "Collections");
  assert.equal(c2.budget, 100000);
  assert.equal(c2.variance, c2.employer_cost - 100000);
  assert.equal(c2.by_month[0].budget, 100000);
  assert.equal(
    (
      await call(
        "/admin/payroll/budgets?group=department&month=2026-11",
        undefined,
        pay,
      )
    ).data.find((b) => b.ref_id === dep).amount,
    100000,
  );
  assert.equal(
    (await call("/admin/payroll/cost-report?group=bogus", undefined, pay))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/cost-report?group=department&from=2026-10&to=2026-01",
        undefined,
        pay,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/admin/payroll/cost-report?group=department",
        undefined,
        people.e1.token,
      )
    ).status,
    403,
  );
  const csv = await call(
    "/admin/payroll/cost-report?group=department&from=2026-10&to=2026-10&format=csv",
    undefined,
    pay,
  );
  assert.match(csv.data, /"Department","Employees","Gross"/);
  assert.match(csv.data, /"Collections",2,\d+,\d+,\d+,\d+,\d+,100000,-\d+/);
  assert.equal(
    (
      await call(
        "/admin/payroll/cost-report?group=employment_type&from=2026-10&to=2026-10",
        undefined,
        pay,
      )
    ).data.budgets_supported,
    false,
  );
});
