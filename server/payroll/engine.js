import { PF, ESI } from "./statutory.js";
import {
  incomeTax,
  standardDeduction,
  taxYearOf,
  monthsLeft,
  ageCategory,
} from "./tax.js";

// Rounding conventions: pay components and most contributions round to the nearest
// rupee (halves up); ESI rounds up to the next rupee. The small epsilon guards
// against binary floating-point error (e.g. 2082.4999999999995 for 2082.5).
export const round = (n) => Math.floor(n + 0.5 + 1e-9);
const ceil = (n) => Math.ceil(n - 1e-9);

export const daysInMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};

export const DEFAULT_CONFIG = {
  pf: { enabled: true, restrictToCeiling: true, applyWageCode50Rule: true },
  esi: { enabled: true },
  pt: { enabled: true },
  tds: { enabled: true },
};

/** Turns a monthly gross into one amount per salary component. */
export function buildSalaryLines(components, monthlyGross) {
  const gross = round(monthlyGross);
  const active = components.filter((c) => c.active !== 0 && c.active !== false);
  const balance = active.filter((c) => c.calc === "balance");
  if (balance.length !== 1)
    throw new Error(
      "The salary structure needs exactly one balancing component.",
    );
  const amounts = new Map();
  const basic = active.find((c) => c.is_basic && c.calc === "percent_of_gross");
  // Gross-based and fixed amounts first, then those that depend on the basic.
  for (const c of active) {
    if (c.calc === "percent_of_gross")
      amounts.set(c.id, round((gross * c.value) / 100));
    else if (c.calc === "fixed") amounts.set(c.id, round(c.value));
  }
  for (const c of active)
    if (c.calc === "percent_of_basic") {
      if (!basic)
        throw new Error(
          "A component depends on the basic, but no basic is defined.",
        );
      amounts.set(c.id, round((amounts.get(basic.id) * c.value) / 100));
    }
  const used = [...amounts.values()].reduce((a, b) => a + b, 0);
  if (used > gross)
    throw new Error("The components add up to more than the gross.");
  amounts.set(balance[0].id, gross - used);
  return active.map((c) => ({
    component_id: c.id,
    code: c.code,
    name: c.name,
    amount: amounts.get(c.id),
  }));
}

// ---- provident fund ------------------------------------------------------------
// Days of `month` under each statutory ceiling (a month can straddle a revision).
export function ceilingSegments(month) {
  const dim = daysInMonth(month);
  const segs = [];
  for (let d = 1; d <= dim; d++) {
    const date = `${month}-${String(d).padStart(2, "0")}`;
    const ceiling = [...PF.ceilings]
      .reverse()
      .find((c) => c.from <= date).amount;
    const last = segs[segs.length - 1];
    if (last && last.ceiling === ceiling) last.days++;
    else segs.push({ ceiling, days: 1 });
  }
  return segs;
}
// Wage base for a month: wages capped at each ceiling, weighted by days under it.
const cappedWages = (wages, month) =>
  ceilingSegments(month).reduce(
    (sum, s) =>
      sum + (Math.min(wages, s.ceiling) * s.days) / daysInMonth(month),
    0,
  );

/**
 * Statutory PF wages: basic and DA, raised to 50% of total remuneration when the
 * labour codes' wage definition applies (allowances beyond 50% are added back).
 */
export const pfWages = (basicWages, remuneration, apply50) =>
  apply50 ? Math.max(basicWages, round(remuneration * 0.5)) : basicWages;

export function pfContributions(
  wages,
  month,
  { restrictToCeiling = true, epsEligible = true } = {},
) {
  const base = restrictToCeiling ? cappedWages(wages, month) : wages;
  const employee = round(base * PF.employeeRate);
  const employerTotal = round(base * PF.employerRate);
  const eps = epsEligible ? round(cappedWages(wages, month) * PF.epsRate) : 0;
  const edliWages = cappedWages(wages, month);
  return {
    wages: round(wages),
    eps_wages: round(edliWages),
    base: Math.round(base * 100) / 100,
    employee,
    employerEps: eps,
    employerEpf: employerTotal - eps,
    edli: round(edliWages * PF.edliRate),
    admin: round(edliWages * PF.adminRate),
  };
}

// ---- ESI -----------------------------------------------------------------------
// Coverage is decided on the full monthly wage; contributions are on wages earned.
export function esiContributions(fullMonthWages, earnedWages) {
  if (fullMonthWages > ESI.ceiling || earnedWages <= 0)
    return { wages: round(earnedWages), employee: 0, employer: 0 };
  return {
    wages: round(earnedWages),
    employee: ceil(earnedWages * ESI.employeeRate),
    employer: ceil(earnedWages * ESI.employerRate),
  };
}

// ---- professional tax ------------------------------------------------------------
/** Slab rows are { from_amount, to_amount, amount, gender, month }; the most specific match wins. */
export function professionalTax(slabs, { gross, gender, monthNumber }) {
  const forGender = (g) => slabs.filter((s) => !s.gender || s.gender === g);
  let rows = forGender(gender);
  // Unknown or unlisted gender: use the slabs written for men (the default scale).
  if (
    !rows.length ||
    (!slabs.some((s) => !s.gender) && !slabs.some((s) => s.gender === gender))
  )
    rows = forGender("male");
  const inBand = rows.filter(
    (s) =>
      gross >= s.from_amount && (s.to_amount === null || gross <= s.to_amount),
  );
  const specific =
    inBand.find((s) => s.month === monthNumber) ??
    inBand.find((s) => s.month === null);
  return specific ? specific.amount : 0;
}

// ---- the payslip --------------------------------------------------------------------
/**
 * Computes one employee's pay for a month.
 *   lines        monthly salary lines { code, name, amount, is_basic, taxable, esi_wage }
 *   attendance   { paid_days } from the muster
 *   adjustments  one-off { kind: "earning"|"deduction", name, amount, taxable }
 *   flags        { pf_applicable, esi_applicable, pt_applicable, eps_eligible, tax_regime, declared_deductions }
 *   person       { gender, date_of_birth }
 *   ptSlabs      slab rows for the employee's state
 *   ytd          { taxable_income, tds_deducted, pt_deducted } earned earlier this tax year
 */
export function computePayslip({
  month,
  config = DEFAULT_CONFIG,
  lines,
  attendance,
  adjustments = [],
  flags,
  person = {},
  ptSlabs = [],
  lwf = null,
  ytd = {},
}) {
  const dim = daysInMonth(month);
  const paidDays = Math.min(Math.max(attendance.paid_days, 0), dim);
  const ratio = paidDays / dim;
  const warnings = [];

  const earnings = lines.map((l) => ({
    ...l,
    full: l.amount,
    amount: round(l.amount * ratio),
  }));
  const regularGross = earnings.reduce((s, e) => s + e.amount, 0);
  const fullGross = lines.reduce((s, l) => s + l.amount, 0);
  const oneOffEarnings = adjustments.filter((a) => a.kind === "earning");
  const oneOffDeductions = adjustments.filter((a) => a.kind === "deduction");
  const grossEarnings =
    regularGross + oneOffEarnings.reduce((s, a) => s + a.amount, 0);

  // Provident fund.
  const basicEarned = earnings
    .filter((e) => e.is_basic)
    .reduce((s, e) => s + e.amount, 0);
  let pf = null;
  if (config.pf.enabled && flags.pf_applicable) {
    const wages = pfWages(
      basicEarned,
      regularGross,
      config.pf.applyWageCode50Rule,
    );
    pf = pfContributions(wages, month, {
      restrictToCeiling: config.pf.restrictToCeiling,
      epsEligible: flags.eps_eligible !== false,
    });
  }
  // ESI.
  let esi = null;
  if (config.esi.enabled && flags.esi_applicable) {
    const full = lines
      .filter((l) => l.esi_wage)
      .reduce((s, l) => s + l.amount, 0);
    const earned = earnings
      .filter((e) => e.esi_wage)
      .reduce((s, e) => s + e.amount, 0);
    esi = esiContributions(full, earned);
  }
  // Professional tax, on the month's gross.
  const ptAmount =
    config.pt.enabled && flags.pt_applicable && ptSlabs.length
      ? professionalTax(ptSlabs, {
          gross: grossEarnings,
          gender: person.gender,
          monthNumber: Number(month.slice(5, 7)),
        })
      : 0;

  // Labour welfare fund, in the months and for the wages the state's rule names.
  const lwfOn = lwf && (lwf.max_wage == null || regularGross <= lwf.max_wage);
  const lwfEmployee = lwfOn ? round(lwf.employee) : 0;
  const lwfEmployer = lwfOn ? round(lwf.employer) : 0;

  // Income tax (TDS): annual projection, less what has been deducted so far.
  const taxable = (list) =>
    list.filter((e) => e.taxable).reduce((s, e) => s + e.amount, 0);
  const taxableThisMonth = taxable(earnings) + taxable(oneOffEarnings);
  let tds = null,
    tdsAmount = 0;
  if (config.tds.enabled) {
    const regime = flags.tax_regime === "old" ? "old" : "new";
    const taxYear = taxYearOf(month);
    const left = monthsLeft(month);
    const fullTaxableMonth = taxable(lines);
    const projected =
      (ytd.taxable_income ?? 0) +
      taxableThisMonth +
      (left - 1) * fullTaxableMonth;
    let deductions = standardDeduction(regime, taxYear);
    if (regime === "old") {
      deductions += flags.declared_deductions ?? 0;
      deductions += (ytd.pt_deducted ?? 0) + ptAmount * left; // professional tax is deductible
    }
    const taxableIncome = Math.max(0, projected - deductions);
    const annualTax = incomeTax(regime, taxableIncome, {
      taxYear,
      age: ageCategory(person.date_of_birth, taxYear),
    });
    const remaining = annualTax - (ytd.tds_deducted ?? 0);
    tdsAmount = Math.max(0, round(remaining / left));
    tds = {
      regime,
      tax_year: `${taxYear}-${String(taxYear + 1).slice(2)}`,
      months_left: left,
      projected_income: Math.round(projected),
      deductions: Math.round(deductions),
      taxable_income: Math.round(taxableIncome),
      annual_tax: annualTax,
      already_deducted: ytd.tds_deducted ?? 0,
      this_month: tdsAmount,
    };
  }

  const deductionLines = [
    pf && {
      code: "PF",
      name: "Provident fund (employee)",
      amount: pf.employee,
    },
    esi &&
      esi.employee && {
        code: "ESI",
        name: "ESI (employee)",
        amount: esi.employee,
      },
    ptAmount && { code: "PT", name: "Professional tax", amount: ptAmount },
    lwfEmployee && {
      code: "LWF",
      name: "Labour welfare fund",
      amount: lwfEmployee,
    },
    tdsAmount && { code: "TDS", name: "Income tax (TDS)", amount: tdsAmount },
    ...oneOffDeductions.map((a) => ({
      code: "ADJ",
      name: a.name,
      amount: a.amount,
    })),
  ].filter(Boolean);
  const totalDeductions = deductionLines.reduce((s, d) => s + d.amount, 0);
  const net = grossEarnings - totalDeductions;
  const employer = {
    pf_epf: pf?.employerEpf ?? 0,
    pf_eps: pf?.employerEps ?? 0,
    edli: pf?.edli ?? 0,
    pf_admin: pf?.admin ?? 0,
    esi: esi?.employer ?? 0,
    lwf: lwfEmployer,
  };
  const employerContributions = Object.values(employer).reduce(
    (a, b) => a + b,
    0,
  );

  if (net < 0) warnings.push("negative_net_pay");
  if (paidDays === 0) warnings.push("no_paid_days");
  if (grossEarnings > 0 && totalDeductions > grossEarnings * 0.5)
    warnings.push("deductions_over_50_percent");
  if (
    config.pf.enabled &&
    flags.pf_applicable &&
    config.pf.applyWageCode50Rule &&
    pf &&
    basicEarned < regularGross * 0.5
  )
    warnings.push("pf_wages_raised_to_50_percent");

  return {
    month,
    days_in_month: dim,
    paid_days: paidDays,
    lop_days: Math.round((dim - paidDays) * 100) / 100,
    earnings: [
      ...earnings.map((e) => ({
        code: e.code,
        name: e.name,
        amount: e.amount,
        full: e.full,
      })),
      ...oneOffEarnings.map((a) => ({
        code: "ADJ",
        name: a.name,
        amount: a.amount,
      })),
    ],
    deductions: deductionLines,
    gross_earnings: grossEarnings,
    full_month_gross: fullGross,
    total_deductions: totalDeductions,
    net_pay: net,
    employer,
    employer_cost: grossEarnings + employerContributions,
    taxable_earnings: taxableThisMonth,
    pf,
    esi,
    professional_tax: ptAmount,
    tds,
    warnings,
  };
}
