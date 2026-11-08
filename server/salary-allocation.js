// Salary by branch: the "Branch wise salary distribution" sheet, worked out by the HRMS.
//
// Every person's monthly salary is put on the branches they cover:
//   - Branch staff (their team, if any, sits in their own branch): all of it on their branch.
//   - People who cover several branches (SBM, cluster, regional, credit, legal…): shared across
//     those branches in proportion to each branch's AUM, the sheet's column J formula
//     salary × branch AUM ÷ total AUM of the branches the person covers.
//     If none of those branches has AUM, it is shared equally.
// Nobody types anything in each month:
//   - Who covers which branch comes from the reporting lines: a manager covers every branch
//     where someone in their team (at any level below) sits, plus their own. A person with no
//     team can also have branches recorded from the budget sheet (staff_branch_coverage).
//   - Salary is the employer cost from the month's approved payroll run, or, before payroll is
//     run, the monthly gross in the person's salary.
//   - AUM comes from the loan system feed (AUM_FEED_URL), or the budget sheet; a branch with no
//     AUM for the month uses its latest earlier figure.
// The current and previous months are worked out again every hour, so transfers, joiners,
// exits, salary changes and payroll approval show up by themselves; older months stay as they
// were calculated.
import { HttpError, csvCell, optionalString } from "./http.js";
import { inBranchScope } from "./scope.js";

const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const lastDay = (month) => {
  const [y, m] = month.split("-").map(Number);
  return `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
};
export const prevMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
};
const key = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// Whole rupees that add back to the total exactly (largest remainders get the extra rupee).
export function shareOut(total, weights) {
  const sum = weights.reduce((s, w) => s + w, 0);
  const whole = Math.round(total);
  if (!sum) return weights.map(() => 0);
  const raw = weights.map((w) => (whole * w) / sum);
  const out = raw.map(Math.floor);
  let left = whole - out.reduce((s, v) => s + v, 0);
  const order = raw.map((v, i) => [v - Math.floor(v), i]).sort((a, b) => b[0] - a[0]);
  for (const [, i] of order) {
    if (left <= 0) break;
    out[i] += 1;
    left -= 1;
  }
  return out;
}

// Match a branch from a file or feed by its code or name, ignoring case, spaces and
// bracketed state tags such as "DHULE(MH)".
export function branchMatcher(branches) {
  const byCode = new Map();
  const byName = new Map();
  for (const b of branches) {
    if (b.code) byCode.set(String(b.code).trim().toLowerCase(), b);
    byName.set(b.name.trim().toLowerCase(), b);
    if (!byName.has(key(b.name))) byName.set(key(b.name), b);
  }
  return (v) => {
    const raw = String(v ?? "").trim().toLowerCase();
    if (!raw) return null;
    return byCode.get(raw) ?? byName.get(raw) ?? byName.get(key(raw)) ?? null;
  };
}

/** Works out one month for one company and saves it. Answers the run summary. */
export async function allocateMonth(app, companyId, month) {
  const { db, transaction } = app;
  const start = `${month}-01`;
  const end = lastDay(month);
  const run = await db
    .prepare("SELECT id FROM payroll_runs WHERE company_id=? AND month=? AND status IN ('approved','paid')")
    .get(companyId, month);
  const salaryOf = new Map();
  if (run) {
    for (const r of await db.prepare("SELECT user_id,employer_cost FROM payroll_items WHERE run_id=?").all(run.id))
      salaryOf.set(r.user_id, Number(r.employer_cost));
  } else {
    for (const r of await db
      .prepare(
        `SELECT s.user_id,s.monthly_gross FROM employee_salaries s
         WHERE s.company_id=? AND s.effective_from<=? AND s.effective_from=(SELECT MAX(x.effective_from) FROM employee_salaries x WHERE x.user_id=s.user_id AND x.effective_from<=?)`,
      )
      .all(companyId, end, end))
      salaryOf.set(r.user_id, Number(r.monthly_gross));
  }
  // People on the books that month (joined by its end, not gone before its start).
  const people = await db
    .prepare(
      `SELECT id,name,employee_code,branch_id,manager_id,active FROM users
       WHERE company_id=? AND role<>'super_admin' AND (date_of_joining IS NULL OR date_of_joining<=?)
         AND (active=1 OR (exit_date IS NOT NULL AND exit_date>=?))`,
    )
    .all(companyId, end, start);
  const byId = new Map(people.map((p) => [p.id, p]));
  const branchName = new Map(
    (await db.prepare("SELECT id,name FROM branches WHERE company_id=?").all(companyId)).map((b) => [b.id, b.name]),
  );
  // AUM for the month; a branch without a figure uses its latest earlier one.
  const aum = new Map();
  for (const r of await db
    .prepare(
      `SELECT a.branch_id,a.aum FROM branch_aum a WHERE a.company_id=? AND a.month=(SELECT MAX(x.month) FROM branch_aum x WHERE x.company_id=a.company_id AND x.branch_id=a.branch_id AND x.month<=?)`,
    )
    .all(companyId, month))
    aum.set(r.branch_id, Number(r.aum));
  const extra = new Map();
  for (const c of await db.prepare("SELECT user_id,branch_id,home_branch_id FROM staff_branch_coverage WHERE company_id=?").all(companyId)) {
    const p = byId.get(c.user_id);
    if (!p || (c.home_branch_id ?? null) !== (p.branch_id ?? null)) continue; // transferred since
    if (!extra.has(c.user_id)) extra.set(c.user_id, new Set());
    extra.get(c.user_id).add(c.branch_id);
  }
  // Branches each person's team sits in, at every level below them.
  const reports = new Map();
  for (const p of people)
    if (p.manager_id && byId.has(p.manager_id)) {
      if (!reports.has(p.manager_id)) reports.set(p.manager_id, []);
      reports.get(p.manager_id).push(p.id);
    }
  const teamBranches = new Map();
  const branchesUnder = (id, seen = new Set()) => {
    if (teamBranches.has(id)) return teamBranches.get(id);
    seen.add(id);
    const set = new Set();
    for (const r of reports.get(id) ?? []) {
      if (seen.has(r)) continue; // a loop in the reporting lines
      const p = byId.get(r);
      if (p.branch_id) set.add(p.branch_id);
      for (const b of branchesUnder(r, seen)) set.add(b);
    }
    teamBranches.set(id, set);
    return set;
  };

  const rows = [];
  const issues = [];
  const noSalary = [];
  const noAum = new Set();
  let total = 0;
  let counted = 0;
  for (const p of people) {
    const salary = salaryOf.get(p.id);
    if (!salary) {
      noSalary.push(p);
      continue;
    }
    const covered = new Set(branchesUnder(p.id));
    if (p.branch_id) covered.add(p.branch_id);
    for (const b of extra.get(p.id) ?? []) covered.add(b);
    const list = [...covered];
    if (!list.length) {
      issues.push({ kind: "no_branch", user_id: p.id, name: p.name, code: p.employee_code, amount: salary, text: "Has no branch and no team in a branch, so the salary is not on any branch." });
      continue;
    }
    total += Math.round(salary);
    counted += 1;
    if (list.length === 1) {
      rows.push({ user_id: p.id, branch_id: list[0], basis: "own", share: 1, amount: Math.round(salary) });
      continue;
    }
    const weights = list.map((b) => aum.get(b) ?? 0);
    for (const [i, b] of list.entries()) if (!aum.has(b)) noAum.add(b);
    const equal = !weights.some((w) => w > 0);
    const w = equal ? list.map(() => 1) : weights;
    const sum = w.reduce((s, v) => s + v, 0);
    const amounts = shareOut(salary, w);
    for (const [i, b] of list.entries())
      if (amounts[i] || w[i])
        rows.push({ user_id: p.id, branch_id: b, basis: equal ? "equal" : "aum", share: w[i] / sum, amount: amounts[i] });
  }
  for (const b of noAum)
    issues.push({ kind: "no_aum", branch_id: b, name: branchName.get(b), text: "No AUM for this branch, so it gets no share of the people it shares with branches that have AUM." });
  if (noSalary.length)
    issues.push({
      kind: "no_salary",
      count: noSalary.length,
      names: noSalary.slice(0, 20).map((p) => `${p.name}${p.employee_code ? ` (${p.employee_code})` : ""}`),
      text: run ? "Not in this month's payroll run." : "No salary saved yet, so they are not counted.",
    });
  const now = new Date(app.clock()).toISOString();
  await transaction(async () => {
    await db.prepare("DELETE FROM salary_allocations WHERE company_id=? AND month=?").run(companyId, month);
    for (const r of rows)
      await db
        .prepare("INSERT INTO salary_allocations(company_id,month,user_id,branch_id,basis,share,amount) VALUES(?,?,?,?,?,?,?)")
        .run(companyId, month, r.user_id, r.branch_id, r.basis, r.share, r.amount);
    await db
      .prepare(
        `INSERT INTO salary_allocation_runs(company_id,month,salary_source,total,people,issues,ran_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT (company_id,month) DO UPDATE SET salary_source=EXCLUDED.salary_source,total=EXCLUDED.total,people=EXCLUDED.people,issues=EXCLUDED.issues,ran_at=EXCLUDED.ran_at`,
      )
      .run(companyId, month, run ? "payroll" : "salary", total, counted, JSON.stringify(issues), now);
  });
  return { month, salary_source: run ? "payroll" : "salary", total, people: counted, issues };
}

// ---- AUM from the loan system ------------------------------------------------------------------
// AUM_FEED_URL answers the branch AUM for ?month=YYYY-MM, as JSON (a list, or {data:[…]}, of
// {branch or branch_code, aum}) or CSV with Branch and AUM columns. AUM_FEED_TOKEN, if set,
// is sent as a bearer token. Figures only need to be in the same unit for every branch.
export function parseAumFeed(text) {
  const t = String(text ?? "").trim();
  let list;
  if (t.startsWith("[") || t.startsWith("{")) {
    const j = JSON.parse(t);
    list = Array.isArray(j) ? j : j.data ?? j.branches ?? j.rows ?? [];
  } else {
    const lines = t.split(/\r?\n/).filter(Boolean).map((l) => l.split(",").map((c) => c.replace(/^"|"$/g, "").trim()));
    const head = (lines.shift() ?? []).map((h) => h.toLowerCase());
    list = lines.map((cells) => Object.fromEntries(head.map((h, i) => [h, cells[i]])));
  }
  return list.map((r) => {
    const get = (...names) => {
      for (const n of names)
        for (const k of Object.keys(r)) if (k.toLowerCase().replace(/[^a-z]/g, "") === n) return r[k];
      return undefined;
    };
    return {
      branch: get("branchcode", "code", "branch", "branchname", "name"),
      aum: Number(String(get("aum", "aumcr", "outstanding", "pos", "principaloutstanding") ?? "").replace(/,/g, "")),
    };
  });
}

export async function saveAum(app, companyId, month, rows, source) {
  const { db, transaction } = app;
  const match = branchMatcher(await db.prepare("SELECT id,name,code FROM branches WHERE company_id=?").all(companyId));
  const now = new Date(app.clock()).toISOString();
  const unknown = [];
  let saved = 0;
  await transaction(async () => {
    for (const r of rows) {
      const b = match(r.branch);
      if (!b || !Number.isFinite(r.aum) || r.aum < 0) {
        if (r.branch) unknown.push(String(r.branch));
        continue;
      }
      await db
        .prepare(
          `INSERT INTO branch_aum(company_id,branch_id,month,aum,source,updated_at) VALUES(?,?,?,?,?,?)
           ON CONFLICT (company_id,branch_id,month) DO UPDATE SET aum=EXCLUDED.aum,source=EXCLUDED.source,updated_at=EXCLUDED.updated_at`,
        )
        .run(companyId, b.id, month, r.aum, source, now);
      saved += 1;
    }
  });
  return { saved, unknown };
}

export async function pullAum(app, companyId, month, env = process.env) {
  const url = env.AUM_FEED_URL;
  if (!url) return null;
  const u = new URL(url);
  u.searchParams.set("month", month);
  const res = await fetch(u, { headers: env.AUM_FEED_TOKEN ? { Authorization: `Bearer ${env.AUM_FEED_TOKEN}` } : {} });
  if (!res.ok) throw new Error(`AUM feed answered ${res.status}`);
  const rows = parseAumFeed(await res.text());
  if (!rows.length) return { saved: 0, unknown: [] };
  return saveAum(app, companyId, month, rows, "feed");
}

// ---- the hourly job ------------------------------------------------------------------------------
const feedState = new Map(); // company:month -> { at, error, saved, unknown }

export async function runSalaryAllocation(app, env = process.env) {
  const month = app.dayOf(new Date(app.clock()).toISOString()).slice(0, 7);
  const companies = await app.db.prepare("SELECT id FROM companies WHERE active=1").all();
  for (const { id } of companies)
    for (const m of [prevMonth(month), month]) {
      if (env.AUM_FEED_URL)
        try {
          const r = await pullAum(app, id, m, env);
          feedState.set(`${id}:${m}`, { at: new Date(app.clock()).toISOString(), ...r });
        } catch (e) {
          feedState.set(`${id}:${m}`, { at: new Date(app.clock()).toISOString(), error: e.message });
        }
      await allocateMonth(app, id, m);
    }
}

export function scheduleSalaryAllocation(app, env = process.env) {
  const run = () => runSalaryAllocation(app, env).catch((e) => console.error("Salary by branch failed:", e.message));
  setTimeout(run, 30000).unref();
  setInterval(run, 60 * 60000).unref();
}

// ---- budget sheet import ---------------------------------------------------------------------------
// The sheet's layout: Month, State, Branch, AUM, then pairs of employee code and name for each
// role (BM_E.code, SBM_E.code, CM_E.code, … L_E.code, LT_E.code), salaries beside some.
// It loads the month's AUM, adds any branches the HRMS does not have yet, and records the
// branches each listed person covers.
const CODE_HEAD = /(e\.?\s*code|emp\s*code|\bid\b|person\s*id)/i;
const excelMonth = (v) => {
  const s = String(v ?? "").trim();
  if (monthRe.test(s.slice(0, 7))) return s.slice(0, 7);
  const n = Number(s);
  if (n > 30000 && n < 80000) return new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 7);
  return null;
};

export async function importSheet(app, companyId, { header, rows, month: chosen, dryRun }) {
  const { db, transaction } = app;
  if (!Array.isArray(header) || !Array.isArray(rows) || !rows.length) throw new HttpError(400, "The sheet has no rows.");
  if (rows.length > 5000) throw new HttpError(400, "The sheet has more than 5,000 branches.");
  const h = header.map((x) => String(x ?? "").trim());
  const col = (re) => h.findIndex((x) => re.test(x));
  const cBranch = col(/^branch( name)?$/i);
  const cAum = col(/^aum$/i);
  const cMonth = col(/^month$/i);
  const cState = col(/^state$/i);
  if (cBranch < 0 || cAum < 0) throw new HttpError(400, "The sheet needs columns headed Branch and AUM.");
  const codeCols = h.map((x, i) => (CODE_HEAD.test(x) ? i : -1)).filter((i) => i >= 0);
  const month = (chosen && monthRe.test(chosen) ? chosen : null) ?? excelMonth(rows[0][cMonth]);
  if (!month) throw new HttpError(400, "Choose the month the sheet is for.");

  const branches = await db.prepare("SELECT id,name,code FROM branches WHERE company_id=?").all(companyId);
  const match = branchMatcher(branches);
  const staff = await db
    .prepare("SELECT id,name,employee_code,branch_id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' AND employee_code IS NOT NULL")
    .all(companyId);
  const byCode = new Map(staff.map((s) => [String(s.employee_code).trim().toLowerCase(), s]));
  const newBranches = [];
  const aumRows = [];
  const covers = new Map(); // user id -> Set of branch names
  const missingCodes = new Set();
  for (const r of rows) {
    const name = String(r[cBranch] ?? "").trim();
    if (!name) continue;
    const aum = Number(String(r[cAum] ?? "").replace(/,/g, ""));
    if (!match(name) && !newBranches.some((b) => b.name.toLowerCase() === name.toLowerCase()))
      newBranches.push({ name, state: cState >= 0 ? String(r[cState] ?? "").trim() || null : null });
    aumRows.push({ branch: name, aum: Number.isFinite(aum) ? aum : 0 });
    for (const c of codeCols) {
      const code = String(r[c] ?? "").trim();
      if (!code || /^(-|na|n\/a|do not assigne?d?)$/i.test(code)) continue;
      const s = byCode.get(code.toLowerCase());
      if (!s) {
        missingCodes.add(code);
        continue;
      }
      if (!covers.has(s.id)) covers.set(s.id, new Set());
      covers.get(s.id).add(name);
    }
  }
  const summary = {
    month,
    branches: aumRows.length,
    new_branches: newBranches.map((b) => b.name),
    total_aum: Math.round(aumRows.reduce((s, r) => s + r.aum, 0) * 100) / 100,
    people_found: covers.size,
    codes_not_found: [...missingCodes].slice(0, 50),
    codes_not_found_count: missingCodes.size,
  };
  if (dryRun) return { ...summary, saved: false };
  const now = new Date(app.clock()).toISOString();
  await transaction(async () => {
    for (const b of newBranches)
      await db.prepare("INSERT INTO branches(company_id,name,state,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING").run(companyId, b.name, b.state, now);
  });
  await saveAum(app, companyId, month, aumRows, "sheet");
  const all = branchMatcher(await db.prepare("SELECT id,name,code FROM branches WHERE company_id=?").all(companyId));
  await transaction(async () => {
    for (const [userId, names] of covers) {
      const s = staff.find((x) => x.id === userId);
      await db.prepare("DELETE FROM staff_branch_coverage WHERE user_id=?").run(userId);
      for (const n of names) {
        const b = all(n);
        if (b)
          await db
            .prepare("INSERT INTO staff_branch_coverage(company_id,user_id,branch_id,home_branch_id,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING")
            .run(companyId, userId, b.id, s.branch_id ?? null, now);
      }
    }
  });
  await allocateMonth(app, companyId, month);
  return { ...summary, saved: true };
}

// ---- routes ----------------------------------------------------------------------------------------
export function registerSalaryAllocation(router, app, env = process.env) {
  const { db } = app;
  const thisMonth = () => app.dayOf(new Date(app.clock()).toISOString()).slice(0, 7);
  const monthOf = (v) => {
    const m = v || thisMonth();
    if (!monthRe.test(m)) throw new HttpError(400, "Choose a month.");
    return m;
  };

  async function view(user, companyId, month) {
    let run = await db.prepare("SELECT * FROM salary_allocation_runs WHERE company_id=? AND month=?").get(companyId, month);
    if (!run && month >= prevMonth(thisMonth())) {
      await allocateMonth(app, companyId, month);
      run = await db.prepare("SELECT * FROM salary_allocation_runs WHERE company_id=? AND month=?").get(companyId, month);
    }
    const branches = (
      await db.prepare("SELECT id,name,code,state,zone,region,head_office FROM branches WHERE company_id=? AND active=1 ORDER BY name").all(companyId)
    ).filter((b) => inBranchScope(user, b.id));
    const aum = new Map(
      (
        await db
          .prepare(
            `SELECT a.branch_id,a.aum,a.month,a.source FROM branch_aum a WHERE a.company_id=? AND a.month=(SELECT MAX(x.month) FROM branch_aum x WHERE x.company_id=a.company_id AND x.branch_id=a.branch_id AND x.month<=?)`,
          )
          .all(companyId, month)
      ).map((r) => [r.branch_id, r]),
    );
    const sums = new Map();
    for (const r of await db
      .prepare("SELECT branch_id,basis,SUM(amount) amount,COUNT(*) people FROM salary_allocations WHERE company_id=? AND month=? GROUP BY branch_id,basis")
      .all(companyId, month)) {
      if (!sums.has(r.branch_id)) sums.set(r.branch_id, { own: 0, shared: 0, own_people: 0, shared_people: 0 });
      const s = sums.get(r.branch_id);
      if (r.basis === "own") {
        s.own += Number(r.amount);
        s.own_people += Number(r.people);
      } else {
        s.shared += Number(r.amount);
        s.shared_people += Number(r.people);
      }
    }
    const list = branches.map((b) => {
      const s = sums.get(b.id) ?? { own: 0, shared: 0, own_people: 0, shared_people: 0 };
      const a = aum.get(b.id);
      return { ...b, aum: a ? Number(a.aum) : null, aum_month: a?.month ?? null, aum_source: a?.source ?? null, ...s, total: s.own + s.shared };
    });
    const latestAum = await db.prepare("SELECT MAX(month) m, MAX(updated_at) at FROM branch_aum WHERE company_id=? AND month<=?").get(companyId, month);
    return {
      month,
      run: run ? { ...run, issues: JSON.parse(run.issues) } : null,
      branches: list,
      total: list.reduce((s, b) => s + b.total, 0),
      total_aum: list.reduce((s, b) => s + (b.aum ?? 0), 0),
      shared_people: Number(
        (await db.prepare("SELECT COUNT(DISTINCT user_id) n FROM salary_allocations WHERE company_id=? AND month=? AND basis<>'own'").get(companyId, month)).n,
      ),
      feed: { configured: Boolean(env.AUM_FEED_URL), last: feedState.get(`${companyId}:${month}`) ?? null },
      aum_month: latestAum?.m ?? null,
      months: (await db.prepare("SELECT month FROM salary_allocation_runs WHERE company_id=? ORDER BY month DESC LIMIT 24").all(companyId)).map((r) => r.month),
    };
  }

  router.get("/api/admin/salary-allocation", { perm: "budget.read" }, async ({ user, companyId, query, send }) =>
    send(200, await view(user, companyId, monthOf(query.get("month")))),
  );

  router.get("/api/admin/salary-allocation/branch/:id", { perm: "budget.read" }, async ({ user, companyId, params, query, send }) => {
    const month = monthOf(query.get("month"));
    const branchId = Number(params.id);
    const branch = await db.prepare("SELECT id,name FROM branches WHERE id=? AND company_id=?").get(branchId, companyId);
    if (!branch || !inBranchScope(user, branchId)) throw new HttpError(404, "Branch not found.");
    const people = await db
      .prepare(
        `SELECT a.user_id,a.basis,a.share,a.amount,u.name,u.employee_code,d.name designation,b.name home_branch,
           (SELECT COUNT(*) FROM salary_allocations x WHERE x.company_id=a.company_id AND x.month=a.month AND x.user_id=a.user_id) branches,
           (SELECT SUM(x.amount) FROM salary_allocations x WHERE x.company_id=a.company_id AND x.month=a.month AND x.user_id=a.user_id) salary
         FROM salary_allocations a JOIN users u ON u.id=a.user_id LEFT JOIN designations d ON d.id=u.designation_id LEFT JOIN branches b ON b.id=u.branch_id
         WHERE a.company_id=? AND a.month=? AND a.branch_id=? ORDER BY a.basis='own' DESC,a.amount DESC`,
      )
      .all(companyId, month, branchId);
    send(200, { month, branch, people: people.map((p) => ({ ...p, branches: Number(p.branches), salary: Number(p.salary) })) });
  });

  router.get("/api/admin/salary-allocation/export", { perm: "budget.read" }, async ({ user, companyId, query, res, headers }) => {
    const month = monthOf(query.get("month"));
    const v = await view(user, companyId, month);
    const allowed = new Set(v.branches.map((b) => b.id));
    const rows = await db
      .prepare(
        `SELECT b.name branch,b.state,u.employee_code,u.name,d.name designation,a.basis,a.share,a.amount,a.branch_id
         FROM salary_allocations a JOIN branches b ON b.id=a.branch_id JOIN users u ON u.id=a.user_id LEFT JOIN designations d ON d.id=u.designation_id
         WHERE a.company_id=? AND a.month=? ORDER BY b.name,a.basis='own' DESC,a.amount DESC`,
      )
      .all(companyId, month);
    const cell = (x) => (typeof x === "number" ? String(Math.round(x * 10000) / 10000) : csvCell(x ?? ""));
    const lines = [["Month", "Branch", "State", "AUM", "Own staff", "Shared", "Total salary"].map(csvCell).join(",")];
    for (const b of v.branches) lines.push([month, b.name, b.state, b.aum ?? "", b.own, b.shared, b.total].map(cell).join(","));
    lines.push("", ["Branch", "State", "Employee code", "Name", "Designation", "How", "Share", "Amount"].map(csvCell).join(","));
    const how = { own: "Own branch", aum: "Shared by AUM", equal: "Shared equally (no AUM)" };
    for (const r of rows)
      if (allowed.has(r.branch_id))
        lines.push([r.branch, r.state, r.employee_code, r.name, r.designation, how[r.basis], r.share, r.amount].map(cell).join(","));
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="salary-by-branch-${month}.csv"`,
    });
    res.end("﻿" + lines.join("\r\n"));
  });

  router.post("/api/admin/salary-allocation/recalculate", { perm: "budget.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const month = monthOf(b.month);
    if (env.AUM_FEED_URL)
      try {
        feedState.set(`${companyId}:${month}`, { at: new Date(app.clock()).toISOString(), ...(await pullAum(app, companyId, month, env)) });
      } catch (e) {
        feedState.set(`${companyId}:${month}`, { at: new Date(app.clock()).toISOString(), error: e.message });
      }
    const r = await allocateMonth(app, companyId, month);
    await audit("salary_allocation_recalculated", { month });
    send(200, r);
  });

  router.post("/api/admin/salary-allocation/sheet", { perm: "budget.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body(4_000_000);
    const r = await importSheet(app, companyId, {
      header: b.header,
      rows: b.rows,
      month: optionalString(b.month, "Month", 7),
      dryRun: Boolean(b.dry_run),
    });
    if (r.saved) await audit("salary_allocation_sheet_imported", { month: r.month, branches: r.branches, new_branches: r.new_branches.length });
    send(200, r);
  });
}
