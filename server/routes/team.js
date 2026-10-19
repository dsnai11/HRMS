import { HttpError } from "../http.js";
import { loadAttendance, TEAM_SQL } from "../attendance-report.js";

// Anyone with reports is a manager: no separate role to assign or forget.
export function registerTeam(router, app) {
  const { db } = app;
  const requireManager = async (user) => {
    if (
      !(await db
        .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
        .get(user.id))
    )
      throw new HttpError(403, "You do not manage anyone.");
  };

  router.get("/api/team/members", async ({ user, send }) => {
    await requireManager(user);
    return send(
      200,
      await db
        .prepare(
          `SELECT u.id,u.name,u.employee_code,u.email,u.active,u.manager_id,d.name department_name,g.name designation_name,
             (u.manager_id=?) direct
           FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN designations g ON g.id=u.designation_id
           WHERE u.id IN (${TEAM_SQL}) ORDER BY u.name`,
        )
        .all(user.id, user.id),
    );
  });

  router.get(
    "/api/team/attendance",
    async ({ user, companyId, query, send }) => {
      await requireManager(user);
      return send(
        200,
        await loadAttendance(app, {
          companyId: user.company_id,
          query,
          teamOf: user.id,
        }),
      );
    },
  );
}
