import { HttpError, integer } from "../http.js";
import { loadAttendance, toCsv } from "../attendance-report.js";
import { branchScope } from "../scope.js";

// Page numbers start at 0.
const pageNumber = (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 0 || n > 100000) throw new HttpError(400, "Invalid page.");
  return n;
};

export function registerReports(router, app) {
  const { db, dayOf, clock } = app;

  router.get(
    "/api/admin/overview",
    { perm: "attendance.read" },
    async ({ user, companyId, send }) => {
      const today = dayOf(new Date(clock()).toISOString());
      const scope = branchScope(user);
      const shifts = (
        await db
          .prepare(
            `SELECT s.* FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.in_at>=?${scope.sql}`,
          )
          .all(
            companyId,
            new Date(clock() - 172800000).toISOString(),
            ...scope.params,
          )
      ).filter((s) => dayOf(s.in_at) === today);
      const count = async (sql) =>
        (await db.prepare(sql).get(companyId, ...scope.params)).n;
      return send(200, {
        today,
        employees: await count(
          `SELECT COUNT(*) n FROM users u WHERE company_id=? AND role<>'super_admin' AND active=1${scope.sql}`,
        ),
        active: await count(
          `SELECT COUNT(*) n FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.out_at IS NULL${scope.sql}`,
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
        workplaces: (
          await db
            .prepare("SELECT COUNT(*) n FROM workplaces WHERE company_id=?")
            .get(companyId)
        ).n,
      });
    },
  );

  router.get(
    "/api/admin/attendance",
    { perm: "attendance.read" },
    async ({ user, companyId, query, send }) =>
      send(
        200,
        await loadAttendance(app, {
          companyId,
          query,
          scope: branchScope(user),
          // The web portal asks for a page at a time; without "page" every row comes back.
          ...(query.has("page") ? { page: pageNumber(query.get("page")) } : {}),
        }),
      ),
  );

  router.get(
    "/api/admin/export",
    { perm: "attendance.read" },
    async ({ res, headers, companyId, query, user, audit }) => {
      const rows = await loadAttendance(app, {
        companyId,
        query,
        scope: branchScope(user),
      });
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
    async ({ user, companyId, query, send }) => {
      const scope = branchScope(user);
      // ?limit=20 for the Overview page: by mid-morning everyone has an open shift.
      const limit = query.get("limit") ? Math.min(integer(Number(query.get("limit"))), 1000) : null;
      return send(
        200,
        await db
          .prepare(
            `SELECT s.*,u.name employee_name,u.email,u.employee_code FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.out_at IS NULL${scope.sql} ORDER BY s.in_at DESC${limit ? ` LIMIT ${limit}` : ""}`,
          )
          .all(companyId, ...scope.params),
      );
    },
  );
}
