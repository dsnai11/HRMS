// Field Force, Phase 3: where field staff are during the working day, and the no-movement
// check. Built to take as little as possible:
// - only field staff, only in companies that switch tracking on, only after the person
//   agrees on their phone (and they can withdraw), and only while they are punched in: the
//   server refuses points outside the shift, and tells the phone to stop at punch-out;
// - the phone shows a "tracking on" notification the whole time (no "allow all the time");
// - points are deleted after the company's retention period (default 90 days).
// Every `still_minutes` (default 120) the server looks at each punched-in person: if they
// moved less than `still_meters` (default 200 m), they get a nudge; if it happens again
// before they move, their manager is told too. A logged customer visit pauses the check;
// no location at all is reported as "no signal" (phone off, app closed, location off).
import { HttpError, integer, isoDate, optionalString } from "../http.js";
import { distanceMeters } from "../geo.js";
import { deviceFromHeaders } from "../devices.js";
import { TEAM_SQL } from "../attendance-report.js";
import { branchScope } from "../scope.js";
import { can } from "../rbac.js";
import { addDays } from "../calendar.js";
import { teamOf } from "./activation.js";

// Shown on the phone before anything is shared; a new version asks again.
export const CONSENT_VERSION = 1;
export const CONSENT_TEXT =
  "While you are punched in, this app shares your location with your company every few minutes, so your manager can see visits and movement during working hours. It stops when you punch out, and nothing is shared at other times. A notification stays on your phone while it is on. Your location history is kept for a limited time and then deleted. You can withdraw your agreement here at any time; your manager and HR will see that you did.";

const DEFAULTS = { tracking: false, ping_minutes: 15, still_minutes: 120, still_meters: 200, keep_days: 90 };
export async function trackingSettings(db, companyId) {
  const s = await db.prepare("SELECT * FROM ff_settings WHERE company_id=?").get(companyId);
  return s
    ? { tracking: Boolean(s.tracking), ping_minutes: s.ping_minutes, still_minutes: s.still_minutes, still_meters: s.still_meters, keep_days: s.keep_days }
    : { ...DEFAULTS };
}
const consentOf = async (db, userId) => {
  const c = await db.prepare("SELECT * FROM ff_consents WHERE user_id=?").get(userId);
  return Boolean(c && !c.withdrawn_at && c.version === CONSENT_VERSION);
};
// The shift that is open now, if any.
const openShift = (db, userId) => db.prepare("SELECT id,in_at FROM shifts WHERE user_id=? AND out_at IS NULL").get(userId);

// Should this person's phone be sending location now?
async function trackState(app, user) {
  const team = await teamOf(app.db, user.id);
  if (!team) return { field_team: null, tracking_on: false, track: false };
  const s = await trackingSettings(app.db, user.company_id);
  const consent = await consentOf(app.db, user.id);
  const shift = s.tracking ? await openShift(app.db, user.id) : null;
  return {
    field_team: team,
    tracking_on: s.tracking,
    consent,
    consent_version: CONSENT_VERSION,
    consent_text: CONSENT_TEXT,
    // Track only with the company's switch, the person's agreement and an open shift.
    track: Boolean(s.tracking && consent && shift),
    punched_in: Boolean(shift),
    ping_minutes: s.ping_minutes,
  };
}

const toIso = (v) => {
  const ms = typeof v === "number" ? v : Date.parse(String(v));
  return Number.isFinite(ms) ? ms : null;
};
const coord = (v, max) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= max;

// Keeps points that fall inside the person's shifts; answers how many were new.
async function savePoints(app, user, points, source) {
  const { db } = app;
  const now = app.clock();
  const ok = points
    .map((p) => ({ ...p, ms: toIso(p.at) }))
    .filter((p) => p.ms && p.ms <= now + 120000 && p.ms >= now - 36 * 3600000 && coord(p.latitude, 90) && coord(p.longitude, 180));
  if (!ok.length) return 0;
  const shifts = await db
    .prepare("SELECT in_at,out_at FROM shifts WHERE user_id=? AND (out_at IS NULL OR out_at>=?) AND in_at<=?")
    .all(user.id, new Date(Math.min(...ok.map((p) => p.ms))).toISOString(), new Date(Math.max(...ok.map((p) => p.ms))).toISOString());
  const inside = ok.filter((p) => shifts.some((s) => Date.parse(s.in_at) <= p.ms && (!s.out_at || p.ms <= Date.parse(s.out_at))));
  if (!inside.length) return 0;
  const rows = await db
    .prepare(
      `INSERT INTO ff_pings(company_id,user_id,day,at,latitude,longitude,accuracy,mocked,source) VALUES ${inside.map(() => "(?,?,?,?,?,?,?,?,?)").join(",")}
       ON CONFLICT (user_id,at) DO NOTHING RETURNING id`,
    )
    .all(
      ...inside.flatMap((p) => {
        const at = new Date(p.ms).toISOString();
        return [user.company_id, user.id, app.dayOf(at), at, p.latitude, p.longitude, typeof p.accuracy === "number" ? p.accuracy : null, p.mocked ? 1 : 0, source];
      }),
    );
  return rows.length;
}

// ---- the no-movement check, run every minute; acts once per person per cycle --------------------------
let lastPurgeDay = null;
export async function runTracking(app) {
  const { db } = app;
  const now = app.clock();
  const at = new Date(now).toISOString();
  const day = app.dayOf(at);
  const companies = await db
    .prepare("SELECT c.id FROM ff_settings s JOIN companies c ON c.id=s.company_id WHERE c.active=1 AND s.tracking=1")
    .all();
  for (const { id: companyId } of companies) {
    const s = await trackingSettings(db, companyId);
    if (lastPurgeDay !== day)
      await db.prepare("DELETE FROM ff_pings WHERE company_id=? AND day<?").run(companyId, addDays(day, -s.keep_days));
    const windowStart = new Date(now - s.still_minutes * 60000).toISOString();
    // Punched-in field staff who agreed (or whose tracker uploads points), in shift long enough.
    const people = await db
      .prepare(
        `SELECT u.id,u.name,u.manager_id,sh.in_at FROM ff_staff f JOIN users u ON u.id=f.user_id JOIN shifts sh ON sh.user_id=u.id AND sh.out_at IS NULL
         WHERE u.company_id=? AND u.active=1 AND sh.in_at<=?
           AND (EXISTS (SELECT 1 FROM ff_consents c WHERE c.user_id=u.id AND c.withdrawn_at IS NULL AND c.version=?)
                OR EXISTS (SELECT 1 FROM ff_pings p WHERE p.user_id=u.id AND p.day=? AND p.source='tracker'))`,
      )
      .all(companyId, windowStart, CONSENT_VERSION, day);
    for (const p of people) {
      const open = await db
        .prepare("SELECT * FROM ff_alerts WHERE user_id=? AND day=? AND closed_at IS NULL ORDER BY id DESC")
        .all(p.id, day);
      const visited = await db.prepare("SELECT 1 FROM ff_visits WHERE user_id=? AND at>=?").get(p.id, windowStart);
      const points = await db
        .prepare("SELECT latitude,longitude,at FROM ff_pings WHERE user_id=? AND at>=? AND at<=? ORDER BY at")
        .all(p.id, windowStart, at);
      const moved =
        points.length > 0 &&
        points.some((q) => distanceMeters(points[0].latitude, points[0].longitude, q.latitude, q.longitude) >= s.still_meters);
      // Moving, or at a customer: the person is fine; any open alert is closed.
      if (moved || visited) {
        if (open.length) await db.prepare("UPDATE ff_alerts SET closed_at=? WHERE user_id=? AND day=? AND closed_at IS NULL").run(at, p.id, day);
        continue;
      }
      // One alert per cycle: the last one must be a whole cycle old.
      if (open.length && open[0].at > windowStart) continue;
      const kind = points.length ? "no_movement" : "no_signal";
      const level = open.length ? "manager" : "person";
      await db
        .prepare("INSERT INTO ff_alerts(company_id,user_id,day,kind,level,since,at) VALUES(?,?,?,?,?,?,?)")
        .run(companyId, p.id, day, kind, level, open.at(-1)?.since ?? windowStart, at);
      const hours = Math.round(((now - Date.parse(open.at(-1)?.since ?? windowStart)) / 3600000) * 10) / 10;
      await app.notify([p.id], {
        companyId,
        kind: "activation",
        title: kind === "no_movement" ? `You have not moved for ${hours} hours` : `We have not received your location for ${hours} hours`,
        body:
          kind === "no_movement"
            ? "If you are with a customer, log the visit in the app. Otherwise please continue your field visits."
            : "Keep the app open in the background with location on, so your visits are recorded.",
        link: "myattendance",
      });
      if (level === "manager" && p.manager_id)
        await app.notify([p.manager_id], {
          companyId,
          kind: "activation",
          title: `${p.name}: ${kind === "no_movement" ? "no movement" : "no location"} for ${hours} hours`,
          body: "Again since the last alert, and no customer visit was logged. See Field Force → Activation.",
          link: "fieldforce",
        });
    }
  }
  lastPurgeDay = day;
}

export function registerTracking(router, app) {
  const { db } = app;
  const today = () => app.dayOf(new Date(app.clock()).toISOString());
  // Phones only, from an approved device: the same rule as punching.
  const phoneOnly = async (user, req) => {
    if (!req.headers.authorization?.startsWith("Bearer ")) throw new HttpError(403, "Only from the company app.");
    const device = await deviceFromHeaders(app, user, req);
    if (!device || device.status !== "approved") throw new HttpError(403, "This phone is not approved.");
  };

  // ---- the person's phone ------------------------------------------------------------------------------
  router.get("/api/field-force/tracking", async ({ user, send }) => send(200, await trackState(app, user)));
  router.post("/api/field-force/tracking/consent", { lane: "self" }, async ({ user, body, send, audit }) => {
    const b = await body();
    if (typeof b.agree !== "boolean") throw new HttpError(400, "Agree must be true or false.");
    if (!(await teamOf(db, user.id))) throw new HttpError(403, "This is for field staff.");
    const at = new Date(app.clock()).toISOString();
    if (b.agree)
      await db
        .prepare(
          `INSERT INTO ff_consents(user_id,company_id,version,agreed_at) VALUES(?,?,?,?)
           ON CONFLICT (user_id) DO UPDATE SET version=EXCLUDED.version,agreed_at=EXCLUDED.agreed_at,withdrawn_at=NULL`,
        )
        .run(user.id, user.company_id, CONSENT_VERSION, at);
    else await db.prepare("UPDATE ff_consents SET withdrawn_at=? WHERE user_id=?").run(at, user.id);
    await audit(b.agree ? "location_sharing_agreed" : "location_sharing_withdrawn", { version: CONSENT_VERSION });
    return send(200, await trackState(app, user));
  });
  router.post("/api/field-force/pings", { lane: "self" }, async ({ req, user, body, send }) => {
    await phoneOnly(user, req);
    const b = await body(200000);
    if (!Array.isArray(b.points) || b.points.length > 500) throw new HttpError(400, "Send up to 500 points.");
    const state = await trackState(app, user);
    // Points sent after punch-out or a withdrawal are refused; the phone is told to stop.
    const saved = state.track ? await savePoints(app, user, b.points, "app") : 0;
    return send(200, { saved, track: state.track, ping_minutes: state.ping_minutes });
  });
  router.post("/api/field-force/visits", { lane: "self" }, async ({ req, user, body, send, audit }) => {
    await phoneOnly(user, req);
    if (!(await teamOf(db, user.id))) throw new HttpError(403, "This is for field staff.");
    if (!(await openShift(db, user.id))) throw new HttpError(409, "Punch in first, then log your visits.");
    const b = await body();
    const customer = optionalString(b.customer, "Customer", 120);
    const note = optionalString(b.note, "Note", 300);
    const located = coord(b.latitude, 90) && coord(b.longitude, 180);
    const at = new Date(app.clock()).toISOString();
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO ff_visits(company_id,user_id,day,at,latitude,longitude,accuracy,customer,note,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(user.company_id, user.id, today(), at, located ? b.latitude : null, located ? b.longitude : null, typeof b.accuracy === "number" ? b.accuracy : null, customer, note, at)
      ).lastInsertRowid,
    );
    await audit("field_visit_logged", { id });
    return send(201, { id, at });
  });

  // ---- HR and managers -----------------------------------------------------------------------------
  // Everyone's movement for a day, in summary.
  router.get("/api/field-force/movement", async ({ user, companyId, query, send }) => {
    const day = query.get("date") ? isoDate(query.get("date"), "Date") : today();
    const hr = can(user, "attendance.read");
    const team = hr ? null : (await db.prepare(TEAM_SQL).all(user.id)).map((r) => r.id);
    if (!hr && !team.length) throw new HttpError(403, "This is for HR and managers.");
    const scope = hr ? branchScope(user) : { sql: "", params: [] };
    const people = await db
      .prepare(
        `SELECT u.id,u.name,u.employee_code,b.name branch_name,
           (SELECT c.withdrawn_at IS NULL AND c.version=? FROM ff_consents c WHERE c.user_id=u.id) consent
         FROM ff_staff f JOIN users u ON u.id=f.user_id LEFT JOIN branches b ON b.id=u.branch_id
         WHERE u.company_id=? AND u.active=1${team ? ` AND u.id IN (${team.map(() => "?").join(",") || "NULL"})` : ""}${scope.sql}
         ORDER BY b.name,u.name`,
      )
      .all(CONSENT_VERSION, companyId, ...(team ?? []), ...scope.params);
    const ids = people.map((p) => p.id);
    const inIds = `(${ids.map(() => "?").join(",") || "NULL"})`;
    const [points, visits, alerts] = await Promise.all([
      db.prepare(`SELECT user_id,latitude,longitude,at FROM ff_pings WHERE day=? AND user_id IN ${inIds} ORDER BY user_id,at`).all(day, ...ids),
      db.prepare(`SELECT user_id,COUNT(*) n FROM ff_visits WHERE day=? AND user_id IN ${inIds} GROUP BY user_id`).all(day, ...ids),
      db.prepare(`SELECT user_id,kind,level,closed_at FROM ff_alerts WHERE day=? AND user_id IN ${inIds}`).all(day, ...ids),
    ]);
    const km = new Map(),
      last = new Map(),
      count = new Map();
    let prev = null;
    for (const q of points) {
      if (prev?.user_id === q.user_id)
        km.set(q.user_id, (km.get(q.user_id) ?? 0) + distanceMeters(prev.latitude, prev.longitude, q.latitude, q.longitude) / 1000);
      last.set(q.user_id, q.at);
      count.set(q.user_id, (count.get(q.user_id) ?? 0) + 1);
      prev = q;
    }
    const visitCount = new Map(visits.map((v) => [v.user_id, Number(v.n)]));
    return send(200, {
      date: day,
      settings: await trackingSettings(db, companyId),
      people: people.map((p) => {
        const mine = alerts.filter((a) => a.user_id === p.id);
        return {
          ...p,
          consent: Boolean(p.consent),
          points: count.get(p.id) ?? 0,
          last_at: last.get(p.id) ?? null,
          km: Math.round((km.get(p.id) ?? 0) * 10) / 10,
          visits: visitCount.get(p.id) ?? 0,
          alerts: mine.length,
          alert_open: mine.some((a) => !a.closed_at),
        };
      }),
    });
  });
  // One person's route for a day: points, visits and alerts (for the map).
  router.get("/api/field-force/route", async ({ user, companyId, query, send, audit }) => {
    const target = integer(Number(query.get("user_id")));
    const day = query.get("date") ? isoDate(query.get("date"), "Date") : today();
    const person = await db
      .prepare("SELECT u.id,u.name,u.employee_code,u.branch_id FROM ff_staff f JOIN users u ON u.id=f.user_id WHERE u.id=? AND u.company_id=?")
      .get(target, companyId);
    if (!person) throw new HttpError(404, "Not field staff.");
    const hr = can(user, "attendance.read") && (!user.branch_scope?.length || user.branch_scope.includes(person.branch_id));
    if (!hr && !(await db.prepare(TEAM_SQL).all(user.id)).some((r) => r.id === target))
      throw new HttpError(403, "You can see only your own team.");
    const [points, visits, alerts, shifts] = await Promise.all([
      db.prepare("SELECT latitude,longitude,accuracy,at,source,mocked FROM ff_pings WHERE user_id=? AND day=? ORDER BY at").all(target, day),
      db.prepare("SELECT latitude,longitude,at,customer,note FROM ff_visits WHERE user_id=? AND day=? ORDER BY at").all(target, day),
      db.prepare("SELECT kind,level,since,at,closed_at FROM ff_alerts WHERE user_id=? AND day=? ORDER BY at").all(target, day),
      db.prepare("SELECT in_at,out_at,in_latitude,in_longitude,out_latitude,out_longitude FROM shifts WHERE user_id=? AND in_at>=? AND in_at<? ORDER BY in_at").all(target, `${addDays(day, -1)}T18:00:00`, `${day}T23:59:59`),
    ]);
    // Looking at someone's movements is recorded, as for the punch map.
    await audit("field_route_viewed", { employeeId: target, day });
    return send(200, { person, date: day, points, visits, alerts, shifts });
  });
  router.get("/api/field-force/tracking/settings", { perm: "attendance.read" }, async ({ companyId, send }) =>
    send(200, await trackingSettings(db, companyId)),
  );
  router.patch("/api/field-force/tracking/settings", { perm: "employees.write" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const next = { ...(await trackingSettings(db, companyId)) };
    if (b.tracking !== undefined) {
      if (typeof b.tracking !== "boolean") throw new HttpError(400, "Tracking must be true or false.");
      next.tracking = b.tracking;
    }
    const whole = (k, label, min, max) => {
      if (b[k] === undefined) return;
      const v = Number(b[k]);
      if (!Number.isInteger(v) || v < min || v > max) throw new HttpError(400, `${label} must be a whole number from ${min} to ${max}.`);
      next[k] = v;
    };
    whole("ping_minutes", "Location every (minutes)", 5, 60);
    whole("still_minutes", "No-movement check (minutes)", 30, 480);
    whole("still_meters", "Counts as moved (metres)", 50, 5000);
    whole("keep_days", "Keep locations (days)", 7, 365);
    await db
      .prepare(
        `INSERT INTO ff_settings(company_id,tracking,ping_minutes,still_minutes,still_meters,keep_days) VALUES(?,?,?,?,?,?)
         ON CONFLICT (company_id) DO UPDATE SET tracking=EXCLUDED.tracking,ping_minutes=EXCLUDED.ping_minutes,
           still_minutes=EXCLUDED.still_minutes,still_meters=EXCLUDED.still_meters,keep_days=EXCLUDED.keep_days`,
      )
      .run(companyId, next.tracking ? 1 : 0, next.ping_minutes, next.still_minutes, next.still_meters, next.keep_days);
    await audit("field_tracking_settings_updated", next);
    return send(200, next);
  });
  // Points from a separate tracker (CSV rows): employee_code, time, latitude, longitude.
  router.post("/api/field-force/pings/import", { perm: "employees.write" }, async ({ companyId, body, send, audit }) => {
    const b = await body(2000000);
    if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 20000) throw new HttpError(400, "Send 1 to 20,000 rows.");
    const staff = await db
      .prepare("SELECT u.id,u.company_id,u.employee_code FROM ff_staff f JOIN users u ON u.id=f.user_id WHERE u.company_id=? AND u.active=1")
      .all(companyId);
    const byCode = new Map(staff.filter((s) => s.employee_code).map((s) => [String(s.employee_code).toLowerCase(), s]));
    const groups = new Map();
    let unknown = 0;
    for (const r of b.rows) {
      const person = byCode.get(String(r.employee_code ?? "").trim().toLowerCase());
      if (!person) {
        unknown++;
        continue;
      }
      groups.set(person, [...(groups.get(person) ?? []), { at: r.time ?? r.at, latitude: Number(r.latitude), longitude: Number(r.longitude) }]);
    }
    let saved = 0;
    for (const [person, points] of groups) saved += await savePoints(app, person, points, "tracker");
    await audit("field_pings_imported", { rows: b.rows.length, saved, unknown });
    return send(200, { rows: b.rows.length, saved, unknown, outside_shift_or_duplicate: b.rows.length - unknown - saved });
  });
}
