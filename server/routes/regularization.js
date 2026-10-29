import {
  STEPS,
  chainOf,
  mayDecideStep,
  nextStep,
  stepApprovers,
} from "../approval-chain.js";
import {
  HttpError,
  string,
  integer,
  isoDate,
  oneOf,
  optionalString,
} from "../http.js";
import { inboxScope } from "../approval.js";
import { daysBetween, localToUtcMs, monthOf } from "../calendar.js";
import { companySettings } from "../leave-ledger.js";
import { evaluatePunchIn, halfDayReasons } from "../policy.js";

const KINDS = ["missed_punch", "wrong_punch", "on_duty", "work_from_home"];
const SELF_REPORTED = ["missed_punch", "wrong_punch"];
const hhmm = (m) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const time = (v, label) => {
  const s = optionalString(v, label, 5);
  if (s !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(s))
    throw new HttpError(400, `${label} must look like 09:30.`);
  return s;
};

// Records a correction and sends it to the first step of the company's correction chain.
// An OD punch-out sends one too (shiftId set), for the shift it already recorded.
export async function submitCorrection(
  app,
  user,
  { kind, date, inTime, outTime, reason, shiftId = null },
) {
  const { db } = app;
  const nowIso = new Date(app.clock()).toISOString();
  let id;
  try {
    id = Number(
      (
        await db
          .prepare(
            "INSERT INTO regularizations(company_id,user_id,date,kind,in_time,out_time,reason,created_at,shift_id,from_punch) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            user.company_id,
            user.id,
            date,
            kind,
            inTime,
            outTime,
            reason,
            nowIso,
            shiftId,
            shiftId ? 1 : 0,
          )
      ).lastInsertRowid,
    );
  } catch (e) {
    if (e?.code === "23505")
      throw new HttpError(
        409,
        "You already have a pending correction for that date.",
      );
    throw e;
  }
  await app.audit(user, "regularization_requested", { id, kind, date, ...(shiftId ? { shiftId } : {}) });
  const chain = await chainOf(db, user.company_id, "correction");
  const step = Math.min(
    await nextStep(db, user.company_id, user.id, chain, 0),
    chain.length - 1,
  );
  await db
    .prepare("UPDATE regularizations SET step=?,step_at=? WHERE id=?")
    .run(step, nowIso, id);
  await app.notify(
    await stepApprovers(db, user.company_id, user.id, chain[step]),
    {
      companyId: user.company_id,
      kind: "approval",
      title: shiftId
        ? `${user.name} punched OD on ${date}`
        : `${user.name} asked to correct attendance for ${date}`,
      body: `Waiting for: ${STEPS[chain[step]]}`,
      link: "approvals",
    },
  );
  return id;
}

export function registerRegularization(router, app) {
  const { db, transaction, clock, dayOf, timezone } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => dayOf(nowIso());
  const SELECT = `SELECT r.*,u.name employee_name,u.employee_code FROM regularizations r JOIN users u ON u.id=r.user_id`;

  router.post("/api/regularizations", async ({ user, body, send }) => {
    const b = await body();
    const kind = oneOf(b.kind, "Type", KINDS);
    const date = isoDate(b.date, "Date");
    if (!date) throw new HttpError(400, "Date is required.");
    const reason = string(b.reason, "Reason", 500);
    const inTime = time(b.in_time, "In time"),
      outTime = time(b.out_time, "Out time");
    if (SELF_REPORTED.includes(kind) && (!inTime || !outTime))
      throw new HttpError(400, "Give both the in and out time you worked.");
    if (inTime && outTime && outTime <= inTime)
      throw new HttpError(400, "Out time must be after in time.");
    const t = today();
    if (date > t)
      throw new HttpError(400, "Corrections are for today or earlier.");
    const settings = await companySettings(db, user.company_id);
    if (daysBetween(date, t) > settings.regularizationWindowDays)
      throw new HttpError(
        422,
        `Corrections can only be requested within ${settings.regularizationWindowDays} day(s).`,
      );
    if (settings.regularizationMonthlyLimit > 0) {
      const used = (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM regularizations WHERE user_id=? AND status IN ('pending','approved') AND from_punch=0 AND substr(date,1,7)=?",
          )
          .get(user.id, monthOf(date))
      ).n;
      if (used >= settings.regularizationMonthlyLimit)
        throw new HttpError(
          422,
          `You have used all ${settings.regularizationMonthlyLimit} corrections for that month.`,
        );
    }
    const onLeave = (
      await db
        .prepare("SELECT COUNT(*) n FROM leave_days WHERE user_id=? AND day=?")
        .get(user.id, date)
    ).n;
    if (onLeave >= 2)
      throw new HttpError(
        409,
        "You have approved or pending leave for that whole day.",
      );
    const id = await submitCorrection(app, user, {
      kind,
      date,
      inTime,
      outTime,
      reason,
    });
    return send(201, { id });
  });

  router.get("/api/regularizations", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${SELECT} WHERE r.user_id=? ORDER BY r.date DESC,r.id DESC LIMIT 100`,
        )
        .all(user.id),
    ),
  );
  router.get(
    "/api/admin/regularizations",
    { perm: "attendance.read" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `${SELECT} WHERE r.company_id=?${status ? " AND r.status=?" : ""} ORDER BY r.date DESC,r.id DESC LIMIT 200`,
          )
          .all(
            ...(status
              ? [
                  companyId,
                  oneOf(status, "Status", [
                    "pending",
                    "approved",
                    "rejected",
                    "cancelled",
                  ]),
                ]
              : [companyId]),
          ),
      );
    },
  );

  router.post(
    "/api/regularizations/:id/cancel",
    async ({ params, user, send, audit }) => {
      const r = await db
        .prepare("SELECT * FROM regularizations WHERE id=? AND user_id=?")
        .get(integer(Number(params.id)), user.id);
      if (!r) throw new HttpError(404, "Correction not found.");
      if (r.status !== "pending")
        throw new HttpError(409, `This correction is already ${r.status}.`);
      if (r.from_punch)
        throw new HttpError(
          409,
          "An OD punch cannot be withdrawn. Your manager will approve or reject it.",
        );
      await db
        .prepare("UPDATE regularizations SET status='cancelled' WHERE id=?")
        .run(r.id);
      await audit("regularization_cancelled", { id: r.id });
      return send(200, { ok: true });
    },
  );

  // Applies an approved correction: creates or amends that day's shift.
  async function applyCorrection(r) {
    // An OD punch already has its shift, with the real times and places.
    if (r.from_punch) {
      await db
        .prepare(
          "UPDATE shifts SET source='on_duty',day_type='full_day',half_day_reasons='[]' WHERE id=?",
        )
        .run(r.shift_id);
      return r.shift_id;
    }
    const person = await db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(r.user_id);
    const site =
      person.workplace_id &&
      (await db
        .prepare("SELECT * FROM workplaces WHERE id=?")
        .get(person.workplace_id));
    if (!site)
      throw new HttpError(
        422,
        "Assign this employee a workplace before approving.",
      );
    const policy = await app.policyFor(person, r.date);
    const inMs = localToUtcMs(
      r.date,
      r.in_time || hhmm(policy.startMinutes),
      timezone,
    );
    const outMs = localToUtcMs(
      r.date,
      r.out_time || hhmm(policy.earliestOutMinutes),
      timezone,
    );
    const rules = evaluatePunchIn(policy, inMs, timezone);
    const reasons = SELF_REPORTED.includes(r.kind)
      ? halfDayReasons({
          late: rules.late,
          requiredOutAt: rules.requiredOutAt,
          outMs,
        })
      : [];
    const dayType = reasons.length ? "half_day" : "full_day";
    const source = SELF_REPORTED.includes(r.kind) ? "regularized" : r.kind;
    const existing = (
      await db
        .prepare(
          "SELECT * FROM shifts WHERE user_id=? AND in_at>=? AND in_at<? ORDER BY id DESC",
        )
        .all(
          r.user_id,
          new Date(inMs - 2 * 86400000).toISOString(),
          new Date(inMs + 2 * 86400000).toISOString(),
        )
    ).find((s) => dayOf(s.in_at) === r.date);
    const inAt = new Date(inMs).toISOString(),
      outAt = new Date(outMs).toISOString();
    if (existing) {
      await db
        .prepare(
          "UPDATE shifts SET in_at=?,out_at=?,out_latitude=COALESCE(out_latitude,?),out_longitude=COALESCE(out_longitude,?),out_accuracy=COALESCE(out_accuracy,0),required_out_at=?,day_type=?,half_day_reasons=?,source=? WHERE id=?",
        )
        .run(
          inAt,
          outAt,
          site.latitude,
          site.longitude,
          rules.requiredOutAt,
          dayType,
          JSON.stringify(reasons),
          source,
          existing.id,
        );
      return existing.id;
    }
    return Number(
      (
        await db
          .prepare(
            "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,out_latitude,out_longitude,out_accuracy,required_out_at,day_type,half_day_reasons,source) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,0,?,?,?,?)",
          )
          .run(
            r.user_id,
            site.id,
            site.name,
            site.latitude,
            site.longitude,
            site.radius,
            site.max_accuracy,
            inAt,
            site.latitude,
            site.longitude,
            outAt,
            site.latitude,
            site.longitude,
            rules.requiredOutAt,
            dayType,
            JSON.stringify(reasons),
            source,
          )
      ).lastInsertRowid,
    );
  }

  router.post(
    "/api/regularizations/:id/decision",
    async ({ params, user, companyId, body, send }) => {
      const r = await db
        .prepare("SELECT * FROM regularizations WHERE id=? AND company_id=?")
        .get(integer(Number(params.id)), companyId);
      if (!r) throw new HttpError(404, "Correction not found.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 300);
      const chain = await chainOf(db, companyId, "correction");
      if (!(await mayDecideStep(app, user, r, chain)))
        throw new HttpError(403, "You cannot decide this request.");
      // An approval before the last step moves the correction on instead of applying it.
      const following =
        decision === "approved"
          ? await nextStep(db, companyId, r.user_id, chain, r.step + 1)
          : chain.length;
      if (following < chain.length) {
        const moved = await db
          .prepare(
            "UPDATE regularizations SET step=?,step_at=?,approvals=?,reminded_at=NULL,escalated_at=NULL WHERE id=? AND status='pending' AND step=?",
          )
          .run(
            following,
            nowIso(),
            JSON.stringify([
              ...JSON.parse(r.approvals || "[]"),
              { step: chain[r.step], by: user.id, name: user.name, at: nowIso(), note },
            ]),
            r.id,
            r.step,
          );
        if (!moved.changes)
          throw new HttpError(409, "This correction has changed. Refresh and try again.");
        await app.audit(
          user,
          "regularization_step_approved",
          { id: r.id, employeeId: r.user_id, step: chain[r.step] },
          companyId,
        );
        const who = await db.prepare("SELECT name FROM users WHERE id=?").get(r.user_id);
        await app.notify(
          await stepApprovers(db, companyId, r.user_id, chain[following]),
          {
            companyId,
            kind: "approval",
            title: `${who.name}'s attendance correction needs your approval`,
            body: `Approved by ${user.name}. Waiting for: ${STEPS[chain[following]]}`,
            link: "approvals",
          },
        );
        return send(200, { ok: true, status: "pending", step: chain[following] });
      }
      await transaction(async () => {
        const fresh = await db
          .prepare("SELECT status FROM regularizations WHERE id=?")
          .get(r.id);
        if (fresh.status !== "pending")
          throw new HttpError(
            409,
            `This correction is already ${fresh.status}.`,
          );
        const shiftId =
          decision === "approved"
            ? await applyCorrection(r)
            : r.from_punch
              ? r.shift_id
              : null;
        // A rejected OD punch does not count as a day worked.
        if (decision === "rejected" && r.from_punch)
          await db
            .prepare(
              "UPDATE shifts SET source='od_rejected',day_type='absent' WHERE id=?",
            )
            .run(r.shift_id);
        await db
          .prepare(
            "UPDATE regularizations SET status=?,decided_by=?,decided_at=?,decision_note=?,shift_id=? WHERE id=?",
          )
          .run(decision, user.id, nowIso(), note, shiftId, r.id);
        await app.audit(
          user,
          `regularization_${decision}`,
          { id: r.id, employeeId: r.user_id, date: r.date, shiftId },
          companyId,
        );
      });
      return send(200, { ok: true });
    },
  );

  // ---- approvals inbox ------------------------------------------------------
  router.get("/api/approvals", async ({ user, send }) => {
    const scope = await inboxScope(app, user);
    if (!scope) return send(200, { leave: [], regularizations: [] });
    const args = [user.company_id, user.id, ...scope.params];
    const leave = await db
      .prepare(
        `SELECT r.*,t.name type_name,t.code type_code,u.name employee_name,u.employee_code,h.name handover_name FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id JOIN users u ON u.id=r.user_id LEFT JOIN users h ON h.id=r.handover_to WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql} ORDER BY r.from_date,r.id LIMIT 200`,
      )
      .all(...args);
    // Only requests waiting at a step this person can act on, with where they are.
    const chain = await chainOf(db, user.company_id);
    const mine = [];
    for (const r of leave)
      if (await mayDecideStep(app, user, r, chain))
        mine.push({
          ...r,
          step_name: STEPS[chain[r.step]] ?? "HR",
          step_number: r.step + 1,
          steps: chain.length,
        });
    const cchain = await chainOf(db, user.company_id, "correction");
    const fixes = [];
    for (const r of await db
      .prepare(
        `${SELECT} WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql} ORDER BY r.date,r.id LIMIT 200`,
      )
      .all(...args))
      if (await mayDecideStep(app, user, r, cchain))
        fixes.push({
          ...r,
          step_name: STEPS[cchain[r.step]] ?? "HR",
          step_number: r.step + 1,
          steps: cchain.length,
        });
    return send(200, {
      leave: mine,
      regularizations: fixes,
    });
  });
}
