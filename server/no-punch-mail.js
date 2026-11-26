import { computeMuster } from "./muster.js";
import { staffWith } from "./scope.js";

// Someone who has not punched (and has no leave, holiday, weekly off or approved on-duty/work
// from home) for the company's number of working days in a row, up to yesterday, gets a mail;
// so do their manager and HR. Each run of missed days is mailed once.
const DAY = 86400000;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const LOOKBACK = 31;

export async function sendNoPunchMails(app) {
  const { db } = app;
  const today = app.dayOf(new Date(app.clock()).toISOString());
  const yesterday = addDays(today, -1);
  const from = addDays(yesterday, -(LOOKBACK - 1));
  let sent = 0;
  for (const c of await db.prepare("SELECT id,no_punch_mail_days n FROM companies WHERE no_punch_mail_days>0").all()) {
    const months = [...new Set([from.slice(0, 7), yesterday.slice(0, 7)])];
    const byUser = new Map();
    for (const month of months)
      for (const p of (await computeMuster(app, { companyId: c.id, month })).people)
        byUser.set(p.user_id, [...(byUser.get(p.user_id) ?? []), ...p.days.filter((d) => d.date >= from && d.date <= yesterday)]);
    if (!byUser.size) continue;
    const ids = [...byUser.keys()];
    const inIds = `(${ids.map(() => "?").join(",")})`;
    // Days excused by an approved on-duty, work-from-home or short-leave request, or a field visit.
    const excused = new Set(
      (
        await db
          .prepare(`SELECT user_id,date FROM regularizations WHERE user_id IN ${inIds} AND date>=? AND date<=? AND status='approved' AND kind IN ('on_duty','work_from_home','short_leave')`)
          .all(...ids, from, yesterday)
      ).map((r) => `${r.user_id}|${r.date}`),
    );
    for (const v of await db
      .prepare(`SELECT user_id,out_at FROM od_visits WHERE user_id IN ${inIds} AND out_at>=?`)
      .all(...ids, new Date(Date.parse(`${from}T00:00:00Z`) - DAY).toISOString()))
      excused.add(`${v.user_id}|${app.dayOf(v.out_at)}`);
    const hr = (await staffWith(db, c.id, ["attendance.import", "employees.write"])).map((p) => p.id);
    for (const [userId, days] of byUser) {
      // Walk back from yesterday over working days: count the run of missed ones.
      days.sort((a, b) => (a.date < b.date ? 1 : -1));
      let run = 0;
      let start = null;
      for (const d of days) {
        if (["weekly_off", "holiday"].includes(d.status)) continue;
        if (d.status === "absent" && !excused.has(`${userId}|${d.date}`)) {
          run += 1;
          start = d.date;
        } else break;
      }
      if (run < c.n) continue;
      const done = await db.prepare("SELECT 1 FROM no_punch_alerts WHERE user_id=? AND streak_from=?").get(userId, start);
      if (done) continue;
      const u = await db.prepare("SELECT id,name,employee_code,manager_id FROM users WHERE id=?").get(userId);
      const who = `${u.name}${u.employee_code ? ` (${u.employee_code})` : ""}`;
      await db
        .prepare("INSERT INTO no_punch_alerts(user_id,streak_from,days,created_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING")
        .run(userId, start, run, new Date(app.clock()).toISOString());
      await app.notify([u.id], {
        companyId: c.id,
        kind: "attendance",
        title: `No attendance for ${run} working days`,
        body: `We have no punch or approved leave for you since ${start}. Please punch in, or apply for leave or a correction for the missed days. If something is wrong, contact HR.`,
        link: "attendance",
        email: true,
      });
      const others = [...new Set([u.manager_id, ...hr].filter((id) => id && id !== u.id))];
      if (others.length)
        await app.notify(others, {
          companyId: c.id,
          kind: "attendance",
          title: `${who}: no attendance for ${run} working days`,
          body: `${who} has not punched in and has no approved leave since ${start} (${run} working days).`,
          link: "muster",
          email: true,
        });
      await app.audit(null, "no_punch_mail", { employeeId: u.id, from: start, days: run }, c.id);
      sent += 1;
    }
  }
  return sent;
}
export function scheduleNoPunchMails(app) {
  const run = () => sendNoPunchMails(app).catch((e) => console.error("No-punch mail failed:", e.message));
  void run();
  setInterval(run, 3 * 3600000).unref();
}
