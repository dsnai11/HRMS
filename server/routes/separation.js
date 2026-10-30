import {
  HttpError,
  integer,
  isoDate,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { addDays, localToUtcMs } from "../calendar.js";
import { TEAM_SQL } from "../attendance-report.js";

// Separation started by the manager, and the manager's view on a resignation.
//  - Absconding: active people with no punch-in and no approved leave for N days (default 7),
//    for HR (everyone) and for managers (their team). Weekly offs and holidays are not
//    subtracted, so a short window can flag a long holiday break; HR decides, not the list.
//  - A manager asks HR to separate a team member (termination or absconding). HR approves,
//    which starts an exit with clearance exactly like one HR starts, or rejects with a reason.
//  - A manager records accept/retain and a suggested last day on a pending resignation; HR
//    sees it before deciding. HR may decide without it.
const DEFAULT_DAYS = 7;

export function registerSeparation(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const inTeam = async (managerId, userId) =>
    Boolean(
      await db
        .prepare(`SELECT 1 FROM (${TEAM_SQL}) t WHERE t.id=?`)
        .get(managerId, userId),
    );
  const requireManager = async (user) => {
    if (
      !(await db
        .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
        .get(user.id))
    )
      throw new HttpError(403, "You do not manage anyone.");
  };
  const windowDays = (query) => {
    const n = Number(query.get("days") ?? DEFAULT_DAYS);
    if (!Number.isInteger(n) || n < 3 || n > 90)
      throw new HttpError(400, "Days must be a whole number from 3 to 90.");
    return n;
  };

  async function absconding(companyId, days, teamOf = null) {
    const fromDay = addDays(today(), -(days - 1));
    const fromIso = new Date(localToUtcMs(fromDay, "00:00", app.timezone)).toISOString();
    const rows = await db
      .prepare(
        `SELECT u.id,u.name,u.employee_code,u.date_of_joining,d.name department_name,m.name manager_name,
           (SELECT MAX(s.in_at) FROM shifts s WHERE s.user_id=u.id) last_in_at,
           (SELECT r.id FROM separation_requests r WHERE r.user_id=u.id AND r.status='pending') request_id
         FROM users u LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN users m ON m.id=u.manager_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin'
           AND (u.date_of_joining IS NULL OR u.date_of_joining < ?)
           AND (u.exit_date IS NULL OR u.exit_date >= ?)
           AND NOT EXISTS (SELECT 1 FROM shifts s WHERE s.user_id=u.id AND s.in_at>=?)
           AND NOT EXISTS (SELECT 1 FROM leave_days l JOIN leave_requests q ON q.id=l.request_id
                           WHERE l.user_id=u.id AND q.status='approved' AND l.day>=? AND l.day<=?)
           AND NOT EXISTS (SELECT 1 FROM exits x WHERE x.user_id=u.id AND x.status IN ('pending','accepted'))
           ${teamOf ? `AND u.id IN (${TEAM_SQL})` : ""}
         ORDER BY last_in_at NULLS FIRST, u.name LIMIT 500`,
      )
      .all(
        companyId,
        fromDay,
        today(),
        fromIso,
        fromDay,
        today(),
        ...(teamOf ? [teamOf] : []),
      );
    return {
      days,
      from: fromDay,
      items: rows.map((r) => ({
        ...r,
        last_seen_on: r.last_in_at ? app.dayOf(r.last_in_at) : null,
      })),
    };
  }

  router.get(
    "/api/admin/absconding",
    { perm: "exit.manage" },
    async ({ companyId, query, send }) =>
      send(200, await absconding(companyId, windowDays(query))),
  );
  router.get("/api/team/absconding", async ({ user, query, send }) => {
    await requireManager(user);
    return send(
      200,
      await absconding(user.company_id, windowDays(query), user.id),
    );
  });

  // ---- manager: ask HR to separate a team member ----------------------------------------------
  const REQUEST_SELECT = `SELECT r.*,u.name employee_name,u.employee_code,d.name department_name,
      q.name requested_by_name,h.name decided_by_name
    FROM separation_requests r JOIN users u ON u.id=r.user_id LEFT JOIN departments d ON d.id=u.department_id
    JOIN users q ON q.id=r.requested_by LEFT JOIN users h ON h.id=r.decided_by`;

  router.get("/api/team/separations", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(`${REQUEST_SELECT} WHERE r.requested_by=? ORDER BY r.id DESC LIMIT 200`)
        .all(user.id),
    ),
  );
  router.post("/api/team/separations", async ({ user, body, send, audit }) => {
    await requireManager(user);
    const b = await body();
    const person = await owned("users", b.user_id, user.company_id, "employee");
    if (!person.active || !(await inTeam(user.id, person.id)))
      throw new HttpError(403, "You can ask only for an active member of your team.");
    if (
      await db
        .prepare("SELECT id FROM exits WHERE user_id=? AND status IN ('pending','accepted')")
        .get(person.id)
    )
      throw new HttpError(409, "This employee already has an exit in progress.");
    if (
      await db
        .prepare("SELECT id FROM separation_requests WHERE user_id=? AND status='pending'")
        .get(person.id)
    )
      throw new HttpError(409, "A separation request for this employee is already with HR.");
    const kind = oneOf(b.kind, "Type", ["termination", "absconding"]);
    const lastSeen = isoDate(b.last_seen_on, "Last day at work");
    if (kind === "absconding" && !lastSeen)
      throw new HttpError(400, "Give the last day the employee came to work.");
    if (lastSeen && lastSeen > today())
      throw new HttpError(400, "The last day at work cannot be in the future.");
    const proposed = isoDate(b.proposed_last_day, "Proposed last day");
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO separation_requests(company_id,user_id,kind,reason,last_seen_on,proposed_last_day,requested_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              person.id,
              kind,
              string(b.reason, "Reason", 1000),
              lastSeen,
              proposed,
              user.id,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("separation_requested", { id, employeeId: person.id, kind });
      return id;
    });
    return send(201, { id });
  });
  router.post(
    "/api/team/separations/:id/cancel",
    async ({ user, params, send, audit }) => {
      const r = await owned("separation_requests", params.id, user.company_id, "request");
      if (r.requested_by !== user.id)
        throw new HttpError(403, "Only the manager who asked can cancel this.");
      if (r.status !== "pending")
        throw new HttpError(409, `This request is already ${r.status}.`);
      await db
        .prepare("UPDATE separation_requests SET status='cancelled' WHERE id=?")
        .run(r.id);
      await audit("separation_cancelled", { id: r.id });
      return send(200, { ok: true });
    },
  );

  // ---- HR: decide manager requests ------------------------------------------------------------
  router.get(
    "/api/admin/separations",
    { perm: "exit.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `${REQUEST_SELECT} WHERE r.company_id=? ${status ? "AND r.status=?" : ""} ORDER BY r.id DESC LIMIT 300`,
          )
          .all(...(status ? [companyId, status] : [companyId])),
      );
    },
  );
  router.post(
    "/api/admin/separations/:id/decide",
    { perm: "exit.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const r = await owned("separation_requests", params.id, companyId, "request");
      if (r.status !== "pending")
        throw new HttpError(409, `This request is already ${r.status}.`);
      if (r.user_id === user.id)
        throw new HttpError(403, "You cannot decide a request about yourself.");
      if (r.requested_by === user.id)
        throw new HttpError(403, "Someone else in HR must decide a request you raised.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 500);
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Say why the request is not approved.");
      let exitId = null;
      await transaction(async () => {
        if (decision === "approved") {
          const lwd =
            isoDate(b.last_working_day, "Last working day") ??
            r.proposed_last_day ??
            r.last_seen_on;
          if (!lwd) throw new HttpError(400, "Last working day is required.");
          if (
            await db
              .prepare("SELECT id FROM exits WHERE user_id=? AND status IN ('pending','accepted')")
              .get(r.user_id)
          )
            throw new HttpError(409, "This employee already has an exit in progress.");
          const person = await db.prepare("SELECT * FROM users WHERE id=?").get(r.user_id);
          exitId = Number(
            (
              await db
                .prepare(
                  "INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,last_working_day,waive_notice,reason,status,decided_by,decided_at,decision_note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,'accepted',?,?,?,?,?)",
                )
                .run(
                  companyId,
                  r.user_id,
                  r.kind,
                  "company",
                  today(),
                  person.notice_days ?? 0,
                  lwd,
                  1,
                  r.reason,
                  user.id,
                  nowIso(),
                  note,
                  user.id,
                  nowIso(),
                )
            ).lastInsertRowid,
          );
          await db.prepare("UPDATE users SET exit_date=? WHERE id=?").run(lwd, r.user_id);
          await app.startExitClearance({ id: exitId, user_id: r.user_id });
        }
        await db
          .prepare(
            "UPDATE separation_requests SET status=?,decided_by=?,decided_at=?,decision_note=?,exit_id=? WHERE id=?",
          )
          .run(decision, user.id, nowIso(), note, exitId, r.id);
        await audit("separation_decided", { id: r.id, decision, exitId });
      });
      return send(200, { ok: true, exit_id: exitId });
    },
  );

  // ---- manager: view on a team member's resignation -------------------------------------------
  router.get("/api/team/resignations", async ({ user, send }) => {
    await requireManager(user);
    return send(
      200,
      await db
        .prepare(
          `SELECT x.id,x.user_id,x.status,x.notice_given_on,x.notice_days,x.requested_last_day,x.last_working_day,x.reason,
             x.manager_view,x.manager_note,x.manager_last_day,x.manager_at,x.decision_note,
             u.name employee_name,u.employee_code,d.name department_name
           FROM exits x JOIN users u ON u.id=x.user_id LEFT JOIN departments d ON d.id=u.department_id
           WHERE x.kind='resignation' AND x.user_id IN (${TEAM_SQL})
             AND (x.status='pending' OR x.notice_given_on>=?)
           ORDER BY (x.status='pending') DESC, x.id DESC LIMIT 200`,
        )
        .all(user.id, addDays(today(), -180)),
    );
  });
  router.post(
    "/api/team/resignations/:id/review",
    async ({ user, params, body, send, audit }) => {
      const x = await owned("exits", params.id, user.company_id, "resignation");
      if (x.kind !== "resignation" || !(await inTeam(user.id, x.user_id)))
        throw new HttpError(403, "This resignation is not from your team.");
      if (x.status !== "pending")
        throw new HttpError(409, `HR has already ${x.status === "withdrawn" ? "closed" : "decided"} this resignation.`);
      const b = await body();
      const view = oneOf(b.view, "Recommendation", ["accept", "retain"]);
      const note = optionalString(b.note, "Note", 500);
      if (view === "retain" && !note)
        throw new HttpError(400, "Say how you plan to keep the employee.");
      const lastDay = isoDate(b.last_day, "Suggested last day");
      if (lastDay && lastDay < x.notice_given_on)
        throw new HttpError(400, "The last day cannot be before the resignation date.");
      await db
        .prepare(
          "UPDATE exits SET manager_view=?,manager_note=?,manager_last_day=?,manager_by=?,manager_at=? WHERE id=?",
        )
        .run(view, note, lastDay, user.id, nowIso(), x.id);
      await audit("resignation_reviewed", { id: x.id, view });
      return send(200, { ok: true });
    },
  );
}
