// Field Force: activation (Phase 1). Field staff (a per-person Field team: Collection or
// Sales) are nudged each working morning to punch in. At the reminder time anyone not yet
// punched in is asked for a reason, which they give from the phone app's Home screen. At
// the report time their manager and HR get the list of who has not started. Nobody's
// attendance or leave is changed by any of this: "activated" simply means punched in.
//
// The clock runs per company (Field Force → Activation), off until HR switches it on.
// Each step happens once per person per day, whatever the server does in between: if it was
// asleep at 8:30 the nudge still goes at wake-up, but never after the reminder time.
import { HttpError, integer, oneOf, optionalString, optionalId, isoDate } from "../http.js";
import { addDays, localToUtcMs } from "../calendar.js";
import { companySettings, dayKind } from "../leave-ledger.js";
import { TEAM_SQL } from "../attendance-report.js";
import { branchScope, staffWith } from "../scope.js";

export const TEAMS = { collection: "Collection", sales: "Sales" };
export const REASONS = {
  on_the_way: "On the way to customer / market",
  on_leave: "On leave",
  app_issue: "App or network issue",
  call_me: "Other: please call me",
};
// What a person's day looks like, for the reports.
export const STATUS = {
  on_time: "Punched in on time",
  late: "Punched in late",
  reason: "Gave a reason",
  no_reply: "Not punched in, no reason",
  waiting: "Not punched in yet",
  leave: "On leave",
  od: "On duty / work from home",
  off: "Not a working day",
};
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const localTime = (ms, tz) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms));

const DEFAULT_CLOCK = {
  on: false,
  nudge: "08:30",
  remind: "10:00",
  report: "12:30",
  whatsapp: false,
  wa_nudge_template: "ff_morning_activation",
  wa_remind_template: "ff_activation_reason",
  wa_language: "en",
  ivr: null,
  ai: null,
};
export async function clockOf(db, companyId) {
  const c = await db.prepare("SELECT * FROM ff_settings WHERE company_id=?").get(companyId);
  if (!c) return { ...DEFAULT_CLOCK };
  return {
    on: Boolean(c.active),
    nudge: c.nudge_at,
    remind: c.remind_at,
    report: c.report_at,
    whatsapp: Boolean(c.whatsapp),
    wa_nudge_template: c.wa_nudge_template,
    wa_remind_template: c.wa_remind_template,
    wa_language: c.wa_language,
    ivr: c.ivr_at ?? null,
    ai: c.ai_at ?? null,
  };
}
// A reason given by the person (app, WhatsApp button, or a key pressed on a call). The latest
// answer counts. `via` says where it came from, for the audit trail.
export async function recordReason(db, { companyId, userId, day, reason, note = null, via, at }) {
  await db
    .prepare(
      `INSERT INTO ff_days(company_id,user_id,day,reason,reason_note,reason_at,reason_via) VALUES(?,?,?,?,?,?,?)
       ON CONFLICT (user_id,day) DO UPDATE SET reason=EXCLUDED.reason,reason_note=EXCLUDED.reason_note,reason_at=EXCLUDED.reason_at,reason_via=EXCLUDED.reason_via`,
    )
    .run(companyId, userId, day, reason, note, at, via);
}
// The person's team, or null when they are not field staff.
export async function teamOf(db, userId) {
  return (await db.prepare("SELECT team FROM ff_staff WHERE user_id=?").get(userId))?.team ?? null;
}

// Every field person's day: whether it is a working day for them, when they first punched
// in, and what they told us. `only` narrows to some people (a manager's team, one person).
export async function dayStatus(app, companyId, day, { only = null, team = null, branchId = null, scope = null } = {}) {
  const { db, timezone } = app;
  const times = await clockOf(db, companyId);
  const settings = await companySettings(db, companyId);
  const filters = [];
  const params = [companyId];
  if (only) {
    if (!only.length) return { times, people: [] };
    filters.push(` AND u.id IN (${only.map(() => "?").join(",")})`);
    params.push(...only);
  }
  if (team) filters.push(" AND f.team=?"), params.push(team);
  if (branchId) filters.push(" AND u.branch_id=?"), params.push(branchId);
  if (scope?.sql) filters.push(scope.sql), params.push(...scope.params);
  const people = await db
    .prepare(
      `SELECT u.id,u.name,u.employee_code,u.phone,f.team field_team,u.branch_id,b.name branch_name,u.manager_id,m.name manager_name,u.date_of_joining
       FROM ff_staff f JOIN users u ON u.id=f.user_id LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN users m ON m.id=u.manager_id
       WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin'${filters.join("")}
       ORDER BY b.name,u.name,u.id`,
    )
    .all(...params);
  if (!people.length) return { times, people: [] };
  const ids = people.map((p) => p.id);
  const inIds = `(${ids.map(() => "?").join(",")})`;
  const from = new Date(localToUtcMs(day, "00:00", timezone)).toISOString();
  const to = new Date(localToUtcMs(addDays(day, 1), "00:00", timezone)).toISOString();
  const [holidays, chosen, roster, leave, onDuty, punches, log, contacts] = await Promise.all([
    db
      .prepare("SELECT branch_id FROM holidays WHERE company_id=? AND date=? AND optional=0")
      .all(companyId, day),
    db
      .prepare(`SELECT user_id FROM optional_holiday_choices WHERE status='approved' AND date=? AND user_id IN ${inIds}`)
      .all(day, ...ids),
    db.prepare(`SELECT user_id,off FROM roster_entries WHERE date=? AND user_id IN ${inIds}`).all(day, ...ids),
    // Leave in the morning (a second-half leave still starts the day).
    db.prepare(`SELECT user_id FROM leave_days WHERE day=? AND session='first' AND user_id IN ${inIds}`).all(day, ...ids),
    db
      .prepare(
        `SELECT user_id FROM regularizations WHERE date=? AND kind IN ('on_duty','work_from_home') AND status IN ('pending','approved') AND user_id IN ${inIds}`,
      )
      .all(day, ...ids),
    db
      .prepare(`SELECT user_id,MIN(in_at) first_in FROM shifts WHERE in_at>=? AND in_at<? AND user_id IN ${inIds} GROUP BY user_id`)
      .all(from, to, ...ids),
    db.prepare(`SELECT * FROM ff_days WHERE day=? AND user_id IN ${inIds}`).all(day, ...ids),
    db
      .prepare(`SELECT user_id,channel,step,status,reason,created_at FROM ff_contacts WHERE day=? AND user_id IN ${inIds} ORDER BY id`)
      .all(day, ...ids),
  ]);
  const contactsOf = new Map();
  for (const c of contacts) contactsOf.set(c.user_id, [...(contactsOf.get(c.user_id) ?? []), c]);
  const companyHoliday = holidays.some((h) => h.branch_id === null);
  const branchHolidays = new Set(holidays.filter((h) => h.branch_id !== null).map((h) => h.branch_id));
  const chose = new Set(chosen.map((r) => r.user_id));
  const rest = new Map(roster.map((r) => [r.user_id, Boolean(r.off)]));
  const onLeave = new Set(leave.map((r) => r.user_id));
  const od = new Set(onDuty.map((r) => r.user_id));
  const firstIn = new Map(punches.map((r) => [r.user_id, r.first_in]));
  const entries = new Map(log.map((r) => [r.user_id, r]));
  const now = app.clock();
  const today = app.dayOf(new Date(now).toISOString());
  const beforeReminder = day > today || (day === today && localTime(now, timezone) < times.remind);
  const remindMs = localToUtcMs(day, times.remind, timezone);
  return {
    times,
    people: people.map((p) => {
      const e = entries.get(p.id);
      const first = firstIn.get(p.id) ?? null;
      const rostered = rest.get(p.id);
      const notWorking =
        day < settings.attendanceStart ||
        (p.date_of_joining && day < p.date_of_joining) ||
        rostered === true ||
        (rostered === undefined &&
          (companyHoliday || branchHolidays.has(p.branch_id) || chose.has(p.id) || dayKind(day, settings, new Map()) !== null));
      const status = first
        ? Date.parse(first) <= remindMs
          ? "on_time"
          : "late"
        : notWorking
          ? "off"
          : onLeave.has(p.id)
            ? "leave"
            : od.has(p.id)
              ? "od"
              : e?.reason
                ? "reason"
                : beforeReminder
                  ? "waiting"
                  : "no_reply";
      const { date_of_joining, ...person } = p;
      return {
        ...person,
        status,
        first_in: first,
        reason: e?.reason ?? null,
        reason_note: e?.reason_note ?? null,
        reason_at: e?.reason_at ?? null,
        reason_via: e?.reason_via ?? null,
        nudged_at: e?.nudged_at ?? null,
        reminded_at: e?.reminded_at ?? null,
        // WhatsApp messages and calls, oldest first.
        contacts: (contactsOf.get(p.id) ?? []).map(({ user_id, ...c }) => c),
      };
    }),
  };
}
// Still to start today: a working day, not punched in, not on leave or OD.
export const pending = (p) => ["waiting", "no_reply", "reason"].includes(p.status);

// Marks a step for these people once; answers with those it was newly marked for.
async function mark(db, companyId, day, column, ids, at) {
  if (!ids.length) return [];
  const rows = await db
    .prepare(
      `INSERT INTO ff_days(company_id,user_id,day,${column}) VALUES ${ids.map(() => "(?,?,?,?)").join(",")}
       ON CONFLICT (user_id,day) DO UPDATE SET ${column}=EXCLUDED.${column} WHERE ff_days.${column} IS NULL
       RETURNING user_id`,
    )
    .all(...ids.flatMap((id) => [companyId, id, day, at]));
  return rows.map((r) => r.user_id);
}

const names = (list, max = 25) =>
  list.length
    ? list
        .slice(0, max)
        .map((p) => `${p.name}${p.employee_code ? ` (${p.employee_code})` : ""}${p.branch_name ? `, ${p.branch_name}` : ""}`)
        .join("; ") + (list.length > max ? `; and ${list.length - max} more` : "")
    : "";
function reportText(list) {
  const group = (title, rows) => (rows.length ? `${title} (${rows.length}): ${names(rows)}.` : "");
  const by = (reason) => list.filter((p) => p.status === "reason" && p.reason === reason);
  return [
    group("Not punched in and no reason given", list.filter((p) => p.status === "no_reply")),
    group("Said they are on the way, not punched in yet", by("on_the_way")),
    group("Said they are on leave, but no leave is applied", by("on_leave")),
    group("App or network issue", by("app_issue")),
    group("Asked to be called", by("call_me")),
  ]
    .filter(Boolean)
    .join("\n");
}

// One pass of the morning clock for every company that has it switched on.
// Answers with what it sent ({ companyId, day, step, people }), so the module can follow
// the phone notification with WhatsApp (see index.js).
export async function runActivation(app) {
  const { db, timezone } = app;
  const events = [];
  const now = app.clock();
  const at = new Date(now).toISOString();
  const day = app.dayOf(at);
  const hhmm = localTime(now, timezone);
  const companies = await db
    .prepare("SELECT c.id FROM ff_settings s JOIN companies c ON c.id=s.company_id WHERE c.active=1 AND s.active=1")
    .all();
  for (const { id: companyId } of companies) {
    const times = await clockOf(db, companyId);
    if (hhmm < times.nudge) continue;
    const { people } = await dayStatus(app, companyId, day);
    const due = people.filter(pending);
    if (hhmm < times.remind) {
      const ids = await mark(db, companyId, day, "nudged_at", due.filter((p) => !p.nudged_at).map((p) => p.id), at);
      if (ids.length) events.push({ companyId, day, step: "nudge", people: due.filter((p) => ids.includes(p.id)) });
      if (ids.length)
        await app.notify(ids, {
          companyId,
          kind: "activation",
          title: "Good morning! Please punch in to start your day",
          body: "Open the app and punch in. If you cannot start yet, tell us why on the Home screen.",
          link: "myattendance",
        });
    } else if (hhmm < times.report) {
      const ids = await mark(db, companyId, day, "reminded_at", due.filter((p) => !p.reason && !p.reminded_at).map((p) => p.id), at);
      if (ids.length) events.push({ companyId, day, step: "remind", people: due.filter((p) => ids.includes(p.id)) });
      if (ids.length)
        await app.notify(ids, {
          companyId,
          kind: "activation",
          title: "You have not punched in yet",
          body: "Please punch in, or open the app and tell us why: on the way, on leave, app issue, or call me.",
          link: "myattendance",
        });
    } else {
      const fresh = await db
        .prepare("INSERT INTO ff_reports(company_id,day,sent_at) VALUES(?,?,?) ON CONFLICT DO NOTHING RETURNING day")
        .get(companyId, day, at);
      if (!fresh) continue;
      await mark(db, companyId, day, "reported_at", due.map((p) => p.id), at);
      if (!due.length) continue;
      // Each manager hears about their own people; HR gets everyone.
      const byManager = new Map();
      for (const p of due) if (p.manager_id) byManager.set(p.manager_id, [...(byManager.get(p.manager_id) ?? []), p]);
      for (const [managerId, list] of byManager)
        await app.notify([managerId], {
          companyId,
          kind: "activation",
          title: `${list.length} of your field team ${list.length === 1 ? "has" : "have"} not punched in today`,
          body: reportText(list),
          link: "fieldforce",
          email: true,
        });
      const hr = (await staffWith(db, companyId, ["attendance.read"])).map((r) => r.id);
      if (hr.length)
        await app.notify(hr, {
          companyId,
          kind: "activation",
          title: `Field activation ${day}: ${due.length} not punched in by ${times.report}`,
          body: reportText(due),
          link: "fieldforce",
          email: true,
        });
    }
  }
  return events;
}


const summary = (people) => {
  const counts = Object.fromEntries(Object.keys(STATUS).map((k) => [k, 0]));
  const reasons = Object.fromEntries(Object.keys(REASONS).map((k) => [k, 0]));
  for (const p of people) {
    counts[p.status]++;
    if (p.status === "reason") reasons[p.reason]++;
  }
  return { counts, reasons, total: people.length };
};
const withLabels = (people) =>
  people.map((p) => ({
    ...p,
    team_label: TEAMS[p.field_team],
    status_label: STATUS[p.status],
    reason_label: p.reason ? REASONS[p.reason] : null,
  }));

export function registerActivation(router, app) {
  const { db } = app;
  const today = () => app.dayOf(new Date(app.clock()).toISOString());
  const dateOf = (query) => (query.get("date") ? isoDate(query.get("date"), "Date") : today());

  // ---- the person's own morning (phone app Home screen) ------------------------------------
  const mine = async (user) => {
    const fieldTeam = await teamOf(db, user.id);
    if (!fieldTeam) return { field_team: null, show: false };
    const day = today();
    const { times, people } = await dayStatus(app, user.company_id, day, { only: [user.id] });
    const p = people[0];
    const started = times.on && localTime(app.clock(), app.timezone) >= times.nudge;
    return {
      field_team: fieldTeam,
      day,
      status: p?.status ?? "off",
      // The reason card shows from the morning nudge until they punch in.
      show: Boolean(started && p && pending(p)),
      reason: p?.reason ?? null,
      reason_label: p?.reason ? REASONS[p.reason] : null,
      reason_at: p?.reason_at ?? null,
      reasons: Object.entries(REASONS).map(([value, label]) => ({ value, label })),
    };
  };
  router.get("/api/field-force/today", async ({ user, send }) => send(200, await mine(user)));
  router.post("/api/field-force/reason", { lane: "self" }, async ({ user, body, send, audit }) => {
    const b = await body();
    const reason = oneOf(b.reason, "Reason", Object.keys(REASONS));
    const note = optionalString(b.note, "Note", 300);
    if (!(await teamOf(db, user.id))) throw new HttpError(403, "This is for field staff.");
    const day = today();
    const { people } = await dayStatus(app, user.company_id, day, { only: [user.id] });
    const p = people[0];
    if (p.status === "on_time" || p.status === "late") throw new HttpError(409, "You have already punched in today.");
    if (!pending(p)) throw new HttpError(409, "Today is not a working day for you, or you are already on leave or on duty.");
    const at = new Date(app.clock()).toISOString();
    await recordReason(db, { companyId: user.company_id, userId: user.id, day, reason, note, via: "app", at });
    await audit("activation_reason_given", { day, reason });
    // "Call me" is passed on at once: to the manager, or HR when there is none.
    if (reason === "call_me") {
      const to = user.manager_id ? [user.manager_id] : (await staffWith(db, user.company_id, ["attendance.read"])).map((r) => r.id);
      await app.notify(to, {
        companyId: user.company_id,
        kind: "activation",
        title: `${user.name} has not started and asked to be called`,
        body: `${note ? `"${note}" ` : ""}${user.phone ? `Phone: ${user.phone}` : ""}`.trim() || null,
        link: "fieldforce",
      });
    }
    return send(200, await mine(user));
  });

  // ---- reports: HR (everyone) and managers (their team) ---------------------------------------
  router.get("/api/field-force/day", { perm: "attendance.read" }, async ({ user, companyId, query, send }) => {
    const day = dateOf(query);
    const team = query.get("team") ? oneOf(query.get("team"), "Team", Object.keys(TEAMS)) : null;
    const branchId = optionalId(query.get("branch_id") ? Number(query.get("branch_id")) : null, "Branch");
    const { times, people } = await dayStatus(app, companyId, day, { team, branchId, scope: branchScope(user) });
    return send(200, { date: day, times, ...summary(people), people: withLabels(people) });
  });
  router.get("/api/field-force/team-day", async ({ user, query, send }) => {
    const day = dateOf(query);
    const team = (await db.prepare(TEAM_SQL).all(user.id)).map((r) => r.id);
    if (!team.length) throw new HttpError(403, "This is for managers.");
    const { times, people } = await dayStatus(app, user.company_id, day, { only: team });
    return send(200, { date: day, times, ...summary(people), people: withLabels(people) });
  });

  // ---- setup: the clock, and who is field staff -------------------------------------------------
  router.get("/api/field-force/settings", { perm: "attendance.read" }, async ({ companyId, send }) =>
    send(200, await clockOf(db, companyId)),
  );
  router.patch("/api/field-force/settings", { perm: "employees.write" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const current = await clockOf(db, companyId);
    const next = { ...current };
    if (b.on !== undefined) {
      if (typeof b.on !== "boolean") throw new HttpError(400, "On must be true or false.");
      next.on = b.on;
    }
    const time = (v) => {
      if (typeof v !== "string" || !TIME.test(v)) throw new HttpError(400, "Write times as HH:MM, for example 08:30.");
      return v;
    };
    for (const k of ["nudge", "remind", "report"]) if (b[k] !== undefined) next[k] = time(b[k]);
    // The calls are optional: blank or null means that call is not made.
    for (const k of ["ivr", "ai"]) if (b[k] !== undefined) next[k] = b[k] === null || b[k] === "" ? null : time(b[k]);
    if (b.whatsapp !== undefined) {
      if (typeof b.whatsapp !== "boolean") throw new HttpError(400, "WhatsApp must be true or false.");
      next.whatsapp = b.whatsapp;
    }
    for (const k of ["wa_nudge_template", "wa_remind_template"])
      if (b[k] !== undefined) {
        if (typeof b[k] !== "string" || !/^[a-z0-9_]{1,512}$/.test(b[k]))
          throw new HttpError(400, "WhatsApp template names use small letters, numbers and _ only, as registered with Meta.");
        next[k] = b[k];
      }
    if (b.wa_language !== undefined) {
      if (typeof b.wa_language !== "string" || !/^[a-z]{2,3}(_[A-Z]{2})?$/.test(b.wa_language))
        throw new HttpError(400, "Write the template language as Meta does, for example en or hi.");
      next.wa_language = b.wa_language;
    }
    const order = [next.nudge, next.remind, next.ivr, next.ai, next.report].filter(Boolean);
    if (order.some((t, i) => i > 0 && t <= order[i - 1]))
      throw new HttpError(400, "The times must run in order: morning message, reminder, IVR call, AI call, then report.");
    await db
      .prepare(
        `INSERT INTO ff_settings(company_id,active,nudge_at,remind_at,report_at,whatsapp,wa_nudge_template,wa_remind_template,wa_language,ivr_at,ai_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT (company_id) DO UPDATE SET active=EXCLUDED.active,nudge_at=EXCLUDED.nudge_at,remind_at=EXCLUDED.remind_at,
           report_at=EXCLUDED.report_at,whatsapp=EXCLUDED.whatsapp,wa_nudge_template=EXCLUDED.wa_nudge_template,
           wa_remind_template=EXCLUDED.wa_remind_template,wa_language=EXCLUDED.wa_language,ivr_at=EXCLUDED.ivr_at,ai_at=EXCLUDED.ai_at`,
      )
      .run(
        companyId,
        next.on ? 1 : 0,
        next.nudge,
        next.remind,
        next.report,
        next.whatsapp ? 1 : 0,
        next.wa_nudge_template,
        next.wa_remind_template,
        next.wa_language,
        next.ivr,
        next.ai,
      );
    await audit("activation_settings_updated", next);
    return send(200, next);
  });
  // Without ?q: the field staff. With ?q: up to 20 others matching, to add.
  router.get("/api/field-force/staff", { perm: "attendance.read" }, async ({ user, companyId, query, send }) => {
    const scope = branchScope(user);
    const words = String(query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 5);
    const rows = await db
      .prepare(
        `SELECT u.id,u.name,u.employee_code,f.team field_team,b.name branch_name,g.name designation_name
         FROM users u LEFT JOIN ff_staff f ON f.user_id=u.id LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN designations g ON g.id=u.designation_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' AND f.team IS ${words.length ? "NULL" : "NOT NULL"}
         ${words.map(() => " AND LOWER(CONCAT_WS(' ',u.name,u.employee_code,b.name,g.name)) LIKE ?").join("")}${scope.sql}
         ORDER BY f.team,b.name,u.name${words.length ? " LIMIT 20" : ""}`,
      )
      .all(companyId, ...words.map((w) => `%${w}%`), ...scope.params);
    return send(200, rows.map((p) => ({ ...p, team_label: TEAMS[p.field_team] ?? null })));
  });
  // Sets the team for chosen people, or for everyone active with a designation, department
  // and/or branch. team: null takes people off field staff.
  router.patch("/api/field-force/staff", { perm: "employees.write" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const team = b.team === null ? null : oneOf(b.team, "Team", Object.keys(TEAMS));
    const where = ["u.company_id=?", "u.active=1", "u.role<>'super_admin'"];
    const params = [companyId];
    if (b.user_ids !== undefined) {
      if (!Array.isArray(b.user_ids) || !b.user_ids.length || b.user_ids.length > 2000)
        throw new HttpError(400, "Choose 1 to 2,000 people.");
      const ids = [...new Set(b.user_ids.map((v) => integer(Number(v))))];
      where.push(`u.id IN (${ids.map(() => "?").join(",")})`);
      params.push(...ids);
    }
    for (const [key, column] of [["designation_id", "designation_id"], ["department_id", "department_id"], ["branch_id", "branch_id"]])
      if (b[key] !== undefined && b[key] !== null) {
        where.push(`u.${column}=?`);
        params.push(integer(Number(b[key])));
      }
    if (params.length === 1) throw new HttpError(400, "Choose people, or a designation, department or branch.");
    const scope = branchScope(user);
    const ids = (
      await db.prepare(`SELECT u.id FROM users u WHERE ${where.join(" AND ")}${scope.sql}`).all(...params, ...scope.params)
    ).map((r) => r.id);
    if (ids.length && team)
      await db
        .prepare(
          `INSERT INTO ff_staff(user_id,company_id,team,created_at) VALUES ${ids.map(() => "(?,?,?,?)").join(",")}
           ON CONFLICT (user_id) DO UPDATE SET team=EXCLUDED.team`,
        )
        .run(...ids.flatMap((id) => [id, companyId, team, new Date(app.clock()).toISOString()]));
    else if (ids.length) await db.prepare(`DELETE FROM ff_staff WHERE user_id IN (${ids.map(() => "?").join(",")})`).run(...ids);
    await audit("field_team_set", { team, count: ids.length, userIds: ids.slice(0, 200) });
    return send(200, { updated: ids.length });
  });
}
