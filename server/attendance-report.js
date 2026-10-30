import { HttpError, csvCell, integer } from "./http.js";
import { addDays, localToUtcMs } from "./calendar.js";

const validDate = (s) =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) &&
  !Number.isNaN(Date.parse(s)) &&
  new Date(s).toISOString().slice(0, 10) === s;

// Everyone who reports to `managerId`, directly or through others.
export const TEAM_SQL = `WITH RECURSIVE team(id) AS (
  SELECT id FROM users WHERE manager_id=?
  UNION SELECT u.id FROM users u JOIN team t ON u.manager_id=t.id
) SELECT id FROM team`;

export async function loadAttendance(
  app,
  { companyId, query, teamOf, scope, page = null, pageSize = 100 },
) {
  const from =
    query.get("from") || app.dayOf(new Date(app.clock()).toISOString());
  const to = query.get("to") || from;
  if (
    !validDate(from) ||
    !validDate(to) ||
    from > to ||
    Date.parse(to) - Date.parse(from) > 93 * 86400000
  )
    throw new HttpError(400, "Choose a valid date range of at most 93 days.");
  // Exact local-day bounds, so the database can page and count.
  const where = ["u.company_id=?", "s.in_at>=?", "s.in_at<?"];
  const params = [
    companyId,
    new Date(localToUtcMs(from, "00:00", app.timezone)).toISOString(),
    new Date(localToUtcMs(addDays(to, 1), "00:00", app.timezone)).toISOString(),
  ];
  for (const key of ["department_id", "branch_id", "user_id"]) {
    const v = query.get(key);
    if (v) {
      where.push(key === "user_id" ? "u.id=?" : `u.${key}=?`);
      params.push(integer(Number(v)));
    }
  }
  // Every word must appear in the name, code or email.
  for (const w of String(query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5)) {
    where.push("LOWER(CONCAT_WS(' ',u.name,u.employee_code,u.email)) LIKE ?");
    params.push(`%${w}%`);
  }
  if (teamOf) {
    where.push(`u.id IN (${TEAM_SQL})`);
    params.push(teamOf);
  }
  // Branch-limited HR roles (see scope.js branchScope).
  if (scope?.sql) {
    where.push(scope.sql.replace(/^ AND /, ""));
    params.push(...scope.params);
  }
  const from_ = `FROM shifts s JOIN users u ON u.id=s.user_id
         LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN branches b ON b.id=u.branch_id
         WHERE ${where.join(" AND ")}`;
  const rows = (
    await app.db
      .prepare(
        `SELECT s.*,(SELECT COUNT(*) FROM punch_photos p WHERE p.shift_id=s.id) selfies,u.name employee_name,u.email,u.employee_code,d.name department_name,b.name branch_name
         ${from_} ORDER BY s.in_at DESC,s.id DESC${page !== null ? ` LIMIT ${pageSize} OFFSET ${page * pageSize}` : ""}`,
      )
      .all(...params)
  )
    .map((s) => ({
      ...s,
      hours:
        ((s.out_at ? Date.parse(s.out_at) : app.clock()) -
          Date.parse(s.in_at)) /
        3600000,
    }));
  if (page === null) return rows;
  const total = Number((await app.db.prepare(`SELECT COUNT(*) n ${from_}`).get(...params)).n);
  return { rows, total, page, page_size: pageSize };
}

const CSV_COLUMNS = [
  "employee_code",
  "employee_name",
  "email",
  "department_name",
  "branch_name",
  "workplace_name",
  "in_at",
  "out_at",
  "hours",
  "day_type",
  "half_day_reasons",
  "required_out_at",
  "in_latitude",
  "in_longitude",
  "in_accuracy",
  "out_latitude",
  "out_longitude",
  "out_accuracy",
];
export function toCsv(rows) {
  return (
    "﻿" +
    [
      CSV_COLUMNS.join(","),
      ...rows.map((r) => CSV_COLUMNS.map((c) => csvCell(r[c])).join(",")),
    ].join("\r\n")
  );
}
