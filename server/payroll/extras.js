import { round, daysInMonth } from "./engine.js";

// ---- loans and advances ------------------------------------------------------------
// Interest-free instalments in whole rupees; the last one absorbs the remainder.
export function loanSchedule(principal, installments, startMonth) {
  const base = Math.floor(principal / installments);
  const out = [];
  let [y, m] = startMonth.split("-").map(Number);
  for (let i = 0; i < installments; i++) {
    out.push({
      month: `${y}-${String(m).padStart(2, "0")}`,
      amount:
        i === installments - 1 ? principal - base * (installments - 1) : base,
    });
    if (++m > 12) [y, m] = [y + 1, 1];
  }
  return out;
}

// ---- statutory bonus -------------------------------------------------------------------
// Code on Wages: employees whose wages are up to ₹21,000 a month and who worked at
// least 30 days in the year are eligible; bonus is computed as if monthly wages were
// at most ₹7,000 or the minimum wage, whichever is higher; the rate is 8.33%–20%.
// Verified 19 Oct 2026 (Ministry of Labour notification, Lexology summary).
export const BONUS = {
  eligibilityCeiling: 21000,
  calculationFloor: 7000,
  minRate: 8.33,
  maxRate: 20,
  minDays: 30,
};

/**
 * months: [{ wages, paid_days, days_in_month }] for each approved month of the
 * year, where wages are the full-month statutory wages.
 */
export function statutoryBonus(months, { rate, minimumWage = 0 }) {
  const ceiling = Math.max(BONUS.calculationFloor, minimumWage);
  const counted = months.filter((m) => m.wages <= BONUS.eligibilityCeiling);
  const days = counted.reduce((s, m) => s + m.paid_days, 0);
  if (!counted.length || days < BONUS.minDays)
    return { eligible: false, amount: 0, days, base: 0, ceiling };
  const base = counted.reduce(
    (s, m) => s + Math.min(m.wages, ceiling) * (m.paid_days / m.days_in_month),
    0,
  );
  return {
    eligible: true,
    amount: round((base * rate) / 100),
    days,
    base: round(base),
    ceiling,
  };
}

// ---- gratuity -----------------------------------------------------------------------------
// 15 days' wages for every completed year of service, a part above six months
// counting as a year; wages are basic plus DA raised to 50% of pay (labour codes);
// capped at ₹20 lakh. Fixed-term employees qualify after one year, others after five.
// Verified 19 Oct 2026 (Code on Social Security 2020, s.53).
export const GRATUITY = {
  ceiling: 2000000,
  regularYears: 5,
  fixedTermYears: 1,
  days: 15,
  divisor: 26,
};

/** Whole months between two dates, plus whether any extra days remain. */
export function serviceBetween(from, to) {
  const [fy, fm, fd] = from.split("-").map(Number);
  const [ty, tm, td] = to.split("-").map(Number);
  let months = (ty - fy) * 12 + (tm - fm);
  if (td < fd) months -= 1;
  months = Math.max(months, 0);
  const anchor = new Date(Date.UTC(fy, fm - 1 + months, fd));
  const extraDays = Math.max(
    0,
    Math.round((Date.UTC(ty, tm - 1, td) - anchor.getTime()) / 86400000),
  );
  return { months, extraDays, years: Math.floor(months / 12) };
}
/** Years counted for the formula: completed years, plus one if the remainder exceeds six months. */
export function gratuityYears({ months, extraDays }) {
  const rem = months % 12;
  return (
    Math.floor(months / 12) + (rem > 6 || (rem === 6 && extraDays > 0) ? 1 : 0)
  );
}
export function gratuity({
  wages,
  joined,
  asOf,
  employmentType = "full_time",
}) {
  const svc = serviceBetween(joined, asOf);
  const needed =
    employmentType === "contract"
      ? GRATUITY.fixedTermYears
      : ["intern", "consultant"].includes(employmentType)
        ? null
        : GRATUITY.regularYears;
  const counted = gratuityYears(svc);
  const raw = (wages * GRATUITY.days * counted) / GRATUITY.divisor;
  const eligible = needed !== null && svc.years >= needed;
  return {
    service_years: svc.years,
    service_months: svc.months,
    counted_years: counted,
    eligible,
    eligible_after_years: needed,
    payable: eligible ? Math.min(GRATUITY.ceiling, round(raw)) : 0,
    // Accrual to date, shown whether or not the employee is yet eligible.
    provision: Math.min(
      GRATUITY.ceiling,
      round((wages * GRATUITY.days * (svc.months / 12)) / GRATUITY.divisor),
    ),
  };
}

// ---- leave encashment -------------------------------------------------------------------------
/** Per-day rate: basic (or gross) over a fixed divisor, by company policy. */
export const encashmentRate = (
  lines,
  { basis = "basic", divisor = 30 } = {},
) => {
  const monthly =
    basis === "gross"
      ? lines.reduce((s, l) => s + l.amount, 0)
      : lines.filter((l) => l.is_basic).reduce((s, l) => s + l.amount, 0);
  return monthly / divisor;
};
export { daysInMonth };
