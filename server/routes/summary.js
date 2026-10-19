import { HttpError, csvCell, integer } from "../http.js";
import { computeMuster } from "../muster.js";

const COLUMNS = [
  ["employee_code", "Employee code"],
  ["name", "Name"],
  ["department_name", "Department"],
  ["present", "Present days"],
  ["half_days", "Half days"],
  ["leave_paid", "Paid leave"],
  ["leave_unpaid", "Unpaid leave"],
  ["holidays", "Holidays"],
  ["weekly_offs", "Weekly offs"],
  ["absent", "Absent"],
  ["payable_days", "Payable days"],
  ["lop_days", "Loss of pay days"],
];

export function registerSummary(router, app) {
  const monthOf = (query) => {
    const m =
      query.get("month") ||
      app.dayOf(new Date(app.clock()).toISOString()).slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))
      throw new HttpError(400, "Choose a month like 2026-10.");
    return m;
  };
  const filters = (query) =>
    Object.fromEntries(
      ["department_id", "branch_id"]
        .filter((k) => query.get(k))
        .map((k) => [k, integer(Number(query.get(k)))]),
    );

  router.get(
    "/api/admin/attendance-summary",
    { perm: "attendance.read" },
    async ({ companyId, query, send }) => {
      const r = await computeMuster(app, {
        companyId,
        month: monthOf(query),
        filters: filters(query),
      });
      return send(200, {
        ...r,
        people: r.people.map(({ days, ...row }) => row),
      });
    },
  );

  router.get(
    "/api/admin/attendance-summary/export",
    { perm: "attendance.read" },
    async ({ res, headers, companyId, query, audit }) => {
      const r = await computeMuster(app, {
        companyId,
        month: monthOf(query),
        filters: filters(query),
      });
      await audit("muster_exported", { month: r.month, rows: r.people.length });
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="muster-${r.month}.csv"`,
      });
      res.end(
        "﻿" +
          [
            COLUMNS.map(([, l]) => l).join(","),
            ...r.people.map((p) =>
              COLUMNS.map(([k]) => csvCell(p[k])).join(","),
            ),
          ].join("\r\n"),
      );
    },
  );

  // The signed-in person's own month, day by day.
  router.get("/api/attendance/calendar", async ({ user, query, send }) => {
    const r = await computeMuster(app, {
      companyId: user.company_id,
      month: monthOf(query),
      userIds: [user.id],
    });
    // super administrators are excluded from musters; give them an empty month
    return send(200, r.people[0] ?? { month: r.month, days: [] });
  });
}
