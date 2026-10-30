import { HttpError, integer, number, optionalString, string } from "../http.js";
import { requireOwned } from "../scope.js";
import { localToUtcMs } from "../calendar.js";

// Classroom and online training sessions (migration 059). HR schedules a session, invites people
// (or everyone who still has the linked training to do), and marks attendance once it has
// started. Attending completes a linked tracked training; a self-paced course is still
// completed by its quiz. Invitees are told when a session is scheduled or cancelled.
const MAX_INVITES = 500;

export function registerTrainingSessions(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  // "2026-11-12T10:00" in the company's time zone → UTC ISO.
  const localTime = (v, label) => {
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(String(v ?? ""));
    if (!m) throw new HttpError(400, `${label} must be a date and time.`);
    return new Date(localToUtcMs(m[1], m[2], app.timezone)).toISOString();
  };
  const SESSION_SELECT = `SELECT s.*,t.title training_title,t.kind training_kind,
      (SELECT COUNT(*) FROM session_attendees a WHERE a.session_id=s.id) invited,
      (SELECT COUNT(*) FROM session_attendees a WHERE a.session_id=s.id AND a.status='attended') attended
    FROM training_sessions s LEFT JOIN trainings t ON t.id=s.training_id`;

  async function invite(session, ids, companyId) {
    for (const id of ids) {
      const u = await owned("users", id, companyId, "employee");
      if (!u.active) throw new HttpError(400, `${u.name} is not active.`);
    }
    const have = (await db.prepare("SELECT COUNT(*) n FROM session_attendees WHERE session_id=?").get(session.id)).n;
    let added = 0;
    const fresh = [];
    for (const uid of ids) {
      if (session.capacity && Number(have) + added >= session.capacity)
        throw new HttpError(409, `The session is full (${session.capacity} seats).`);
      const r = await db
        .prepare("INSERT INTO session_attendees(session_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING")
        .run(session.id, uid);
      if (r.changes) {
        added++;
        fresh.push(uid);
      }
    }
    return fresh;
  }
  const when = (s) =>
    new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: app.timezone }).format(new Date(s.starts_at));

  // ---- HR ----------------------------------------------------------------------------------------
  router.get(
    "/api/admin/training-sessions",
    { perm: "performance.manage" },
    async ({ companyId, query, send }) => {
      const past = query.get("when") === "past";
      return send(
        200,
        await db
          .prepare(
            `${SESSION_SELECT} WHERE s.company_id=? AND ${past ? "s.ends_at<?" : "s.ends_at>=?"} ORDER BY s.starts_at ${past ? "DESC" : "ASC"} LIMIT 200`,
          )
          .all(companyId, nowIso()),
      );
    },
  );
  router.post(
    "/api/admin/training-sessions",
    { perm: "performance.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const training = b.training_id ? await owned("trainings", b.training_id, companyId, "training") : null;
      const starts = localTime(b.starts_at, "Start");
      const ends = localTime(b.ends_at, "End");
      if (ends <= starts) throw new HttpError(400, "The session must end after it starts.");
      if (starts < nowIso()) throw new HttpError(400, "Schedule the session in the future.");
      const capacity = b.capacity ? Math.round(number(b.capacity, "Seats", 1, 1000)) : null;
      let ids = Array.isArray(b.user_ids) ? [...new Set(b.user_ids.map((x) => integer(Number(x))))] : [];
      // No list: everyone who still has the linked training to do.
      if (!ids.length && training)
        ids = (
          await db
            .prepare("SELECT r.user_id FROM training_records r JOIN users u ON u.id=r.user_id WHERE r.training_id=? AND r.status='assigned' AND u.active=1")
            .all(training.id)
        ).map((r) => r.user_id);
      if (ids.length > MAX_INVITES) throw new HttpError(400, `Invite up to ${MAX_INVITES} people at a time.`);
      const out = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO training_sessions(company_id,training_id,title,trainer,venue,starts_at,ends_at,capacity,notes,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                training?.id ?? null,
                b.title || !training ? string(b.title, "Title", 150) : training.title,
                optionalString(b.trainer, "Trainer", 120),
                optionalString(b.venue, "Venue or meeting link", 300),
                starts,
                ends,
                capacity,
                optionalString(b.notes, "Notes", 1000),
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        const session = await db.prepare("SELECT * FROM training_sessions WHERE id=?").get(id);
        const invited = await invite(session, ids, companyId);
        await audit("training_session_scheduled", { id, invited: invited.length });
        return { session, invited };
      });
      if (out.invited.length)
        await app.notify(out.invited, {
          companyId,
          kind: "training",
          title: `Training session: ${out.session.title}, ${when(out.session)}`,
          body: out.session.venue ?? undefined,
          link: "learning",
        });
      return send(201, { id: out.session.id, invited: out.invited.length });
    },
  );
  router.get(
    "/api/admin/training-sessions/:id",
    { perm: "performance.manage" },
    async ({ params, companyId, send }) => {
      const s = await owned("training_sessions", params.id, companyId, "session");
      return send(200, {
        ...(await db.prepare(`${SESSION_SELECT} WHERE s.id=?`).get(s.id)),
        attendees: await db
          .prepare(
            `SELECT a.user_id,a.status,a.marked_at,u.name,u.employee_code,d.name department_name,m.name marked_by_name
             FROM session_attendees a JOIN users u ON u.id=a.user_id LEFT JOIN departments d ON d.id=u.department_id
             LEFT JOIN users m ON m.id=a.marked_by WHERE a.session_id=? ORDER BY u.name`,
          )
          .all(s.id),
      });
    },
  );
  router.post(
    "/api/admin/training-sessions/:id/invite",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const s = await owned("training_sessions", params.id, companyId, "session");
      if (s.status !== "scheduled" || s.ends_at < nowIso())
        throw new HttpError(409, "Only upcoming sessions take more people.");
      const b = await body();
      const ids = Array.isArray(b.user_ids) ? [...new Set(b.user_ids.map((x) => integer(Number(x))))] : [];
      if (!ids.length || ids.length > MAX_INVITES) throw new HttpError(400, "Choose the people to invite.");
      const fresh = await transaction(() => invite(s, ids, companyId));
      await audit("training_session_invited", { id: s.id, invited: fresh.length });
      if (fresh.length)
        await app.notify(fresh, {
          companyId,
          kind: "training",
          title: `Training session: ${s.title}, ${when(s)}`,
          body: s.venue ?? undefined,
          link: "learning",
        });
      return send(200, { invited: fresh.length });
    },
  );
  router.post(
    "/api/admin/training-sessions/:id/attendance",
    { perm: "performance.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const s = await owned("training_sessions", params.id, companyId, "session");
      if (s.status === "cancelled") throw new HttpError(409, "This session was cancelled.");
      if (s.starts_at > nowIso()) throw new HttpError(409, "Attendance can be marked once the session has started.");
      const b = await body();
      if (!Array.isArray(b.marks) || !b.marks.length) throw new HttpError(400, "Send the attendance.");
      const training = s.training_id ? await db.prepare("SELECT * FROM trainings WHERE id=?").get(s.training_id) : null;
      const day = app.dayOf(s.starts_at);
      let completed = 0;
      await transaction(async () => {
        for (const m of b.marks) {
          const uid = integer(Number(m?.user_id));
          const a = await db.prepare("SELECT * FROM session_attendees WHERE session_id=? AND user_id=?").get(s.id, uid);
          if (!a) throw new HttpError(400, "Mark only people invited to this session.");
          if (uid === user.id) throw new HttpError(403, "Someone else must mark your own attendance.");
          const status = m.attended ? "attended" : "absent";
          await db
            .prepare("UPDATE session_attendees SET status=?,marked_by=?,marked_at=? WHERE id=?")
            .run(status, user.id, nowIso(), a.id);
          if (status === "attended" && training && training.kind !== "course") {
            await db
              .prepare("INSERT INTO training_records(training_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING")
              .run(training.id, uid);
            const r = await db
              .prepare("UPDATE training_records SET status='completed',completed_on=? WHERE training_id=? AND user_id=? AND status='assigned'")
              .run(day, training.id, uid);
            completed += r.changes ?? 0;
          }
        }
        await db.prepare("UPDATE training_sessions SET status='completed' WHERE id=?").run(s.id);
        await audit("training_session_attendance", { id: s.id, marked: b.marks.length, completed });
      });
      return send(200, { ok: true, completed });
    },
  );
  router.post(
    "/api/admin/training-sessions/:id/cancel",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const s = await owned("training_sessions", params.id, companyId, "session");
      if (s.status !== "scheduled" || s.starts_at < nowIso())
        throw new HttpError(409, "Only sessions that have not started can be cancelled.");
      const reason = optionalString((await body()).reason, "Reason", 300);
      await db.prepare("UPDATE training_sessions SET status='cancelled' WHERE id=?").run(s.id);
      await audit("training_session_cancelled", { id: s.id });
      const ids = (await db.prepare("SELECT user_id FROM session_attendees WHERE session_id=?").all(s.id)).map((r) => r.user_id);
      if (ids.length)
        await app.notify(ids, {
          companyId,
          kind: "training",
          title: `Cancelled: ${s.title}, ${when(s)}`,
          body: reason ?? undefined,
          link: "learning",
        });
      return send(200, { ok: true });
    },
  );

  // ---- employee ----------------------------------------------------------------------------------
  router.get("/api/training-sessions/mine", async ({ user, send }) => {
    const rows = await db
      .prepare(
        `SELECT s.id,s.title,s.trainer,s.venue,s.starts_at,s.ends_at,s.status,s.notes,a.status attendance
         FROM session_attendees a JOIN training_sessions s ON s.id=a.session_id WHERE a.user_id=? ORDER BY s.starts_at DESC LIMIT 200`,
      )
      .all(user.id);
    const now = nowIso();
    return send(200, {
      upcoming: rows.filter((r) => r.ends_at >= now && r.status !== "cancelled").reverse(),
      past: rows.filter((r) => r.ends_at < now || r.status === "cancelled"),
    });
  });
}
