// The employee Home page: who has a birthday this month, who joined recently, and
// where the person sits in the organisation. Birthdays show day and month only.
export function registerHome(router, app) {
  const { db } = app;
  const today = () => app.dayOf(new Date(app.clock()).toISOString());
  const COLS =
    "u.id,u.name,u.employee_code,g.name designation,d.name department,b.name branch";
  const FROM = `FROM users u LEFT JOIN designations g ON g.id=u.designation_id LEFT JOIN departments d ON d.id=u.department_id
    LEFT JOIN branches b ON b.id=u.branch_id`;
  const PERSON = `${COLS} ${FROM}`;

  router.get("/api/home", async ({ user, send }) => {
    const now = today();
    const month = now.slice(5, 7);
    const since = new Date(Date.parse(`${now}T00:00:00Z`) - 30 * 86400000)
      .toISOString()
      .slice(0, 10);
    const active = "u.company_id=? AND u.active=1 AND u.role<>'super_admin'";
    const [me, birthdays, joiners, reports] = await Promise.all([
      db
        .prepare(`SELECT ${PERSON} WHERE u.id=?`)
        .get(user.id),
      db
        .prepare(
          `SELECT ${COLS},substr(u.date_of_birth,9,2) birth_day ${FROM} WHERE ${active} AND substr(u.date_of_birth,6,2)=? ORDER BY substr(u.date_of_birth,9,2),u.name LIMIT 300`,
        )
        .all(user.company_id, month),
      db
        .prepare(
          `SELECT ${COLS},u.date_of_joining ${FROM} WHERE ${active} AND u.date_of_joining>=? AND u.date_of_joining<=? ORDER BY u.date_of_joining DESC,u.id DESC LIMIT 20`,
        )
        .all(user.company_id, since, now),
      db
        .prepare(
          `SELECT ${PERSON} WHERE ${active} AND u.manager_id=? ORDER BY u.name LIMIT 30`,
        )
        .all(user.company_id, user.id),
    ]);
    const manager = user.manager_id
      ? await db.prepare(`SELECT ${PERSON} WHERE u.id=?`).get(user.manager_id)
      : null;
    return send(200, {
      me,
      month: Number(month),
      birthdays: birthdays.map(({ birth_day, ...p }) => ({
        ...p,
        day: Number(birth_day),
      })),
      joiners,
      org: { manager: manager ?? null, reports },
    });
  });
}
