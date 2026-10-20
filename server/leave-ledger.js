import { isWeeklyOff, leaveYearOf, monthIndexInYear } from "./calendar.js";

const round2 = (n) => Math.round(n * 100) / 100;
const parse = (text, fallback) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

export async function companySettings(db, companyId) {
  const c = await db
    .prepare("SELECT * FROM companies WHERE id=?")
    .get(companyId);
  return {
    leaveYearStartMonth: c.leave_year_start_month,
    leaveStartYear: c.leave_start_year,
    weekOff: {
      days: parse(c.weekly_off_days, [0]),
      saturdays: parse(c.weekly_off_saturdays, []),
    },
    attendanceStart: c.attendance_start_date || c.created_at.slice(0, 10),
    attendanceStartSet: c.attendance_start_date,
    regularizationWindowDays: c.regularization_window_days,
    regularizationMonthlyLimit: c.regularization_monthly_limit,
  };
}

// Holidays that apply to a branch: company-wide ones plus that branch's own.
export async function holidayMap(db, companyId, branchId, from, to) {
  const rows = await db
    .prepare(
      "SELECT date,name FROM holidays WHERE company_id=? AND date>=? AND date<=? AND (branch_id IS NULL OR branch_id=?) ORDER BY date",
    )
    .all(companyId, from, to, branchId ?? -1);
  return new Map(rows.map((r) => [r.date, r.name]));
}

/** 'holiday', 'weekly_off', or null for an ordinary working day. */
export const dayKind = (date, settings, holidays) =>
  holidays.has(date)
    ? "holiday"
    : isWeeklyOff(date, settings.weekOff)
      ? "weekly_off"
      : null;

const applies = (type, user) =>
  !type.applicable_gender || type.applicable_gender === user.gender;

async function addEntry(
  app,
  user,
  type,
  year,
  kind,
  days,
  period,
  note = null,
  createdBy = null,
) {
  await app.db
    .prepare(
      "INSERT INTO leave_ledger(company_id,user_id,leave_type_id,leave_year,kind,days,period,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING",
    )
    .run(
      user.company_id,
      user.id,
      type.id,
      year,
      kind,
      days,
      period,
      note,
      createdBy,
      new Date(app.clock()).toISOString(),
    );
}

// Accrues one leave year up to month `upTo` (1..12). Safe to repeat.
async function accrueYear(app, user, type, year, settings, upTo) {
  const quota = type.quota_per_year;
  if (type.unlimited || quota <= 0 || !applies(type, user)) return;
  if (settings.leaveStartYear === null || year < settings.leaveStartYear)
    return;
  let first = 1;
  if (user.date_of_joining) {
    const joinYear = leaveYearOf(
      user.date_of_joining,
      settings.leaveYearStartMonth,
    );
    if (joinYear > year) return;
    if (joinYear === year)
      first = monthIndexInYear(
        user.date_of_joining,
        settings.leaveYearStartMonth,
      );
  }
  if (type.accrual === "yearly") {
    if (upTo >= first)
      await addEntry(
        app,
        user,
        type,
        year,
        "accrual",
        round2((quota * (13 - first)) / 12),
        "Y",
      );
    return;
  }
  // Cumulative target rounded each month, so the year always totals the quota.
  for (let m = first; m <= upTo; m++) {
    const days =
      round2((quota * (m - first + 1)) / 12) -
      round2((quota * (m - first)) / 12);
    if (days > 0)
      await addEntry(app, user, type, year, "accrual", round2(days), `M${m}`);
  }
}

const yearBalance = async (db, userId, typeId, year) =>
  (
    await db
      .prepare(
        "SELECT COALESCE(SUM(days),0) n FROM leave_ledger WHERE user_id=? AND leave_type_id=? AND leave_year=?",
      )
      .get(userId, typeId, year)
  ).n;

/** Brings a person's ledger up to `asOf` (accruals, carry-forward). Idempotent. */
export async function ensureAccruals(app, user, asOf) {
  const settings = await companySettings(app.db, user.company_id);
  if (settings.leaveStartYear === null) return settings;
  const year = leaveYearOf(asOf, settings.leaveYearStartMonth);
  const types = await app.db
    .prepare(
      "SELECT * FROM leave_types WHERE company_id=? AND active=1 AND unlimited=0 AND (quota_per_year>0 OR carry_forward_max>0)",
    )
    .all(user.company_id);
  for (const type of types) {
    if (!applies(type, user)) continue;
    const prev = year - 1;
    if (type.carry_forward_max > 0 && prev >= settings.leaveStartYear) {
      await accrueYear(app, user, type, prev, settings, 12);
      const carry = Math.min(
        Math.max(await yearBalance(app.db, user.id, type.id, prev), 0),
        type.carry_forward_max,
      );
      if (carry > 0)
        await addEntry(
          app,
          user,
          type,
          year,
          "carry_forward",
          round2(carry),
          "CF",
        );
    }
    await accrueYear(
      app,
      user,
      type,
      year,
      settings,
      monthIndexInYear(asOf, settings.leaveYearStartMonth),
    );
  }
  return settings;
}

/** Balance per applicable leave type for the leave year containing `asOf`. */
export async function balances(app, user, asOf) {
  const settings = await ensureAccruals(app, user, asOf);
  const year = leaveYearOf(asOf, settings.leaveYearStartMonth);
  const types = await app.db
    .prepare(
      "SELECT * FROM leave_types WHERE company_id=? AND active=1 ORDER BY name",
    )
    .all(user.company_id);
  const out = [];
  for (const type of types) {
    if (!applies(type, user)) continue;
    const balance = await yearBalance(app.db, user.id, type.id, year);
    const pending = (
      await app.db
        .prepare(
          "SELECT COALESCE(SUM(days),0) n FROM leave_requests WHERE user_id=? AND leave_type_id=? AND leave_year=? AND status='pending'",
        )
        .get(user.id, type.id, year)
    ).n;
    out.push({
      leave_type_id: type.id,
      name: type.name,
      code: type.code,
      paid: Boolean(type.paid),
      unlimited: Boolean(type.unlimited),
      allow_half_day: Boolean(type.allow_half_day),
      year,
      balance: type.unlimited ? null : round2(balance),
      pending,
      available: type.unlimited ? null : round2(balance - pending),
    });
  }
  return out;
}

export { yearBalance, addEntry, round2 };
