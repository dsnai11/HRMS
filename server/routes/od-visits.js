import { HttpError, integer, oneOf, optionalString } from "../http.js";
import { inboxScope, mayDecide } from "../approval.js";
import { staffWith } from "../scope.js";
import { halfDayReasons } from "../policy.js";

// OD trips: out of the office on duty during a shift (see /api/punch, actions od_out and
// od_in, and a punch-out while out). Each finished trip waits for the reporting manager,
// or HR when there is no manager.

/** Whether someone may use OD: chosen by HR one by one, or everyone in the company. */
export async function odAllowed(app, user) {
  if (user.od_punch) return true;
  const c = await app.db.prepare("SELECT od_everyone FROM companies WHERE id=?").get(user.company_id);
  return Boolean(c?.od_everyone);
}

/** Who is told about a finished trip: the reporting manager, else HR who approve requests. */
export async function tripApprovers(app, user) {
  if (user.manager_id) return [user.manager_id];
  return (await staffWith(app.db, user.company_id, ["leave.approve"], user.id)).map((r) => r.id);
}

const SELECT = `SELECT r.*,u.name employee_name,u.employee_code,s.out_at shift_out_at,s.workplace_name
  FROM od_visits r JOIN users u ON u.id=r.user_id JOIN shifts s ON s.id=r.shift_id`;

export function registerOdVisits(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();

  // My trips, newest first.
  router.get("/api/od-visits", async ({ user, send }) =>
    send(200, await db.prepare(`${SELECT} WHERE r.user_id=? ORDER BY r.id DESC LIMIT 60`).all(user.id)),
  );

  // Trips waiting for this person's decision (their team, or the company for HR).
  router.get("/api/od-visits/pending", async ({ user, send }) => {
    const scope = await inboxScope(app, user);
    if (!scope) return send(200, []);
    const rows = await db
      .prepare(`${SELECT} WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql} ORDER BY r.out_at LIMIT 300`)
      .all(user.company_id, user.id, ...scope.params);
    const mine = [];
    for (const r of rows) if (await mayDecide(app, user, r.user_id)) mine.push(r);
    return send(200, mine);
  });

  router.post("/api/od-visits/:id/decision", async ({ user, companyId, params, body, send }) => {
    const b = await body();
    const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
    const note = optionalString(b.note, "Note", 300);
    if (decision === "rejected" && !note) throw new HttpError(400, "Give a reason for rejecting.");
    const result = await transaction(async () => {
      const r = await db
        .prepare("SELECT * FROM od_visits WHERE id=? AND company_id=?")
        .get(integer(Number(params.id)), companyId);
      if (!r) throw new HttpError(404, "OD trip not found.");
      if (!(await mayDecide(app, user, r.user_id))) throw new HttpError(403, "You cannot decide this OD trip.");
      if (r.status !== "pending")
        throw new HttpError(409, r.status === "open" ? "The employee is still out on duty." : `This OD trip is already ${r.status}.`);
      const moved = await db
        .prepare("UPDATE od_visits SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending'")
        .run(decision, user.id, nowIso(), note, r.id);
      if (!moved.changes) throw new HttpError(409, "This OD trip has changed. Refresh and try again.");
      // A rejected trip that ended the day outside does not count as working time: the
      // punch-out goes back to when the person left the office, and the day type follows.
      let adjusted = false;
      if (decision === "rejected" && r.ended_by === "punch_out") {
        const s = await db.prepare("SELECT * FROM shifts WHERE id=?").get(r.shift_id);
        if (s && s.out_at === r.in_at) {
          const reasons = halfDayReasons({
            late: JSON.parse(s.half_day_reasons || "[]").includes("late_in"),
            requiredOutAt: s.required_out_at || s.in_at,
            outMs: Date.parse(r.out_at),
          });
          await db
            .prepare("UPDATE shifts SET out_at=?,out_latitude=?,out_longitude=?,out_accuracy=?,day_type=?,half_day_reasons=? WHERE id=?")
            .run(r.out_at, r.out_latitude, r.out_longitude, r.out_accuracy, reasons.length ? "half_day" : "full_day", JSON.stringify(reasons), s.id);
          adjusted = true;
        }
      }
      await app.audit(user, `od_trip_${decision}`, { id: r.id, employeeId: r.user_id, adjusted }, companyId);
      return { r, adjusted };
    });
    await app.notify([result.r.user_id], {
      companyId,
      kind: "approval",
      title:
        decision === "approved"
          ? `Your OD trip (${result.r.purpose}) was approved`
          : `Your OD trip (${result.r.purpose}) was not approved`,
      body:
        decision === "rejected"
          ? `${note}${result.adjusted ? " Your punch-out was set to when you left the office." : ""}`
          : null,
      link: "myattendance",
    });
    return send(200, { ok: true, adjusted: result.adjusted });
  });
}
