// Statutory parameters for Indian payroll. Each block names its source and the
// date it was verified; update here (and add a test) when a rule changes.
// These are reference values for a payroll team to confirm, not legal advice.

// EPF/EPS/EDLI. Ceiling raised from 15,000 to 25,000 with effect from 17 Sep 2026
// (Notification S.O. 5109(E); EPFO FAQs). Rates are unchanged. Verified 19 Oct 2026.
export const PF = {
  employeeRate: 0.12,
  employerRate: 0.12,
  epsRate: 0.0833, // part of the employer's 12% that goes to the pension scheme
  edliRate: 0.005,
  adminRate: 0.005,
  ceilings: [
    { from: "2014-09-01", amount: 15000 },
    { from: "2026-09-17", amount: 25000 },
  ],
};

// ESI: wages up to 21,000 a month; contributions are rounded up to the next rupee.
// Verified 19 Oct 2026 (unchanged by the labour codes).
export const ESI = {
  ceiling: 21000,
  employeeRate: 0.0075,
  employerRate: 0.0325,
};

// Income tax for salary (TDS under s.192). Slabs are upper bounds with their rate.
// New regime: Budget 2025 slabs, unchanged by Budget 2026; rebate 60,000 up to
// 12,00,000 of income with marginal relief; standard deduction 75,000.
// Old regime: unchanged long-standing slabs; rebate 12,500 up to 5,00,000.
// Verified 19 Oct 2026 against CAclubindia's FY 2026-27 reference and the
// Income Tax Department rate page. The Income-tax Act 2025 (from 1 Apr 2026)
// renumbers sections but keeps these rates.
const NEW_REGIME = {
  slabs: [
    [400000, 0],
    [800000, 0.05],
    [1200000, 0.1],
    [1600000, 0.15],
    [2000000, 0.2],
    [2400000, 0.25],
    [Infinity, 0.3],
  ],
  standardDeduction: 75000,
  rebate: { limit: 1200000, max: 60000, marginalRelief: true },
  surcharge: [
    [20000000, 0.25],
    [10000000, 0.15],
    [5000000, 0.1],
  ],
};
const OLD_REGIME = {
  slabs: {
    general: [
      [250000, 0],
      [500000, 0.05],
      [1000000, 0.2],
      [Infinity, 0.3],
    ],
    senior: [
      [300000, 0],
      [500000, 0.05],
      [1000000, 0.2],
      [Infinity, 0.3],
    ],
    super_senior: [
      [500000, 0],
      [1000000, 0.2],
      [Infinity, 0.3],
    ],
  },
  standardDeduction: 50000,
  rebate: { limit: 500000, max: 12500, marginalRelief: false },
  surcharge: [
    [50000000, 0.37],
    [20000000, 0.25],
    [10000000, 0.15],
    [5000000, 0.1],
  ],
};
export const CESS = 0.04;
export const TAX_RULES = {
  2025: { new: NEW_REGIME, old: OLD_REGIME },
  2026: { new: NEW_REGIME, old: OLD_REGIME },
};
export const LATEST_TAX_YEAR = 2026;

// Professional tax is a state levy, so slabs are data a company can edit. These
// presets are starting points compiled from public summaries; confirm them with
// the state's current notification before use. Rajasthan, Delhi, UP and several
// other states levy no professional tax.
// Row: [from, to (null = no upper limit), tax per month, gender (null = any), month (null = any)]
export const PT_PRESETS = {
  Maharashtra: [
    [0, 7500, 0, "male", null],
    [7501, 10000, 175, "male", null],
    [10001, null, 200, "male", null],
    [10001, null, 300, "male", 2],
    [0, 25000, 0, "female", null],
    [25001, null, 200, "female", null],
    [25001, null, 300, "female", 2],
  ],
  Karnataka: [
    [0, 24999, 0, null, null],
    [25000, null, 200, null, null],
  ],
  "West Bengal": [
    [0, 10000, 0, null, null],
    [10001, 15000, 110, null, null],
    [15001, 25000, 130, null, null],
    [25001, 40000, 150, null, null],
    [40001, null, 200, null, null],
  ],
  Telangana: [
    [0, 15000, 0, null, null],
    [15001, 20000, 150, null, null],
    [20001, null, 200, null, null],
  ],
  Gujarat: [
    [0, 12000, 0, null, null],
    [12001, null, 200, null, null],
  ],
};
