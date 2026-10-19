import { can } from "../rbac.js";
import { addDays, eachDay } from "../calendar.js";

const monthsBack = (month, n) => {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 - n, 1));
  return d.toISOString().slice(0, 7);
};

export function registerInsights(router, app) {
  const { db, clock } = app;

  router.get(
    "/api/admin/insights",
    { perm: "insights.read" },
    async ({ user, companyId, send }) => {
      const today = app.dayOf(new Date(clock()).toISOString());
      const thisMonth = today.slice(0, 7);
      const staff = "company_id=? AND role<>'super_admin'";
      const active = `${staff} AND active=1`;
      const group = async (col, join) =>
        db
          .prepare(
            `SELECT COALESCE(x.name,'Not set') name,COUNT(*) n FROM users u ${join} WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' GROUP BY x.name ORDER BY n DESC`,
          )
          .all(companyId);
      const total = (
        await db
          .prepare(`SELECT COUNT(*) n FROM users WHERE ${active}`)
          .get(companyId)
      ).n;

      // Joiners and leavers by month over the last 12 months.
      const months = Array.from({ length: 12 }, (_, i) =>
        monthsBack(thisMonth, 11 - i),
      );
      const joined = new Map(
        (
          await db
            .prepare(
              `SELECT substr(date_of_joining,1,7) m,COUNT(*) n FROM users WHERE ${staff} AND date_of_joining>=? GROUP BY 1`,
            )
            .all(companyId, `${months[0]}-01`)
        ).map((r) => [r.m, r.n]),
      );
      const left = new Map(
        (
          await db
            .prepare(
              `SELECT substr(last_working_day,1,7) m,COUNT(*) n FROM exits WHERE company_id=? AND status='completed' AND last_working_day>=? GROUP BY 1`,
            )
            .all(companyId, `${months[0]}-01`)
        ).map((r) => [r.m, r.n]),
      );
      const joiners12 = months.reduce((s, m) => s + (joined.get(m) ?? 0), 0);
      const leavers12 = months.reduce((s, m) => s + (left.get(m) ?? 0), 0);
      const yearAgo = total + leavers12 - joiners12;
      const avg = (total + Math.max(yearAgo, 0)) / 2;

      // Attendance for the last 14 days.
      const days = [...eachDay(addDays(today, -13), today)];
      const shiftRows = await db
        .prepare(
          "SELECT s.user_id,s.in_at FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND s.in_at>=?",
        )
        .all(
          companyId,
          new Date(Date.parse(`${days[0]}T00:00:00Z`) - 86400000).toISOString(),
        );
      const presentOn = new Map(days.map((d) => [d, new Set()]));
      for (const r of shiftRows)
        presentOn.get(app.dayOf(r.in_at))?.add(r.user_id);
      const onLeaveToday = (
        await db
          .prepare(
            "SELECT COUNT(DISTINCT d.user_id) n FROM leave_days d JOIN leave_requests r ON r.id=d.request_id WHERE r.company_id=? AND r.status='approved' AND d.day=?",
          )
          .get(companyId, today)
      ).n;

      const year = today.slice(0, 4);
      const out = {
        as_of: today,
        headcount: {
          total,
          by_department: await group(
            "department",
            "LEFT JOIN departments x ON x.id=u.department_id",
          ),
          by_branch: await group(
            "branch",
            "LEFT JOIN branches x ON x.id=u.branch_id",
          ),
          by_type: await db
            .prepare(
              `SELECT COALESCE(employment_type,'not set') name,COUNT(*) n FROM users WHERE ${active} GROUP BY 1 ORDER BY n DESC`,
            )
            .all(companyId),
        },
        movement: {
          months: months.map((m) => ({
            month: m,
            joined: joined.get(m) ?? 0,
            left: left.get(m) ?? 0,
          })),
          joiners_12m: joiners12,
          leavers_12m: leavers12,
          attrition_percent:
            avg > 0 ? Math.round((leavers12 / avg) * 1000) / 10 : 0,
          in_notice: (
            await db
              .prepare(
                "SELECT COUNT(*) n FROM exits WHERE company_id=? AND status='accepted'",
              )
              .get(companyId)
          ).n,
        },
        attendance: {
          today_present: presentOn.get(today)?.size ?? 0,
          on_leave_today: onLeaveToday,
          series: days.map((d) => ({
            date: d,
            present: presentOn.get(d).size,
          })),
        },
        leave: {
          pending: (
            await db
              .prepare(
                "SELECT COUNT(*) n FROM leave_requests WHERE company_id=? AND status='pending'",
              )
              .get(companyId)
          ).n,
          taken_this_year: await db
            .prepare(
              `SELECT t.name,COUNT(*)*0.5 days FROM leave_days d JOIN leave_requests r ON r.id=d.request_id JOIN leave_types t ON t.id=r.leave_type_id
               WHERE r.company_id=? AND r.status='approved' AND substr(d.day,1,4)=? GROUP BY t.name ORDER BY days DESC LIMIT 8`,
            )
            .all(companyId, year),
        },
        recruitment: {
          open_positions: (
            await db
              .prepare(
                "SELECT COALESCE(SUM(positions),0) n FROM job_openings WHERE company_id=? AND status='open'",
              )
              .get(companyId)
          ).n,
          stages: Object.fromEntries(
            (
              await db
                .prepare(
                  "SELECT stage,COUNT(*) n FROM candidates WHERE company_id=? GROUP BY stage",
                )
                .all(companyId)
            ).map((r) => [r.stage, r.n]),
          ),
        },
        helpdesk: {
          open: (
            await db
              .prepare(
                "SELECT COUNT(*) n FROM tickets WHERE company_id=? AND status IN ('open','in_progress')",
              )
              .get(companyId)
          ).n,
        },
      };
      if (can(user, "payroll.read"))
        out.payroll = (
          await db
            .prepare(
              `SELECT r.month,r.status,COALESCE(SUM(i.gross),0) gross,COALESCE(SUM(i.net),0) net,COALESCE(SUM(i.employer_cost),0) employer_cost,COUNT(i.id) employees
               FROM payroll_runs r LEFT JOIN payroll_items i ON i.run_id=r.id WHERE r.company_id=? AND r.status IN ('approved','paid')
               GROUP BY r.month,r.status ORDER BY r.month DESC LIMIT 6`,
            )
            .all(companyId)
        ).reverse();
      return send(200, out);
    },
  );
}
