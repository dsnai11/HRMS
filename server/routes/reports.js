import { loadAttendance, toCsv } from "../attendance-report.js";

export function registerReports(router, app) {
  const { db, dayOf, clock } = app;

  router.get(
    "/api/admin/overview",
    { perm: "attendance.read" },
    async ({ companyId, send }) => {
      const today = dayOf(new Date(clock()).toISOString());
      const shifts = (
        await db
          .prepare(
            "SELECT s.* FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.in_at>=?",
          )
          .all(companyId, new Date(clock() - 172800000).toISOString())
      ).filter((s) => dayOf(s.in_at) === today);
      const count = async (sql) => (await db.prepare(sql).get(companyId)).n;
      return send(200, {
        today,
        employees: await count(
          "SELECT COUNT(*) n FROM users WHERE company_id=? AND role<>'super_admin' AND active=1",
        ),
        active: await count(
          "SELECT COUNT(*) n FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.out_at IS NULL",
        ),
        attended: new Set(shifts.map((s) => s.user_id)).size,
        half_days: shifts.filter((s) => s.day_type === "half_day").length,
        hours: shifts.reduce(
          (sum, s) =>
            sum +
            ((s.out_at ? Date.parse(s.out_at) : clock()) -
              Date.parse(s.in_at)) /
              3600000,
          0,
        ),
        workplaces: await count(
          "SELECT COUNT(*) n FROM workplaces WHERE company_id=?",
        ),
      });
    },
  );

  router.get(
    "/api/admin/attendance",
    { perm: "attendance.read" },
    async ({ companyId, query, send }) =>
      send(200, await loadAttendance(app, { companyId, query })),
  );

  router.get(
    "/api/admin/export",
    { perm: "attendance.read" },
    async ({ res, headers, companyId, query, user, audit }) => {
      const rows = await loadAttendance(app, { companyId, query });
      await audit("attendance_exported", { rows: rows.length });
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="attendance.csv"',
      });
      res.end(toCsv(rows));
    },
  );

  router.get(
    "/api/admin/active",
    { perm: "attendance.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT s.*,u.name employee_name,u.email,u.employee_code FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.out_at IS NULL ORDER BY s.in_at DESC",
          )
          .all(companyId),
      ),
  );
}
