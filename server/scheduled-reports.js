import { HttpError, csvCell, integer, oneOf } from "./http.js";

// Reports emailed on a schedule: HR picks a report, how often, and who receives it.
// An hourly job sends each one once on its day, after 8 in the morning.
export const REPORTS = {
  command_centre: "HR Command Centre summary",
  attendance_leave: "Attendance and leave today",
};
const FREQUENCIES = ["daily", "weekly", "monthly"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

async function summary(app, companyId, report, today) {
  const { db } = app;
  const one = async (sql, ...p) => Number((await db.prepare(sql).get(...p))?.n ?? 0);
  const staff = "company_id=? AND active=1 AND role<>'super_admin'";
  const present = await one(
    "SELECT COUNT(DISTINCT s.user_id) n FROM shifts s JOIN users u ON u.id=s.user_id WHERE u.company_id=? AND substr(s.in_at,1,10)=?",
    companyId,
    today,
  );
  const onLeave = await one(
    "SELECT COUNT(DISTINCT d.user_id) n FROM leave_days d JOIN leave_requests r ON r.id=d.request_id WHERE r.company_id=? AND r.status='approved' AND d.day=?",
    companyId,
    today,
  );
  const pending = await one(
    "SELECT COUNT(*) n FROM leave_requests WHERE company_id=? AND status='pending'",
    companyId,
  );
  const headcount = await one(`SELECT COUNT(*) n FROM users WHERE ${staff}`, companyId);
  if (report === "attendance_leave")
    return [
      `Attendance and leave, ${today}`,
      `Present so far: ${present} of ${headcount}`,
      `On approved leave: ${onLeave}`,
      `Leave requests waiting for approval: ${pending}`,
    ];
  const month = today.slice(0, 7);
  const joined = await one(
    `SELECT COUNT(*) n FROM users WHERE company_id=? AND role<>'super_admin' AND substr(date_of_joining,1,7)=?`,
    companyId,
    month,
  );
  const left = await one(
    `SELECT COUNT(*) n FROM users WHERE company_id=? AND role<>'super_admin' AND substr(exit_date,1,7)=?`,
    companyId,
    month,
  );
  const open = await one(
    "SELECT COALESCE(SUM(positions),0) n FROM job_openings WHERE company_id=? AND status='open'",
    companyId,
  );
  return [
    `HR Command Centre, ${today}`,
    `Headcount: ${headcount}`,
    `Joined this month: ${joined} · Left this month: ${left} · Monthly attrition: ${headcount ? Math.round((left / headcount) * 1000) / 10 : 0}%`,
    `Open positions: ${open}`,
    `Present today: ${present} · On leave today: ${onLeave}`,
    `Leave requests waiting for approval: ${pending}`,
  ];
}

// The spreadsheet sent with each report: the summary lines, then the detail behind them.
export async function reportCsv(app, companyId, report, today, lines) {
  const { db } = app;
  const rows = [["Report", lines[0]], ...lines.slice(1).map((l) => ["", l]), []];
  if (report === "attendance_leave") {
    rows.push(["Employee code", "Name", "Department", "Today"]);
    const people = await db
      .prepare(
        `SELECT u.employee_code,u.name,d.name department,
           (SELECT MIN(s.in_at) FROM shifts s WHERE s.user_id=u.id AND substr(s.in_at,1,10)=?) first_in,
           (SELECT t.name FROM leave_days x JOIN leave_requests r ON r.id=x.request_id JOIN leave_types t ON t.id=r.leave_type_id
              WHERE x.user_id=u.id AND x.day=? AND r.status='approved' LIMIT 1) leave_type
         FROM users u LEFT JOIN departments d ON d.id=u.department_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' ORDER BY d.name,u.name`,
      )
      .all(today, today, companyId);
    for (const p of people)
      rows.push([
        p.employee_code,
        p.name,
        p.department,
        p.first_in
          ? `Present from ${new Intl.DateTimeFormat("en-IN", { timeZone: app.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(p.first_in))}`
          : p.leave_type
            ? `On leave: ${p.leave_type}`
            : "Not punched in",
      ]);
  } else {
    rows.push(["Department", "Headcount"]);
    for (const d of await db
      .prepare(
        `SELECT COALESCE(d.name,'No department') name,COUNT(*) n FROM users u LEFT JOIN departments d ON d.id=u.department_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' GROUP BY 1 ORDER BY 2 DESC`,
      )
      .all(companyId))
      rows.push([d.name, d.n]);
  }
  return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
}

const due = (s, today) => {
  if (s.last_sent_on === today) return false;
  const d = new Date(`${today}T00:00:00Z`);
  if (s.frequency === "weekly") return d.getUTCDay() === s.day;
  if (s.frequency === "monthly") {
    // A day past the month's end (say 31) falls on its last day.
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    return d.getUTCDate() === Math.min(s.day, last);
  }
  return true;
};

export async function sendScheduledReports(app) {
  const now = new Date(app.clock());
  const today = app.dayOf(now.toISOString());
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone: app.timezone, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  if (hour < 8) return 0;
  const rows = await app.db
    .prepare(
      "SELECT s.* FROM report_schedules s JOIN companies c ON c.id=s.company_id WHERE c.active=1",
    )
    .all();
  let sent = 0;
  for (const s of rows) {
    if (!due(s, today)) continue;
    const lines = await summary(app, s.company_id, s.report, today);
    const to = JSON.parse(s.recipients);
    await app.notify(to, {
      companyId: s.company_id,
      kind: "report",
      title: lines[0],
      body: lines.slice(1).join("\n"),
      link: "commandcentre",
    });
    // The email carries the same summary and a spreadsheet with the detail.
    const csv = await reportCsv(app, s.company_id, s.report, today, lines);
    for (const id of to) {
      const u = await app.db
        .prepare("SELECT email FROM users WHERE id=? AND active=1")
        .get(id);
      if (u?.email)
        await app.notify.mail(
          s.company_id,
          u.email,
          lines[0],
          `${lines.slice(1).join("\n")}\n\nThe attached spreadsheet has the detail.`,
          [
            {
              filename: `${s.report}-${today}.csv`,
              content: Buffer.from(csv).toString("base64"),
            },
          ],
        );
    }
    await app.db
      .prepare("UPDATE report_schedules SET last_sent_on=? WHERE id=?")
      .run(today, s.id);
    sent += 1;
  }
  return sent;
}
export function scheduleReports(app) {
  const run = () =>
    sendScheduledReports(app).catch((e) =>
      console.error("Scheduled reports failed:", e.message),
    );
  void run();
  setInterval(run, 3600000).unref();
}

export function registerScheduledReports(router, app) {
  const { db } = app;
  router.get(
    "/api/admin/report-schedules",
    { perm: "insights.read" },
    async ({ companyId, send }) =>
      send(200, {
        reports: REPORTS,
        weekdays: WEEKDAYS,
        items: (
          await db
            .prepare("SELECT * FROM report_schedules WHERE company_id=? ORDER BY id")
            .all(companyId)
        ).map((s) => ({ ...s, recipients: JSON.parse(s.recipients) })),
      }),
  );
  router.post(
    "/api/admin/report-schedules",
    { perm: "insights.read" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const report = oneOf(b.report, "Report", Object.keys(REPORTS));
      const frequency = oneOf(b.frequency, "Frequency", FREQUENCIES);
      const day =
        frequency === "daily"
          ? 0
          : integer(Number(b.day ?? (frequency === "weekly" ? 1 : 1)));
      if (frequency === "weekly" && (day < 0 || day > 6))
        throw new HttpError(400, "Choose a weekday.");
      if (frequency === "monthly" && (day < 1 || day > 31))
        throw new HttpError(400, "Choose a day of the month from 1 to 31.");
      const ids = [
        ...new Set(
          (Array.isArray(b.recipients) && b.recipients.length ? b.recipients : [user.id]).map((x) =>
            integer(Number(x)),
          ),
        ),
      ];
      for (const id of ids)
        if (
          !(await db
            .prepare("SELECT id FROM users WHERE id=? AND company_id=? AND active=1")
            .get(id, companyId))
        )
          throw new HttpError(400, "Choose people from your company.");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO report_schedules(company_id,report,frequency,day,recipients,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(companyId, report, frequency, day, JSON.stringify(ids), user.id, new Date(app.clock()).toISOString())
        ).lastInsertRowid,
      );
      await audit("report_scheduled", { id, report, frequency });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/report-schedules/:id",
    { perm: "insights.read" },
    async ({ params, companyId, send, audit }) => {
      const r = await db
        .prepare("DELETE FROM report_schedules WHERE id=? AND company_id=?")
        .run(integer(Number(params.id)), companyId);
      if (!r.changes) throw new HttpError(404, "Schedule not found.");
      await audit("report_unscheduled", { id: Number(params.id) });
      return send(200, { ok: true });
    },
  );
}
