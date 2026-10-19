import { CESS, LATEST_TAX_YEAR, TAX_RULES } from "./statutory.js";

const round = (n) => Math.floor(n + 0.5 + 1e-9);

function slabTax(slabs, income) {
  let tax = 0,
    lower = 0;
  for (const [upper, rate] of slabs) {
    if (income > lower) tax += (Math.min(income, upper) - lower) * rate;
    lower = upper;
    if (income <= upper) break;
  }
  return tax;
}

// Tax before cess for `income`, after rebate and with surcharge marginal relief.
function taxWithSurcharge(rules, slabs, income) {
  let tax = slabTax(slabs, income);
  const r = rules.rebate;
  if (income <= r.limit) tax = Math.max(0, tax - Math.min(tax, r.max));
  else if (r.marginalRelief) tax = Math.min(tax, income - r.limit);
  const band = rules.surcharge.find(([threshold]) => income > threshold);
  if (!band) return tax;
  const [threshold, rate] = band;
  const withSurcharge = tax * (1 + rate);
  // Marginal relief: total tax may not exceed the tax at the threshold plus the
  // income earned above it.
  const cap = taxWithSurcharge(rules, slabs, threshold) + (income - threshold);
  return Math.min(withSurcharge, cap);
}

/** "general" below 60, "senior" 60–79, "super_senior" 80 and over at the end of the tax year. */
export function ageCategory(dateOfBirth, taxYear) {
  if (!dateOfBirth) return "general";
  const age = taxYear + 1 - Number(dateOfBirth.slice(0, 4));
  return age >= 80 ? "super_senior" : age >= 60 ? "senior" : "general";
}

/**
 * Annual income tax payable on `taxableIncome` (after standard and other
 * deductions), including 4% cess, in whole rupees.
 */
export function incomeTax(
  regime,
  taxableIncome,
  { taxYear = LATEST_TAX_YEAR, age = "general" } = {},
) {
  const rules = TAX_RULES[Math.min(taxYear, LATEST_TAX_YEAR)]?.[regime];
  if (!rules)
    throw new Error(`No tax rules for ${regime} regime in ${taxYear}.`);
  const slabs = regime === "old" ? rules.slabs[age] : rules.slabs;
  const income = Math.max(0, Math.floor(taxableIncome));
  const tax = taxWithSurcharge(rules, slabs, income);
  return round(tax * (1 + CESS));
}

export const standardDeduction = (regime, taxYear = LATEST_TAX_YEAR) =>
  TAX_RULES[Math.min(taxYear, LATEST_TAX_YEAR)][regime].standardDeduction;

// Tax years run April to March and are named by the year they start in.
export const taxYearOf = (month) => {
  const [y, m] = month.split("-").map(Number);
  return m >= 4 ? y : y - 1;
};
// Months of the tax year left including `month` (April = 12, March = 1).
export const monthsLeft = (month) =>
  12 - ((Number(month.slice(5, 7)) - 4 + 12) % 12);
