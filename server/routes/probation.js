import { HttpError, integer, number } from "../http.js";
import { requireOwned, staffWith } from "../scope.js";

const addMonths = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(
    Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0),
  ).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return x.toISOString().slice(0, 10);
};

export function registerProbation(router, app) {
  const { db } = app;
  const today = () => app.dayOf(new Date(app.clock()).toISOString());
  const plusDays = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };

  // Everyone still on probation whose review falls within the window (default 45 days) or is overdue.
  router.get(
    "/api/admin/probation",
    { perm: "changes.manage" },
    async ({ companyId, query, send }) => {
      const within = Math.min(Number(query.get("days")) || 45, 365);
      const rows = await db
        .prepare(
          `SELECT u.id user_id,u.name,u.employee_code,u.date_of_joining,u.probation_end_date,m.name manager_name,g.name designation_name
           FROM users u LEFT JOIN users m ON m.id=u.manager_id LEFT JOIN designations g ON g.id=u.designation_id
           WHERE u.company_id=? AND u.active=1 AND u.probation_end_date IS NOT NULL AND u.probation_end_date<=?
           ORDER BY u.probation_end_date`,
        )
        .all(companyId, plusDays(today(), within));
      return send(
        200,
        rows.map((r) => ({
          ...r,
          overdue: r.probation_end_date < today(),
        })),
      );
    },
  );
  router.get("/api/employment/overview", async ({ user, send }) => {
    const me = await db
      .prepare(
        "SELECT u.probation_end_date,b.name buddy_name,b.phone buddy_phone FROM users u LEFT JOIN users b ON b.id=u.buddy_id WHERE u.id=?",
      )
      .get(user.id);
    return send(200, {
      probation_end_date: me.probation_end_date,
      buddy: me.buddy_name
        ? { name: me.buddy_name, phone: me.buddy_phone }
        : null,
    });
  });
  router.post(
    "/api/admin/employees/:id/probation",
    { perm: "changes.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const p = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      if (!p.probation_end_date)
        throw new HttpError(409, "This person is not on probation.");
      const months = Math.round(
        number((await body()).extend_months, "Months to extend", 1, 12),
      );
      const end = addMonths(p.probation_end_date, months);
      await db
        .prepare(
          "UPDATE users SET probation_end_date=?,probation_notified_on=NULL WHERE id=?",
        )
        .run(end, p.id);
      await audit("probation_extended", { employeeId: p.id, months, end });
      await app.notify([p.id], {
        companyId,
        kind: "career",
        title: `Your probation has been extended to ${end}`,
        link: "myemployment",
        email: true,
      });
      return send(200, { probation_end_date: end });
    },
  );
}

/** Tells the manager and HR when a probation review is close (≤15 days) or overdue; once per period. */
export async function sendProbationReminders(app) {
  const { db } = app;
  const now = today(app);
  const soon = plusDays(now, 15);
  const due = await db
    .prepare(
      "SELECT id,name,company_id,manager_id,probation_end_date FROM users WHERE active=1 AND probation_end_date IS NOT NULL AND probation_end_date<=? AND (probation_notified_on IS NULL OR probation_notified_on<>probation_end_date)",
    )
    .all(soon);
  for (const u of due) {
    const hr = (
      await staffWith(db, u.company_id, ["changes.manage", "employees.write"])
    ).map((r) => r.id);
    await app.notify([u.manager_id, ...hr], {
      companyId: u.company_id,
      kind: "career",
      title:
        u.probation_end_date < now
          ? `${u.name}'s probation review is overdue`
          : `${u.name}'s probation ends on ${u.probation_end_date}`,
      body: "Confirm or extend the probation from Hiring & exits → Onboarding.",
      link: "hiring",
      email: true,
    });
    await db
      .prepare("UPDATE users SET probation_notified_on=? WHERE id=?")
      .run(u.probation_end_date, u.id);
  }
  return due.length;
}
function today(app) {
  return app.dayOf(new Date(app.clock()).toISOString());
}
function plusDays(d, n) {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function scheduleProbationReminders(app) {
  const run = () =>
    sendProbationReminders(app).catch((e) =>
      console.error("Probation reminders failed:", e.message),
    );
  void run();
  const timer = setInterval(run, 6 * 3600000);
  timer.unref();
}
