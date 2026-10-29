import { HttpError, csvCell, integer, oneOf, string } from "../http.js";
import { branchScope } from "../scope.js";
import { can } from "../rbac.js";

// Custom (ad-hoc) reports: pick a data set, the columns, filters, a sort and optionally
// "summarise by" one column, without asking for a new report to be built. Every column is
// a fixed SQL expression from the lists below (nothing the user types becomes SQL), each
// data set needs its own right, and branch-limited roles only see their branches.

const PERSON = {
  employee_code: ["Employee code", "u.employee_code"],
  employee_name: ["Employee", "u.name"],
  department: ["Department", "d.name"],
  designation: ["Designation", "g.name"],
  branch: ["Branch", "b.name"],
};
const PEOPLE_JOINS = `LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN designations g ON g.id=u.designation_id
  LEFT JOIN branches b ON b.id=u.branch_id`;
const t = (label, sql, type = "text") => ({ label, sql, type });
const people = Object.fromEntries(Object.entries(PERSON).map(([k, [l, s]]) => [k, t(l, s)]));

function datasets(tz) {
  const local = (col, fmt) => `to_char((${col})::timestamptz AT TIME ZONE '${tz}','${fmt}')`;
  return {
    employees: {
      label: "Employees",
      perm: "employees.read",
      from: `FROM users u ${PEOPLE_JOINS} LEFT JOIN workplaces w ON w.id=u.workplace_id LEFT JOIN users m ON m.id=u.manager_id
        LEFT JOIN grades gr ON gr.id=u.grade_id LEFT JOIN cost_centres cc ON cc.id=u.cost_centre_id LEFT JOIN business_units bu ON bu.id=u.business_unit_id`,
      where: "u.company_id=? AND u.role<>'super_admin'",
      fields: {
        ...people,
        email: t("Email", "u.email"),
        phone: t("Phone", "u.phone"),
        status: t("Status", "CASE WHEN u.active=1 THEN 'Active' ELSE 'Inactive' END"),
        workplace: t("Workplace", "w.name"),
        manager: t("Reporting manager", "m.name"),
        grade: t("Grade", "gr.name"),
        cost_centre: t("Cost centre", "cc.name"),
        business_unit: t("Business unit", "bu.name"),
        employment_type: t("Employment type", "u.employment_type"),
        gender: t("Gender", "u.gender"),
        date_of_joining: t("Date of joining", "u.date_of_joining", "date"),
        date_of_birth: t("Date of birth", "u.date_of_birth", "date"),
        exit_date: t("Exit date", "u.exit_date", "date"),
        probation_end_date: t("Probation ends", "u.probation_end_date", "date"),
      },
      defaults: ["employee_code", "employee_name", "department", "designation", "branch", "status"],
    },
    attendance: {
      label: "Attendance (punches)",
      perm: "attendance.read",
      from: `FROM shifts s JOIN users u ON u.id=s.user_id ${PEOPLE_JOINS}`,
      where: "u.company_id=?",
      fields: {
        date: t("Date", local("s.in_at", "YYYY-MM-DD"), "date"),
        ...people,
        workplace: t("Workplace", "s.workplace_name"),
        in_time: t("Punch in", local("s.in_at", "HH24:MI")),
        out_time: t("Punch out", `CASE WHEN s.out_at IS NULL THEN NULL ELSE ${local("s.out_at", "HH24:MI")} END`),
        hours: t("Hours", "ROUND((EXTRACT(EPOCH FROM (s.out_at::timestamptz - s.in_at::timestamptz))/3600)::numeric,2)", "number"),
        day_type: t("Day", "REPLACE(COALESCE(s.day_type,'open'),'_',' ')"),
      },
      defaults: ["date", "employee_code", "employee_name", "in_time", "out_time", "hours", "day_type"],
    },
    leave: {
      label: "Leave requests",
      perm: "leave.read",
      from: `FROM leave_requests r JOIN users u ON u.id=r.user_id JOIN leave_types lt ON lt.id=r.leave_type_id ${PEOPLE_JOINS}`,
      where: "r.company_id=?",
      fields: {
        ...people,
        leave_type: t("Leave type", "lt.name"),
        from_date: t("From", "r.from_date", "date"),
        to_date: t("To", "r.to_date", "date"),
        days: t("Days", "r.days", "number"),
        status: t("Status", "r.status"),
        reason: t("Reason", "r.reason"),
        applied_on: t("Applied on", local("r.created_at", "YYYY-MM-DD"), "date"),
      },
      defaults: ["employee_code", "employee_name", "leave_type", "from_date", "to_date", "days", "status"],
    },
    payroll: {
      label: "Payroll (per person per month)",
      perm: "payroll.read",
      from: `FROM payroll_items i JOIN payroll_runs pr ON pr.id=i.run_id JOIN users u ON u.id=i.user_id ${PEOPLE_JOINS}
        LEFT JOIN cost_centres cc ON cc.id=u.cost_centre_id LEFT JOIN grades gr ON gr.id=u.grade_id`,
      where: "i.company_id=?",
      fields: {
        month: t("Month", "pr.month"),
        run_status: t("Payroll status", "pr.status"),
        ...people,
        cost_centre: t("Cost centre", "cc.name"),
        grade: t("Grade", "gr.name"),
        gross: t("Gross", "i.gross", "number"),
        deductions: t("Deductions", "i.deductions", "number"),
        net: t("Net pay", "i.net", "number"),
        employer_cost: t("Employer cost", "i.employer_cost", "number"),
        tds: t("TDS", "i.tds", "number"),
        paid_days: t("Paid days", "i.paid_days", "number"),
        lop_days: t("Loss-of-pay days", "i.lop_days", "number"),
      },
      defaults: ["month", "employee_code", "employee_name", "department", "gross", "deductions", "net"],
    },
  };
}

const OPS = {
  text: ["is", "contains", "empty", "not_empty"],
  date: ["from", "to", "empty", "not_empty"],
  number: ["is", "at_least", "at_most"],
};
const MAX_ROWS = 5000;

/** Builds and runs one report definition; returns { columns, rows, truncated }. */
export async function runReport(app, user, companyId, def) {
  const all = datasets(/^[A-Za-z_]+\/[A-Za-z_]+$/.test(app.timezone) ? app.timezone : "Asia/Kolkata");
  const ds = all[oneOf(def?.dataset, "Data set", Object.keys(all))];
  if (!can(user, ds.perm)) throw new HttpError(403, `You do not have access to ${ds.label.toLowerCase()}.`);
  const fieldOf = (k) => {
    const f = ds.fields[k];
    if (!f) throw new HttpError(400, `Unknown column: ${String(k).slice(0, 40)}.`);
    return f;
  };
  const cols = Array.isArray(def.columns) && def.columns.length ? def.columns : ds.defaults;
  if (cols.length > 30) throw new HttpError(400, "Choose up to 30 columns.");
  cols.forEach(fieldOf);
  const params = [companyId];
  const where = [ds.where];
  for (const f of (Array.isArray(def.filters) ? def.filters : []).slice(0, 10)) {
    const field = fieldOf(f.field);
    const op = oneOf(f.op, "Filter", OPS[field.type]);
    if (op === "empty") where.push(`(${field.sql}) IS NULL OR (${field.sql})::text=''`);
    else if (op === "not_empty") where.push(`(${field.sql}) IS NOT NULL AND (${field.sql})::text<>''`);
    else {
      const v = string(String(f.value ?? ""), `Value for ${field.label}`, 100);
      if (field.type === "number") {
        const n = Number(v);
        if (!Number.isFinite(n)) throw new HttpError(400, `${field.label} needs a number.`);
        where.push(`(${field.sql}) ${{ is: "=", at_least: ">=", at_most: "<=" }[op]} ?`);
        params.push(n);
      } else if (field.type === "date") {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new HttpError(400, `${field.label} needs a date (YYYY-MM-DD).`);
        where.push(`(${field.sql}) ${op === "from" ? ">=" : "<="} ?`);
        params.push(v);
      } else if (op === "is") {
        where.push(`LOWER((${field.sql})::text)=LOWER(?)`);
        params.push(v);
      } else {
        where.push(`LOWER((${field.sql})::text) LIKE ?`);
        params.push(`%${v.toLowerCase().replace(/[%_\\]/g, "")}%`);
      }
    }
  }
  const scope = branchScope(user);
  const whereSql = `WHERE (${where.join(") AND (")})${scope.sql}`;
  params.push(...scope.params);
  const dir = def.sort?.dir === "desc" ? "DESC" : "ASC";
  let sql, columns;
  if (def.group_by) {
    // One row per value: how many, and totals of the number columns chosen.
    const g = fieldOf(def.group_by);
    const sums = cols.filter((k) => ds.fields[k].type === "number");
    columns = [
      { key: def.group_by, label: g.label },
      { key: "count", label: "Count" },
      ...sums.map((k) => ({ key: k, label: `Total ${ds.fields[k].label.toLowerCase()}` })),
    ];
    sql = `SELECT ${g.sql} AS "${def.group_by}", COUNT(*) AS "count"${sums.map((k) => `, ROUND(SUM(${ds.fields[k].sql})::numeric,2) AS "${k}"`).join("")}
      ${ds.from} ${whereSql} GROUP BY 1 ORDER BY ${def.sort?.field === "count" ? `2 ${dir}` : `1 ${dir}`} NULLS LAST LIMIT ${MAX_ROWS + 1}`;
  } else {
    columns = cols.map((k) => ({ key: k, label: ds.fields[k].label }));
    const sortKey = def.sort?.field && ds.fields[def.sort.field] ? def.sort.field : cols[0];
    sql = `SELECT ${cols.map((k) => `${ds.fields[k].sql} AS "${k}"`).join(", ")} ${ds.from} ${whereSql}
      ORDER BY ${ds.fields[sortKey].sql} ${dir} NULLS LAST LIMIT ${MAX_ROWS + 1}`;
  }
  const rows = await app.db.prepare(sql).all(...params);
  const num = (v) => (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v);
  return {
    columns,
    rows: rows.slice(0, MAX_ROWS).map((r) => columns.map((c) => num(r[c.key] ?? null))),
    truncated: rows.length > MAX_ROWS,
  };
}

export function registerReportBuilder(router, app) {
  const { db } = app;
  const nowIso = () => new Date(app.clock()).toISOString();
  const tz = () => app.timezone;
  // Anyone with at least one data set's right may build reports from that data set.
  const allowed = (user) =>
    Object.entries(datasets(tz())).filter(([, ds]) => can(user, ds.perm));
  const guard = (user) => {
    if (!allowed(user).length) throw new HttpError(403, "You do not have access to reports.");
  };

  router.get("/api/admin/report-builder", async ({ user, companyId, send }) => {
    guard(user);
    const saved = await db
      .prepare(
        "SELECT s.id,s.name,s.definition,s.created_at,u.name created_by FROM saved_reports s LEFT JOIN users u ON u.id=s.created_by WHERE s.company_id=? ORDER BY s.name",
      )
      .all(companyId);
    const mine = allowed(user).map(([key]) => key);
    return send(200, {
      datasets: allowed(user).map(([key, ds]) => ({
        key,
        label: ds.label,
        defaults: ds.defaults,
        fields: Object.entries(ds.fields).map(([k, f]) => ({ key: k, label: f.label, type: f.type })),
      })),
      ops: OPS,
      saved: saved
        .map((s) => ({ ...s, definition: JSON.parse(s.definition) }))
        .filter((s) => mine.includes(s.definition.dataset)),
    });
  });
  router.post("/api/admin/report-builder/run", async ({ user, companyId, body, send, res, headers, audit }) => {
    guard(user);
    const def = await body();
    const out = await runReport(app, user, companyId, def);
    await audit("custom_report_run", { dataset: def.dataset, rows: out.rows.length, csv: def.format === "csv" });
    if (def.format !== "csv") return send(200, out);
    const csv =
      "﻿" +
      [out.columns.map((c) => c.label), ...out.rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="report-${def.dataset}.csv"`,
      "Cache-Control": "private, no-store",
    });
    res.end(csv);
  });
  router.post("/api/admin/report-builder/saved", async ({ user, companyId, body, send, audit }) => {
    guard(user);
    const b = await body();
    const name = string(b.name, "Report name", 80);
    // Check the definition runs (and is allowed) before keeping it.
    await runReport(app, user, companyId, { ...b.definition, format: "json" });
    const def = {
      dataset: b.definition.dataset,
      columns: b.definition.columns ?? [],
      filters: b.definition.filters ?? [],
      sort: b.definition.sort ?? null,
      group_by: b.definition.group_by ?? null,
    };
    const id = Number(
      (
        await db
          .prepare("INSERT INTO saved_reports(company_id,name,definition,created_by,created_at) VALUES(?,?,?,?,?)")
          .run(companyId, name, JSON.stringify(def), user.id, nowIso())
      ).lastInsertRowid,
    );
    await audit("custom_report_saved", { id, name });
    return send(201, { id });
  });
  router.delete("/api/admin/report-builder/saved/:id", async ({ user, params, companyId, send, audit }) => {
    guard(user);
    const id = integer(Number(params.id));
    const s = await db.prepare("SELECT * FROM saved_reports WHERE id=? AND company_id=?").get(id, companyId);
    const ds = s && datasets(tz())[JSON.parse(s.definition).dataset];
    if (!s || (s.created_by !== user.id && !(ds && can(user, ds.perm))))
      throw new HttpError(404, "Saved report not found.");
    await db.prepare("DELETE FROM saved_reports WHERE id=?").run(id);
    await audit("custom_report_deleted", { id });
    return send(200, { ok: true });
  });
}
