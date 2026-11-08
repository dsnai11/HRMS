import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { allocateMonth, branchMatcher, parseAumFeed, runSalaryAllocation, shareOut } from "../server/salary-allocation.js";

const PW = "Temporary-pass-123";

async function world(t) {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => Date.parse("2026-06-15T10:00:00+05:30") });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  let token = null;
  const call = async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? JSON.parse(text) : text };
  };
  token = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const branch = async (name) => (await call("/admin/branches", { name })).data.id;
  const person = async (name, code, extra, salary) => {
    const r = await call("/admin/employees", { name, email: `${code}@example.test`, password: PW, employee_code: code, ...extra });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    if (salary)
      await db
        .prepare("INSERT INTO employee_salaries(company_id,user_id,effective_from,monthly_gross,created_at) VALUES(1,?,?,?,?)")
        .run(r.data.id, "2026-04-01", salary, new Date().toISOString());
    return r.data.id;
  };
  return { db, app, call, branch, person };
}

test("the sheet's arithmetic: whole rupees that add up, feeds in JSON or CSV, branch names as the loan system writes them", () => {
  assert.deepEqual(shareOut(48218, [28.5067143157, 2.4591448646]), [44389, 3829], "the sheet's own example");
  assert.deepEqual(shareOut(100, [1, 1, 1]), [34, 33, 33]);
  assert.deepEqual(shareOut(100, [0, 0]), [0, 0]);
  assert.deepEqual(parseAumFeed('{"data":[{"branch_code":"MKR","aum":"1,234.5"}]}'), [{ branch: "MKR", aum: 1234.5 }]);
  assert.deepEqual(parseAumFeed("Branch Name,AUM (Cr)\nDHULE(MH),0.28\n"), [{ branch: "DHULE(MH)", aum: 0.28 }]);
  const match = branchMatcher([{ id: 1, name: "Dhule", code: null }, { id: 2, name: "Makrana (Nagour)", code: "MKR" }]);
  assert.equal(match("DHULE(MH)").id, 1);
  assert.equal(match("mkr").id, 2);
  assert.equal(match("MAKRANA (NAGOUR)").id, 2);
  assert.equal(match("Nowhere"), null);
});

test("salaries are put on branches: own branch, shared by AUM through the reporting lines, and from the budget sheet", async (t) => {
  const { db, app, call, branch, person } = await world(t);
  const makrana = await branch("MAKRANA (NAGOUR)");
  const khatu = await branch("CHHOTI KHATU");
  const sbm = await person("Mahendra", "3708", { branch_id: makrana }, 48218);
  await person("Bm One", "5001", { branch_id: makrana, manager_id: sbm }, 30000);
  await person("Bm Two", "5002", { branch_id: khatu, manager_id: sbm }, 25000);
  const credit = await person("Credit Mgr", "6060", { branch_id: makrana }, 60000);
  await person("Floating", "7000", {}, 10000);
  await person("No Salary", "7001", { branch_id: khatu });

  // Nobody enters anything: the screen works the month out when it is first opened.
  const first = (await call("/admin/salary-allocation")).data;
  assert.equal(first.month, "2026-06");
  assert.equal(first.run.salary_source, "salary");
  const kinds = first.run.issues.map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["no_aum", "no_aum", "no_branch", "no_salary"]);
  // No AUM anywhere yet: the SBM is shared equally.
  const byName = (v) => Object.fromEntries(v.branches.map((b) => [b.name, b]));
  assert.equal(byName(first)["CHHOTI KHATU"].shared, 24109);

  // The June sheet: AUM, a new branch, and a credit manager with no team covering two branches.
  const header = ["Month", "State", "Branch", "AUM", "BM_E.code", "BM", "SBM_E.code", "SBM", "Salary", "AUM\nSegrettion", "CM Id", "CM Name2", "Salary"];
  const rows = [
    ["46174", "RAJASTHAN", "MAKRANA (NAGOUR)", "28.506714315700023", "5001", "Bm One", "3708", "Mahendra kumar", "48218", "", "6060", "Credit Mgr", "60000"],
    ["46174", "RAJASTHAN", "CHHOTI KHATU", "2.4591448645999998", "5002", "Bm Two", "3708", "Mahendra kumar", "48218", "", "NA", "", ""],
    ["46174", "RAJASTHAN", "KOTA", "10", "9999", "Not Here", "", "", "", "", "6060", "Credit Mgr", "60000"],
  ];
  const dry = (await call("/admin/salary-allocation/sheet", { header, rows, dry_run: true })).data;
  assert.deepEqual(
    [dry.month, dry.branches, dry.new_branches, dry.people_found, dry.codes_not_found, dry.saved],
    ["2026-06", 3, ["KOTA"], 4, ["9999"], false],
  );
  assert.equal(await db.prepare("SELECT COUNT(*) n FROM branches WHERE name='KOTA'").get().then((r) => r.n), 0, "a preview saves nothing");
  const done = (await call("/admin/salary-allocation/sheet", { header, rows })).data;
  assert.equal(done.saved, true);
  const kota = (await db.prepare("SELECT id FROM branches WHERE name='KOTA'").get()).id;

  const v = byName((await call("/admin/salary-allocation?month=2026-06")).data);
  // The sheet's column J: 48,218 split 44,389 / 3,829. Branch managers stay on their branch.
  // The credit manager covers Makrana and Kota: 60,000 × 28.51 / 38.51 and × 10 / 38.51.
  assert.equal(v["MAKRANA (NAGOUR)"].own, 30000);
  assert.equal(v["MAKRANA (NAGOUR)"].shared, 44389 + 44418);
  assert.equal(v["CHHOTI KHATU"].shared, 3829);
  assert.equal(v["CHHOTI KHATU"].own, 25000);
  assert.equal(v.KOTA.shared, 15582);
  const total = Object.values(v).reduce((s, b) => s + b.total, 0);
  assert.equal(total, 48218 + 30000 + 25000 + 60000, "every rupee is on exactly one branch");

  const detail = (await call(`/admin/salary-allocation/branch/${kota}?month=2026-06`)).data;
  assert.deepEqual(detail.people.map((p) => [p.employee_code, p.basis, p.amount, p.salary]), [["6060", "aum", 15582, 60000]]);
  const csv = (await call("/admin/salary-allocation/export?month=2026-06")).data;
  assert.match(csv, /"2026-06","KOTA","RAJASTHAN",10,0,15582,15582/);
  assert.match(csv, /"KOTA","RAJASTHAN","6060","Credit Mgr","","Shared by AUM",0\.2597,15582/);

  // A transfer drops the coverage from the sheet by itself.
  await call(`/admin/employees/${credit}`, { branch_id: khatu }, "PATCH");
  await allocateMonth(app, 1, "2026-06");
  const moved = byName((await call("/admin/salary-allocation?month=2026-06")).data);
  assert.equal(moved["CHHOTI KHATU"].own, 25000 + 60000);
  assert.equal(moved.KOTA.total, 0);

  // A new manager whose team spans branches is shared without anyone touching the sheet.
  const rsm = await person("Regional", "8000", { branch_id: kota }, 100000);
  await call(`/admin/employees/${sbm}`, { manager_id: rsm }, "PATCH");
  await allocateMonth(app, 1, "2026-06");
  const people = await db.prepare("SELECT branch_id,amount FROM salary_allocations WHERE month='2026-06' AND user_id=? ORDER BY branch_id").all(rsm);
  assert.equal(people.length, 3, "Kota (own) plus Makrana and Chhoti Khatu through the SBM");
  assert.equal(people.reduce((s, p) => s + p.amount, 0), 100000);
});

test("payroll cost and the loan system feed: worked out every hour, used by budget vs actual", async (t) => {
  const { db, app, call, branch, person } = await world(t);
  const a = await branch("Alpha");
  const b = await branch("Beta");
  const boss = await person("Boss", "100", { branch_id: a }, 50000);
  const x = await person("Xavier", "101", { branch_id: a, manager_id: boss }, 20000);
  const y = await person("Yamini", "102", { branch_id: b, manager_id: boss }, 20000);

  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    globalThis.fetch = realFetch;
  });
  const asked = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://loans.example.test/")) {
      asked.push([String(url), init.headers.Authorization]);
      return new Response(JSON.stringify([{ branch: "ALPHA", aum: 3 }, { branch: "beta", aum: 1 }, { branch: "Gamma", aum: 5 }]), { status: 200 });
    }
    return realFetch(url, init);
  };
  const env = { AUM_FEED_URL: "https://loans.example.test/aum", AUM_FEED_TOKEN: "k1" };
  await runSalaryAllocation(app, env);
  assert.deepEqual(asked.map((q) => q[0]).sort(), ["https://loans.example.test/aum?month=2026-05", "https://loans.example.test/aum?month=2026-06"]);
  assert.equal(asked[0][1], "Bearer k1");
  const aum = await db.prepare("SELECT b.name,a.aum,a.source FROM branch_aum a JOIN branches b ON b.id=a.branch_id WHERE a.month='2026-06' ORDER BY b.name").all();
  assert.deepEqual(aum, [{ name: "Alpha", aum: 3, source: "feed" }, { name: "Beta", aum: 1, source: "feed" }]);

  // Before payroll: monthly gross. Boss 50,000 split 3:1.
  const share = async () =>
    Object.fromEntries(
      (await db.prepare("SELECT b.name,SUM(s.amount) amount FROM salary_allocations s JOIN branches b ON b.id=s.branch_id WHERE s.month='2026-06' GROUP BY b.name").all()).map((r) => [r.name, Number(r.amount)]),
    );
  assert.deepEqual(await share(), { Alpha: 37500 + 20000, Beta: 12500 + 20000 });

  // The approved payroll run's employer cost replaces it, and budget vs actual uses the split.
  const now = new Date().toISOString();
  const run = Number(
    (await db.prepare("INSERT INTO payroll_runs(company_id,month,status,created_at) VALUES(1,'2026-06','approved',?)").run(now)).lastInsertRowid,
  );
  for (const [u, cost] of [[boss, 56000], [x, 22000], [y, 22000]])
    await db
      .prepare(
        "INSERT INTO payroll_items(run_id,company_id,user_id,gross,deductions,net,employer_cost,paid_days,lop_days,taxable_earnings,data) VALUES(?,1,?,?,0,?,?,30,0,?,'{}')",
      )
      .run(run, u, cost, cost, cost, cost);
  await runSalaryAllocation(app, env);
  assert.deepEqual(await share(), { Alpha: 42000 + 22000, Beta: 14000 + 22000 });
  const view = (await call("/admin/salary-allocation?month=2026-06")).data;
  assert.equal(view.run.salary_source, "payroll");
  assert.equal(view.feed.configured, false, "the server itself has no feed configured in this test");

  await call("/admin/budgets?fy=2026");
  const report = (await call("/admin/budgets/report?fy=2026&upto=2026-06")).data;
  const sal = report.heads.find((h) => h.source === "payroll").id;
  const actual = Object.fromEntries(report.branches.map((r) => [r.name, r.heads[sal].actual_ytd]));
  assert.equal(actual.Alpha, 64000);
  assert.equal(actual.Beta, 36000);
});
