import { HttpError, integer, isoDate, number, oneOf, optionalString, string } from "../http.js";
import { inboxScope, mayDecide } from "../approval.js";
import { withDelegates } from "../delegation.js";
import { staffWith } from "../scope.js";
import { addDays, daysBetween, localToUtcMs } from "../calendar.js";

// Overtime: minutes worked after the full-day finish (the shift's required_out_at) on a
// full working day, read from the punches, never from the claim. Holiday and weekly-off
// work earns comp-off instead, so it is not paid twice. A claim can be up to what the
// punches show, within the daily cap; the manager (or their stand-in) approves all or
// part; payroll pays approved minutes once, at ot_rate times the hourly basic or gross.
const SETTINGS = "ot_enabled,ot_min_minutes,ot_max_minutes,ot_rate,ot_basis,ot_days_per_month,ot_hours_per_day,ot_claim_days";

export async function overtimeSettings(db, companyId) {
  const c = await db.prepare(`SELECT ${SETTINGS} FROM companies WHERE id=?`).get(companyId);
  return { ...c, ot_enabled: Boolean(c.ot_enabled) };
}

/** Overtime minutes a finished shift allows (0 when none). */
export function eligibleMinutes(shift) {
  if (!shift?.out_at || !shift.required_out_at || shift.day_type !== "full_day") return 0;
  if (!["punch", "on_duty"].includes(shift.source)) return 0;
  return Math.max(0, Math.floor((Date.parse(shift.out_at) - Date.parse(shift.required_out_at)) / 60000));
}

/** Pay for approved minutes, given the salary and its lines (as payroll has them). */
export function overtimePay(settings, salary, lines, minutes) {
  const base =
    settings.ot_basis === "gross"
      ? Number(salary.monthly_gross)
      : lines.filter((l) => l.is_basic).reduce((s, l) => s + Number(l.amount), 0) || Number(salary.monthly_gross) * 0.5;
  const hourly = base / (settings.ot_days_per_month * settings.ot_hours_per_day);
  return Math.round((minutes / 60) * hourly * settings.ot_rate);
}
export const otLabel = (minutes) => `Overtime (${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m)`;

export function registerOvertime(router, app) {
  const { db, transaction, clock, timezone } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const shiftOn = async (userId, date) =>
    (
      await db
        .prepare("SELECT * FROM shifts WHERE user_id=? AND in_at>=? AND in_at<? ORDER BY id DESC LIMIT 1")
        .all(
          userId,
          new Date(localToUtcMs(date, "00:00", timezone)).toISOString(),
          new Date(localToUtcMs(addDays(date, 1), "00:00", timezone)).toISOString(),
        )
    )[0] ?? null;
  const SELECT = `SELECT o.*,u.name employee_name,u.employee_code FROM overtime_requests o JOIN users u ON u.id=o.user_id`;
  const approvers = async (user) =>
    user.manager_id
      ? (await withDelegates(db, [user.manager_id])).filter((id) => id !== user.id)
      : (await staffWith(db, user.company_id, ["leave.approve"], user.id)).map((r) => r.id);

  // My claims, and recent days with overtime I have not claimed.
  router.get("/api/overtime", async ({ user, send }) => {
    const s = await overtimeSettings(db, user.company_id);
    const mine = await db.prepare(`${SELECT} WHERE o.user_id=? ORDER BY o.date DESC,o.id DESC LIMIT 60`).all(user.id);
    const suggestions = [];
    if (s.ot_enabled) {
      const since = addDays(today(), -s.ot_claim_days);
      const shifts = await db
        .prepare("SELECT * FROM shifts WHERE user_id=? AND in_at>=? AND out_at IS NOT NULL ORDER BY in_at DESC")
        .all(user.id, new Date(localToUtcMs(since, "00:00", timezone)).toISOString());
      const claimed = new Set(mine.filter((o) => ["pending", "approved"].includes(o.status)).map((o) => o.date));
      for (const sh of shifts) {
        const date = app.dayOf(sh.in_at);
        const minutes = Math.min(eligibleMinutes(sh), s.ot_max_minutes);
        if (minutes >= s.ot_min_minutes && !claimed.has(date)) suggestions.push({ date, minutes, out_at: sh.out_at, required_out_at: sh.required_out_at });
      }
    }
    return send(200, { settings: s, requests: mine, suggestions });
  });

  router.post("/api/overtime", async ({ user, body, send, audit }) => {
    const s = await overtimeSettings(db, user.company_id);
    if (!s.ot_enabled) throw new HttpError(409, "Overtime is not switched on for your company.");
    const b = await body();
    const date = isoDate(b.date, "Date");
    if (!date || date >= today()) throw new HttpError(400, "Claim overtime for a finished day before today.");
    if (daysBetween(date, today()) > s.ot_claim_days)
      throw new HttpError(422, `Overtime must be claimed within ${s.ot_claim_days} day(s).`);
    const shift = await shiftOn(user.id, date);
    const eligible = Math.min(eligibleMinutes(shift), s.ot_max_minutes);
    if (eligible < s.ot_min_minutes)
      throw new HttpError(
        422,
        `Your punches show no overtime that day (at least ${s.ot_min_minutes} minutes after a full day, on a full working day).`,
      );
    const minutes = b.minutes === undefined ? eligible : Math.round(number(Number(b.minutes), "Minutes", 1, 1440));
    if (minutes > eligible) throw new HttpError(422, `Your punches allow up to ${eligible} minutes that day.`);
    if (minutes < s.ot_min_minutes) throw new HttpError(422, `Claim at least ${s.ot_min_minutes} minutes.`);
    let id;
    try {
      id = Number(
        (
          await db
            .prepare(
              "INSERT INTO overtime_requests(company_id,user_id,shift_id,date,eligible_minutes,minutes_claimed,reason,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(user.company_id, user.id, shift.id, date, eligible, minutes, string(b.reason, "Reason", 300), nowIso())
        ).lastInsertRowid,
      );
    } catch (e) {
      if (e?.code === "23505" || e?.status === 409) throw new HttpError(409, "You already have a claim for that day.");
      throw e;
    }
    await audit("overtime_claimed", { id, date, minutes });
    await app.notify(await approvers(user), {
      companyId: user.company_id,
      kind: "approval",
      title: `${user.name} claimed ${otLabel(minutes).toLowerCase()} for ${date}`,
      link: "approvals",
    });
    return send(201, { id, minutes });
  });

  router.post("/api/overtime/:id/cancel", async ({ user, params, send, audit }) => {
    const r = await db
      .prepare("UPDATE overtime_requests SET status='cancelled' WHERE id=? AND user_id=? AND status='pending'")
      .run(integer(Number(params.id)), user.id);
    if (!r.changes) throw new HttpError(409, "Only a pending claim of yours can be cancelled.");
    await audit("overtime_cancelled", { id: Number(params.id) });
    return send(200, { ok: true });
  });

  router.get("/api/overtime/pending", async ({ user, send }) => {
    const scope = await inboxScope(app, user);
    if (!scope) return send(200, []);
    const rows = await db
      .prepare(`${SELECT} WHERE o.company_id=? AND o.status='pending' AND o.user_id<>?${scope.sql.replaceAll("r.user_id", "o.user_id")} ORDER BY o.date LIMIT 300`)
      .all(user.company_id, user.id, ...scope.params);
    const out = [];
    for (const r of rows) if (await mayDecide(app, user, r.user_id)) out.push(r);
    return send(200, out);
  });

  router.post("/api/overtime/:id/decision", async ({ user, companyId, params, body, send }) => {
    const b = await body();
    const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
    const note = optionalString(b.note, "Note", 300);
    if (decision === "rejected" && !note) throw new HttpError(400, "Give a reason for rejecting.");
    const r = await transaction(async () => {
      const r = await db.prepare("SELECT * FROM overtime_requests WHERE id=? AND company_id=?").get(integer(Number(params.id)), companyId);
      if (!r) throw new HttpError(404, "Overtime claim not found.");
      if (!(await mayDecide(app, user, r.user_id))) throw new HttpError(403, "You cannot decide this claim.");
      if (r.status !== "pending") throw new HttpError(409, `This claim is already ${r.status}.`);
      const minutes = decision === "approved" ? (b.minutes === undefined ? r.minutes_claimed : Math.round(number(Number(b.minutes), "Minutes", 1, r.minutes_claimed))) : null;
      // A payroll run already approved for that month cannot take it any more.
      const closed = await db
        .prepare("SELECT id FROM payroll_runs WHERE company_id=? AND month=? AND status IN ('approved','paid')")
        .get(companyId, r.date.slice(0, 7));
      const moved = await db
        .prepare("UPDATE overtime_requests SET status=?,minutes_approved=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending'")
        .run(decision, minutes, user.id, nowIso(), note, r.id);
      if (!moved.changes) throw new HttpError(409, "This claim has changed. Refresh and try again.");
      await app.audit(user, `overtime_${decision}`, { id: r.id, employeeId: r.user_id, minutes }, companyId);
      return { ...r, minutes, late: Boolean(closed) };
    });
    await app.notify([r.user_id], {
      companyId,
      kind: "approval",
      title:
        decision === "approved"
          ? `Your overtime for ${r.date} was approved (${otLabel(r.minutes).replace("Overtime ", "")})`
          : `Your overtime for ${r.date} was not approved`,
      body: decision === "rejected" ? note : r.late ? "It will be paid in the next payroll run." : null,
      link: "myattendance",
    });
    return send(200, { ok: true, minutes: r.minutes });
  });

  // ---- HR / payroll -----------------------------------------------------------------------
  router.get("/api/admin/overtime-settings", { perm: "payroll.read" }, async ({ companyId, send }) =>
    send(200, await overtimeSettings(db, companyId)),
  );
  router.patch("/api/admin/overtime-settings", { perm: "payroll.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const s = await overtimeSettings(db, companyId);
    const next = {
      ot_enabled: b.ot_enabled === undefined ? s.ot_enabled : Boolean(b.ot_enabled),
      ot_min_minutes: b.ot_min_minutes === undefined ? s.ot_min_minutes : Math.round(number(Number(b.ot_min_minutes), "Minimum minutes", 15, 240)),
      ot_max_minutes: b.ot_max_minutes === undefined ? s.ot_max_minutes : Math.round(number(Number(b.ot_max_minutes), "Most minutes a day", 30, 720)),
      ot_rate: b.ot_rate === undefined ? s.ot_rate : number(Number(b.ot_rate), "Rate", 1, 3),
      ot_basis: b.ot_basis === undefined ? s.ot_basis : oneOf(b.ot_basis, "Paid on", ["basic", "gross"]),
      ot_days_per_month: b.ot_days_per_month === undefined ? s.ot_days_per_month : Math.round(number(Number(b.ot_days_per_month), "Days a month", 20, 31)),
      ot_hours_per_day: b.ot_hours_per_day === undefined ? s.ot_hours_per_day : number(Number(b.ot_hours_per_day), "Hours a day", 4, 12),
      ot_claim_days: b.ot_claim_days === undefined ? s.ot_claim_days : Math.round(number(Number(b.ot_claim_days), "Days to claim", 1, 31)),
    };
    if (next.ot_min_minutes > next.ot_max_minutes) throw new HttpError(400, "The minimum must not be more than the daily most.");
    await db
      .prepare(`UPDATE companies SET ${Object.keys(next).map((k) => `${k}=?`).join(",")} WHERE id=?`)
      .run(...Object.values(next).map((v) => (typeof v === "boolean" ? Number(v) : v)), companyId);
    await audit("overtime_settings_updated", next);
    return send(200, next);
  });
  router.get("/api/admin/overtime", { perm: "payroll.read" }, async ({ companyId, query, send }) => {
    const month = String(query.get("month") ?? "");
    if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpError(400, "Choose a month like 2026-10.");
    return send(
      200,
      await db.prepare(`${SELECT} WHERE o.company_id=? AND substr(o.date,1,7)=? AND o.status IN ('pending','approved') ORDER BY u.name,o.date`).all(companyId, month),
    );
  });
}
