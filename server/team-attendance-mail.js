import { computeMuster } from "./muster.js";
import { csvCell } from "./http.js";

// Team Attendance Details: every working day, at the time set under Leave settings (11:00 by
// default), each supervisor is told which of the people reporting to them are late, on leave or
// have not punched in. Nothing is sent to a supervisor when everyone is on time.
const STATUS = { late: "Late", leave: "On leave", half: "Half-day leave", missing: "Not punched in" };
const ORDER = ["late", "missing", "leave", "half"];
// A server that was asleep at the set time still sends late, but not hours later.
const SEND_WINDOW_MINUTES = 180;
const COLUMNS = ["Employee Code", "Employee Name", "Branch", "Designation", "Supervisor", "SLM", "Attendance Date", "Status", "Time In", "OD Time In"];

const minutesOf = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const showDate = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
const fileName = (name, day) => `Attendance_${name.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_|_$/g, "")}_${day.replaceAll("-", "")}.csv`;

function clockOf(app) {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: app.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return (ms) => f.format(new Date(ms));
}

/** One row for each person who is late, on leave or missing today, with their supervisor. */
export async function teamAttendanceRows(app, companyId, day, nowMs) {
  const { db } = app;
  const time = clockOf(app);
  const people = await db
    .prepare(
      `SELECT u.*,b.name branch,g.name designation,
              m.name manager_name,m.employee_code manager_code,m.email manager_email,
              s.name slm_name,s.employee_code slm_code
       FROM users u JOIN users m ON m.id=u.manager_id AND m.active=1
       LEFT JOIN users s ON s.id=m.manager_id
       LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN designations g ON g.id=u.designation_id
       WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' AND (u.date_of_joining IS NULL OR u.date_of_joining<=?)`,
    )
    .all(companyId, day);
  if (!people.length) return [];
  const ids = people.map((p) => p.id);
  const inIds = `(${ids.map(() => "?").join(",")})`;
  const muster = await computeMuster(app, { companyId, month: day.slice(0, 7), userIds: ids });
  const statusOf = new Map(muster.people.map((p) => [p.user_id, p.days.find((d) => d.date === day)?.status]));
  // The first punch of the day decides lateness.
  const day0 = new Date(Date.parse(day) - 86400000).toISOString();
  const day2 = new Date(Date.parse(day) + 2 * 86400000).toISOString();
  const shifts = new Map();
  for (const s of await db
    .prepare(`SELECT user_id,in_at,half_day_reasons FROM shifts WHERE user_id IN ${inIds} AND in_at>=? AND in_at<? ORDER BY in_at DESC`)
    .all(...ids, day0, day2))
    if (app.dayOf(s.in_at) === day) shifts.set(s.user_id, s);
  const od = new Map();
  for (const v of await db
    .prepare(`SELECT user_id,out_at FROM od_visits WHERE user_id IN ${inIds} AND out_at>=? AND out_at<? ORDER BY out_at DESC`)
    .all(...ids, day0, day2))
    if (app.dayOf(v.out_at) === day) od.set(v.user_id, v.out_at);
  // On duty, working from home or on approved short leave: not expected at the punch machine.
  const excused = new Set(
    (
      await db
        .prepare(`SELECT user_id FROM regularizations WHERE user_id IN ${inIds} AND date=? AND status='approved' AND kind IN ('on_duty','work_from_home','short_leave')`)
        .all(...ids, day)
    ).map((r) => r.user_id),
  );
  const nowMinutes = minutesOf(time(nowMs));
  const rows = [];
  for (const p of people) {
    const shift = shifts.get(p.id);
    const status = statusOf.get(p.id);
    let kind = null;
    if (shift && !excused.has(p.id) && JSON.parse(shift.half_day_reasons || "[]").includes("late_in")) kind = "late";
    else if (status === "leave") kind = "leave";
    else if (status === "half_leave" || status === "half_day_and_leave") kind = "half";
    else if (status === "pending" && !excused.has(p.id) && !od.has(p.id)) {
      const policy = await app.policyFor(p, day);
      if (nowMinutes > policy.startMinutes + policy.graceMinutes) kind = "missing";
    }
    if (kind)
      rows.push({
        manager_id: p.manager_id,
        manager_name: p.manager_name,
        manager_code: p.manager_code,
        manager_email: p.manager_email,
        slm: p.slm_name ? [p.slm_code, p.slm_name].filter(Boolean).join(" - ") : "",
        code: p.employee_code ?? "",
        name: p.name,
        branch: p.branch ?? "",
        designation: p.designation ?? "",
        kind,
        time_in: shift ? time(Date.parse(shift.in_at)) : "",
        od_in: od.has(p.id) ? time(Date.parse(od.get(p.id))) : "",
      });
  }
  return rows;
}

function mailBody(manager, items, day, at) {
  const lines = [`Dear ${manager},`, "", `Attendance of your team on ${showDate(day)}, as of ${at}:`];
  for (const kind of ORDER) {
    const group = items.filter((i) => i.kind === kind);
    if (!group.length) continue;
    lines.push("", `${STATUS[kind]} (${group.length})`);
    for (const i of group) lines.push(`- ${i.name}${i.code ? ` (${i.code})` : ""}${i.time_in ? `, in at ${i.time_in}` : ""}`);
  }
  lines.push("", "The attached spreadsheet has the detail.", "", "This is an automatic message from the HRMS. Please do not reply.");
  return lines.join("\n");
}

function teamCsv(items, day) {
  const supervisor = (i) => [i.manager_code, i.manager_name].filter(Boolean).join(" - ");
  const rows = items.map((i) => [i.code, i.name, i.branch, i.designation, supervisor(i), i.slm, showDate(day), STATUS[i.kind], i.time_in, i.od_in]);
  return [COLUMNS, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
}

/** Sends today's mail to every supervisor who has not had it. Returns how many were told. */
export async function sendTeamAttendanceMails(app) {
  const { db } = app;
  const nowMs = app.clock();
  const nowIso = new Date(nowMs).toISOString();
  const day = app.dayOf(nowIso);
  const at = clockOf(app)(nowMs);
  let sent = 0;
  for (const c of await db.prepare("SELECT id,team_mail_time FROM companies WHERE active=1 AND team_mail_enabled=1").all()) {
    const after = minutesOf(at) - minutesOf(c.team_mail_time);
    if (after < 0 || after > SEND_WINDOW_MINUTES) continue;
    const byManager = new Map();
    for (const r of await teamAttendanceRows(app, c.id, day, nowMs)) {
      if (!byManager.has(r.manager_id)) byManager.set(r.manager_id, []);
      byManager.get(r.manager_id).push(r);
    }
    for (const [managerId, items] of byManager) {
      items.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
      // Claimed first, so a restart or a second server can never send it twice.
      const claimed = await db
        .prepare("INSERT INTO team_attendance_mail_log(company_id,manager_id,day,people,created_at) VALUES(?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING manager_id")
        .get(c.id, managerId, day, items.length, nowIso);
      if (!claimed) continue;
      const count = (k) => items.filter((i) => i.kind === k).length;
      const summary = [
        count("late") && `${count("late")} late`,
        count("missing") && `${count("missing")} not punched in`,
        count("leave") + count("half") && `${count("leave") + count("half")} on leave`,
      ]
        .filter(Boolean)
        .join(", ");
      await app.notify([managerId], { companyId: c.id, kind: "attendance", title: `Your team today: ${summary}`, link: "team" });
      const subject = `Team Attendance Details - ${showDate(day)}`;
      await app.notify.mail(c.id, items[0].manager_email, subject, mailBody(items[0].manager_name, items, day, at), [
        { filename: fileName(items[0].manager_name, day), content: Buffer.from(teamCsv(items, day)).toString("base64") },
      ]);
      sent++;
    }
  }
  return sent;
}

export function scheduleTeamAttendanceMails(app) {
  const run = () => sendTeamAttendanceMails(app).catch((e) => console.error("Team attendance mail failed:", e.message));
  setInterval(run, 5 * 60000).unref();
}
