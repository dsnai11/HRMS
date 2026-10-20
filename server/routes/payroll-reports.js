import { HttpError, csvCell, integer, number, oneOf } from "../http.js";
import { taxYearOf } from "../payroll/tax.js";

const DIMENSIONS = {
  department: {
    table: "departments",
    col: "department_id",
    label: "Department",
    budget: true,
  },
  cost_centre: {
    table: "cost_centres",
    col: "cost_centre_id",
    label: "Cost centre",
    budget: true,
  },
  business_unit: {
    table: "business_units",
    col: "business_unit_id",
    label: "Business unit",
    budget: true,
  },
  branch: {
    table: "branches",
    col: "branch_id",
    label: "Branch",
    budget: true,
  },
  grade: { table: "grades", col: "grade_id", label: "Grade", budget: false },
  employment_type: {
    table: null,
    col: "employment_type",
    label: "Employment type",
    budget: false,
  },
};
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthsBetween = (from, to) => {
  const out = [];
  let [y, m] = from.split("-").map(Number);
  const [ty, tm] = to.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
};
const round = (n) => Math.round(n);

export function registerPayrollReports(router, app) {
  const { db, transaction, clock } = app;
  const thisMonth = () => new Date(clock()).toISOString().slice(0, 7);

  // ---- employee: year-to-date summary --------------------------------------------------------
  router.get("/api/payslips/ytd", async ({ user, query, send }) => {
    const year = query.get("year")
      ? Number(query.get("year"))
      : taxYearOf(thisMonth());
    if (!Number.isInteger(year) || year < 2020 || year > 2100)
      throw new HttpError(400, "Choose a valid year.");
    const rows = await db
      .prepare(
        `SELECT r.month,i.gross,i.deductions,i.net,i.tds,i.pt FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
         WHERE i.user_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=? ORDER BY r.month`,
      )
      .all(user.id, `${year}-04`, `${year + 1}-03`);
    const sum = (k) => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    return send(200, {
      year,
      label: `${year}-${String(year + 1).slice(2)}`,
      months: rows,
      total: {
        gross: sum("gross"),
        deductions: sum("deductions"),
        net: sum("net"),
        tds: sum("tds"),
        pt: sum("pt"),
      },
    });
  });

  // ---- payroll cost by department, cost centre and so on, against budget -------------------------
  router.get(
    "/api/admin/payroll/cost-report",
    { perm: "payroll.read" },
    async ({ companyId, query, res, headers, send }) => {
      const group = oneOf(
        query.get("group") ?? "department",
        "Group",
        Object.keys(DIMENSIONS),
      );
      const spec = DIMENSIONS[group];
      const to = query.get("to") ?? thisMonth();
      const from = query.get("from") ?? to;
      if (!monthRe.test(from) || !monthRe.test(to) || to < from)
        throw new HttpError(400, "Choose a from and to month.");
      const months = monthsBetween(from, to);
      if (months.length > 24)
        throw new HttpError(400, "Choose at most 24 months.");
      const items = await db
        .prepare(
          `SELECT r.month,i.user_id,i.gross,i.net,i.tds,i.pt,i.employer_cost,u.${spec.col} ref
           FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id JOIN users u ON u.id=i.user_id
           WHERE r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=?`,
        )
        .all(companyId, from, to);
      const names = spec.table
        ? new Map(
            (
              await db
                .prepare(`SELECT id,name FROM ${spec.table} WHERE company_id=?`)
                .all(companyId)
            ).map((r) => [r.id, r.name]),
          )
        : null;
      const budgets = spec.budget
        ? await db
            .prepare(
              "SELECT ref_id,month,amount FROM payroll_budgets WHERE company_id=? AND dimension=? AND month>=? AND month<=?",
            )
            .all(companyId, group, from, to)
        : [];
      const groups = new Map();
      const add = (key, name) => {
        if (!groups.has(key))
          groups.set(key, {
            key,
            name,
            people: new Set(),
            gross: 0,
            net: 0,
            tds: 0,
            pt: 0,
            employer_cost: 0,
            by_month: {},
            budget: 0,
            budget_by_month: {},
          });
        return groups.get(key);
      };
      for (const it of items) {
        const key = it.ref ?? "none";
        const g = add(
          key,
          key === "none"
            ? "Not assigned"
            : (names?.get(it.ref) ?? String(it.ref).replaceAll("_", " ")),
        );
        g.people.add(it.user_id);
        g.gross += it.gross;
        g.net += it.net;
        g.tds += it.tds ?? 0;
        g.pt += it.pt ?? 0;
        g.employer_cost += it.employer_cost ?? it.gross;
        g.by_month[it.month] =
          (g.by_month[it.month] ?? 0) + (it.employer_cost ?? it.gross);
      }
      for (const b of budgets) {
        const g = add(b.ref_id, names?.get(b.ref_id) ?? String(b.ref_id));
        g.budget += b.amount;
        g.budget_by_month[b.month] = b.amount;
      }
      const list = [...groups.values()]
        .map((g) => ({
          key: g.key,
          name: g.name,
          employees: g.people.size,
          gross: round(g.gross),
          net: round(g.net),
          tds: round(g.tds),
          pt: round(g.pt),
          employer_cost: round(g.employer_cost),
          budget: spec.budget ? round(g.budget) : null,
          variance:
            spec.budget && g.budget ? round(g.employer_cost - g.budget) : null,
          variance_pct:
            spec.budget && g.budget
              ? Math.round(((g.employer_cost - g.budget) / g.budget) * 1000) /
                10
              : null,
          by_month: months.map((m) => ({
            month: m,
            actual: round(g.by_month[m] ?? 0),
            budget: g.budget_by_month[m] ?? null,
          })),
        }))
        .sort((a, b) => b.employer_cost - a.employer_cost);
      const total = (k) => list.reduce((a, g) => a + (g[k] ?? 0), 0);
      const body = {
        group,
        group_label: spec.label,
        from,
        to,
        months,
        budgets_supported: spec.budget,
        groups: list,
        total: {
          gross: total("gross"),
          net: total("net"),
          tds: total("tds"),
          pt: total("pt"),
          employer_cost: total("employer_cost"),
          budget: spec.budget ? total("budget") : null,
        },
      };
      if (query.get("format") === "csv") {
        const header = [
          spec.label,
          "Employees",
          "Gross",
          "Net pay",
          "TDS",
          "Prof. tax",
          "Employer cost",
          "Budget",
          "Variance",
        ];
        // Numbers stay numbers (a negative variance must not be turned into text).
        const cell = (v) => (typeof v === "number" ? String(v) : csvCell(v));
        const lines = [header.map(csvCell).join(",")];
        for (const g of list)
          lines.push(
            [
              g.name,
              g.employees,
              g.gross,
              g.net,
              g.tds,
              g.pt,
              g.employer_cost,
              g.budget ?? "",
              g.variance ?? "",
            ]
              .map(cell)
              .join(","),
          );
        res.writeHead(200, {
          ...headers,
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="payroll-cost-${group}-${from}-${to}.csv"`,
        });
        return res.end(lines.join("\r\n"));
      }
      return send(200, body);
    },
  );
  router.get(
    "/api/admin/payroll/budgets",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const group = oneOf(
        query.get("group") ?? "department",
        "Group",
        Object.keys(DIMENSIONS).filter((k) => DIMENSIONS[k].budget),
      );
      const month = query.get("month") ?? thisMonth();
      if (!monthRe.test(month)) throw new HttpError(400, "Choose a month.");
      return send(
        200,
        await db
          .prepare(
            `SELECT t.id ref_id,t.name,COALESCE(b.amount,0) amount FROM ${DIMENSIONS[group].table} t
             LEFT JOIN payroll_budgets b ON b.company_id=t.company_id AND b.dimension=? AND b.ref_id=t.id AND b.month=?
             WHERE t.company_id=? AND t.active=1 ORDER BY t.name`,
          )
          .all(group, month, companyId),
      );
    },
  );
  // Sets the same monthly budget for a range of months.
  router.put(
    "/api/admin/payroll/budgets",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const group = oneOf(
        b.group,
        "Group",
        Object.keys(DIMENSIONS).filter((k) => DIMENSIONS[k].budget),
      );
      const from = String(b.from ?? "");
      const to = String(b.to ?? b.from ?? "");
      if (!monthRe.test(from) || !monthRe.test(to) || to < from)
        throw new HttpError(400, "Choose a from and to month.");
      const months = monthsBetween(from, to);
      if (months.length > 24)
        throw new HttpError(400, "Set at most 24 months at a time.");
      const ref = integer(Number(b.ref_id));
      const t = await db
        .prepare(
          `SELECT id FROM ${DIMENSIONS[group].table} WHERE id=? AND company_id=?`,
        )
        .get(ref, companyId);
      if (!t) throw new HttpError(404, `${DIMENSIONS[group].label} not found.`);
      const amount = Math.round(number(b.amount, "Monthly budget", 0, 1e11));
      await transaction(async () => {
        for (const m of months)
          await db
            .prepare(
              "INSERT INTO payroll_budgets(company_id,dimension,ref_id,month,amount) VALUES(?,?,?,?,?) ON CONFLICT (company_id,dimension,ref_id,month) DO UPDATE SET amount=EXCLUDED.amount",
            )
            .run(companyId, group, ref, m, amount);
        await audit("payroll_budget_set", { group, ref, from, to, amount });
      });
      return send(200, { months: months.length });
    },
  );
}
