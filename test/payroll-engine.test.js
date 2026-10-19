import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSalaryLines,
  ceilingSegments,
  computePayslip,
  daysInMonth,
  DEFAULT_CONFIG,
  esiContributions,
  pfContributions,
  pfWages,
  professionalTax,
  round,
} from "../server/payroll/engine.js";
import {
  ageCategory,
  incomeTax,
  monthsLeft,
  taxYearOf,
} from "../server/payroll/tax.js";
import { PT_PRESETS } from "../server/payroll/statutory.js";

const COMPONENTS = [
  {
    id: 1,
    code: "BASIC",
    name: "Basic",
    calc: "percent_of_gross",
    value: 50,
    is_basic: 1,
    taxable: 1,
    esi_wage: 1,
  },
  {
    id: 2,
    code: "HRA",
    name: "HRA",
    calc: "percent_of_basic",
    value: 40,
    is_basic: 0,
    taxable: 1,
    esi_wage: 1,
  },
  {
    id: 3,
    code: "SPECIAL",
    name: "Special allowance",
    calc: "balance",
    value: 0,
    is_basic: 0,
    taxable: 1,
    esi_wage: 1,
  },
];
const lines = (gross, components = COMPONENTS) =>
  buildSalaryLines(components, gross).map((l) => ({
    ...components.find((c) => c.id === l.component_id),
    ...l,
  }));
const slabs = (state) =>
  PT_PRESETS[state].map(([from_amount, to_amount, amount, gender, month]) => ({
    from_amount,
    to_amount,
    amount,
    gender,
    month,
  }));
const base = (over = {}) => ({
  month: "2026-10",
  lines: lines(60000),
  attendance: { paid_days: 31 },
  flags: {
    pf_applicable: true,
    esi_applicable: false,
    pt_applicable: false,
    eps_eligible: true,
    tax_regime: "new",
    declared_deductions: 0,
  },
  ytd: { taxable_income: 360000, tds_deducted: 0 },
  ...over,
});

test("rounding helpers and calendar facts", () => {
  assert.equal(round(2082.5), 2083);
  assert.equal(
    round(2082.4999999999995),
    2083,
    "floating-point noise does not flip a half",
  );
  assert.equal(round(0.4), 0);
  assert.equal(daysInMonth("2026-02"), 28);
  assert.equal(daysInMonth("2028-02"), 29);
  assert.equal(taxYearOf("2027-02"), 2026);
  assert.equal(taxYearOf("2026-04"), 2026);
  assert.deepEqual(
    ["2026-04", "2026-10", "2027-03"].map(monthsLeft),
    [12, 6, 1],
  );
  assert.equal(ageCategory("1960-05-01", 2026), "senior");
  assert.equal(ageCategory("1940-05-01", 2026), "super_senior");
  assert.equal(ageCategory("1990-05-01", 2026), "general");
  assert.equal(ageCategory(null, 2026), "general");
});

test("salary structure: percentages, dependent components and a balancing figure", () => {
  assert.deepEqual(
    buildSalaryLines(COMPONENTS, 60000).map((l) => l.amount),
    [30000, 12000, 18000],
  );
  // Odd amounts: the balancing component absorbs rounding so the total is exact.
  const odd = buildSalaryLines(COMPONENTS, 33333);
  assert.deepEqual(
    odd.map((l) => l.amount),
    [16667, 6667, 9999],
  );
  assert.equal(
    odd.reduce((s, l) => s + l.amount, 0),
    33333,
  );
  const fixed = [
    ...COMPONENTS,
    {
      id: 4,
      code: "CONV",
      name: "Conveyance",
      calc: "fixed",
      value: 1600,
      is_basic: 0,
    },
  ];
  assert.deepEqual(
    buildSalaryLines(fixed, 60000).map((l) => l.amount),
    [30000, 12000, 18000 - 1600, 1600],
  );
  assert.throws(
    () => buildSalaryLines(COMPONENTS.slice(0, 2), 60000),
    /balancing/,
  );
  assert.throws(() => buildSalaryLines(fixed, 5000), /more than the gross/);
  assert.throws(
    () => buildSalaryLines([COMPONENTS[1], COMPONENTS[2]], 60000),
    /basic/,
  );
  assert.equal(
    buildSalaryLines([...COMPONENTS, { ...fixed[3], active: 0 }], 60000).length,
    3,
    "inactive components are skipped",
  );
});

test("provident fund matches the EPFO worked examples", () => {
  assert.deepEqual(ceilingSegments("2026-10"), [{ ceiling: 25000, days: 31 }]);
  assert.deepEqual(ceilingSegments("2026-09"), [
    { ceiling: 15000, days: 16 },
    { ceiling: 25000, days: 14 },
  ]);
  assert.deepEqual(ceilingSegments("2026-08"), [{ ceiling: 15000, days: 31 }]);
  // From October 2026: [employee, EPS, EPF, EDLI] per EPFO FAQ 13.
  const row = (w, o) => {
    const p = pfContributions(w, "2026-10", o);
    return [p.employee, p.employerEps, p.employerEpf, p.edli];
  };
  assert.deepEqual(row(10000), [1200, 833, 367, 50]);
  assert.deepEqual(row(15000), [1800, 1250, 550, 75]);
  assert.deepEqual(row(20000), [2400, 1666, 734, 100]);
  assert.deepEqual(row(25000), [3000, 2083, 917, 125]);
  assert.deepEqual(
    row(35000, { epsEligible: false }),
    [3000, 0, 3000, 125],
    "above the ceiling and not in EPS",
  );
  assert.deepEqual(row(35000), [3000, 2083, 917, 125]);
  // Before the revision the old ceiling applies.
  const aug = pfContributions(20000, "2026-08");
  assert.deepEqual(
    [aug.employee, aug.employerEps, aug.employerEpf],
    [1800, 1250, 550],
  );
  // September 2026 straddles the revision (FAQ 7, scenario C: 20,000 on the old cap).
  const sep = pfContributions(20000, "2026-09");
  assert.equal(sep.base, 17333.33);
  assert.deepEqual(
    [sep.employee, sep.employerEps, sep.employerEpf, sep.edli],
    [2080, 1444, 636, 87],
  );
  // Contributing on actual wages instead of the cap.
  assert.equal(
    pfContributions(40000, "2026-10", { restrictToCeiling: false }).employee,
    4800,
  );
});

test("labour-code wage definition: PF wages are at least half of remuneration", () => {
  assert.equal(pfWages(18000, 60000, true), 30000);
  assert.equal(pfWages(30000, 60000, true), 30000);
  assert.equal(pfWages(40000, 60000, true), 40000);
  assert.equal(pfWages(18000, 60000, false), 18000);
});

test("ESI rounds up, is decided on the full wage, and is paid on earned wages", () => {
  assert.deepEqual(esiContributions(11402, 11402), {
    wages: 11402,
    employee: 86,
    employer: 371,
  });
  assert.deepEqual(esiContributions(21000, 21000).employee, 158);
  assert.deepEqual(esiContributions(21001, 21001), {
    wages: 21001,
    employee: 0,
    employer: 0,
  });
  // Half the month lost: covered on 20,000, paid on the 10,000 actually earned.
  assert.deepEqual(esiContributions(20000, 10000), {
    wages: 10000,
    employee: 75,
    employer: 325,
  });
  assert.deepEqual(esiContributions(20000, 0), {
    wages: 0,
    employee: 0,
    employer: 0,
  });
});

test("professional tax slabs, gender and month-specific amounts", () => {
  const pt = (state, gross, gender = "male", monthNumber = 10) =>
    professionalTax(slabs(state), { gross, gender, monthNumber });
  assert.deepEqual(
    [7500, 9000, 15000].map((g) => pt("Maharashtra", g)),
    [0, 175, 200],
  );
  assert.equal(pt("Maharashtra", 15000, "male", 2), 300, "February is higher");
  assert.deepEqual(
    [20000, 25000, 30000].map((g) => pt("Maharashtra", g, "female")),
    [0, 0, 200],
  );
  assert.equal(
    pt("Maharashtra", 9000, "other"),
    175,
    "unlisted gender falls back to the default scale",
  );
  assert.equal(pt("Maharashtra", 9000, null), 175);
  assert.deepEqual(
    [24999, 25000].map((g) => pt("Karnataka", g)),
    [0, 200],
  );
  assert.deepEqual(
    [10000, 12000, 20000, 45000].map((g) => pt("West Bengal", g)),
    [0, 110, 130, 200],
  );
  assert.deepEqual(
    [15000, 18000, 21000].map((g) => pt("Telangana", g)),
    [0, 150, 200],
  );
  assert.deepEqual(
    [12000, 12001].map((g) => pt("Gujarat", g)),
    [0, 200],
  );
  assert.equal(
    professionalTax([], { gross: 50000, gender: "male", monthNumber: 1 }),
    0,
    "no slabs, no tax",
  );
});

test("income tax follows the FY 2026-27 rules with rebate, marginal relief, surcharge and cess", () => {
  const nw = (income, age) => incomeTax("new", income, { taxYear: 2026, age });
  assert.equal(nw(400000), 0);
  assert.equal(nw(925000), 0, "inside the 87A rebate");
  assert.equal(nw(1200000), 0, "exactly 12 lakh");
  assert.equal(
    nw(1250000),
    52000,
    "marginal relief: tax capped at the excess, then 4% cess",
  );
  assert.equal(
    nw(1270000),
    72800,
    "just past the relief zone: 70,000 cap is still lower than 70,500",
  );
  assert.equal(
    nw(1280000),
    74880,
    "relief zone over: slab tax 72,000 plus cess",
  );
  assert.equal(nw(1425000), 97500);
  assert.equal(nw(2400000), 312000, "3,00,000 slab tax plus cess");
  assert.equal(nw(5050000), 1175200, "surcharge marginal relief at 50.5 lakh");
  assert.equal(nw(6000000), 1578720, "10% surcharge");
  assert.equal(nw(-5), 0);
  const old = (income, age) => incomeTax("old", income, { taxYear: 2026, age });
  assert.equal(old(250000), 0);
  assert.equal(old(500000), 0, "old-regime rebate");
  assert.equal(old(500100), Math.round((12500 + 20) * 1.04));
  assert.equal(old(1050000), 132600);
  assert.equal(
    old(400000, "senior"),
    0,
    "5,000 of slab tax is wiped out by the old-regime rebate",
  );
  assert.equal(old(1000000, "senior"), Math.round((10000 + 100000) * 1.04));
  assert.equal(old(1000000, "super_senior"), Math.round(100000 * 1.04));
  assert.throws(() => incomeTax("flat", 1), /No tax rules/);
});

test("a full month's payslip, with employer contributions", () => {
  const p = computePayslip(base());
  assert.deepEqual(
    p.earnings.map((e) => e.amount),
    [30000, 12000, 18000],
  );
  assert.equal(p.gross_earnings, 60000);
  assert.deepEqual(
    [p.pf.employee, p.pf.employerEps, p.pf.employerEpf, p.pf.edli, p.pf.admin],
    [3000, 2083, 917, 125, 125],
  );
  assert.equal(
    p.tds.this_month,
    0,
    "projected income of 7.2 lakh is inside the rebate",
  );
  assert.deepEqual(
    p.deductions.map((d) => [d.code, d.amount]),
    [["PF", 3000]],
  );
  assert.equal(p.net_pay, 57000);
  assert.equal(p.employer_cost, 63250, "gross plus EPF, EPS, EDLI and admin");
  assert.deepEqual(p.warnings, []);
});

test("loss of pay prorates every component and the contributions that follow", () => {
  const p = computePayslip(base({ attendance: { paid_days: 24 } }));
  assert.deepEqual(
    p.earnings.map((e) => e.amount),
    [23226, 9290, 13935],
  );
  assert.equal(p.gross_earnings, 46451);
  assert.equal(p.lop_days, 7);
  assert.equal(p.pf.wages, 23226);
  assert.equal(p.pf.employee, 2787);
  const none = computePayslip(base({ attendance: { paid_days: 0 } }));
  assert.equal(none.gross_earnings, 0);
  assert.ok(none.warnings.includes("no_paid_days"));
  assert.equal(
    computePayslip(base({ attendance: { paid_days: 99 } })).gross_earnings,
    60000,
    "paid days are capped at the month",
  );
});

test("the 50% wage rule raises PF wages when basic is low, and can be turned off", () => {
  const lowBasic = [
    { ...COMPONENTS[0], value: 30 },
    COMPONENTS[1],
    COMPONENTS[2],
  ];
  const withRule = computePayslip(base({ lines: lines(60000, lowBasic) }));
  assert.equal(withRule.pf.wages, 30000);
  assert.equal(withRule.pf.employee, 3000);
  assert.ok(withRule.warnings.includes("pf_wages_raised_to_50_percent"));
  const off = {
    ...DEFAULT_CONFIG,
    pf: { ...DEFAULT_CONFIG.pf, applyWageCode50Rule: false },
  };
  const without = computePayslip(
    base({ lines: lines(60000, lowBasic), config: off }),
  );
  assert.equal(without.pf.wages, 18000);
  assert.equal(without.pf.employee, 2160);
});

test("statutory deductions can be switched off per company and per employee", () => {
  assert.equal(
    computePayslip(
      base({
        config: {
          ...DEFAULT_CONFIG,
          pf: { ...DEFAULT_CONFIG.pf, enabled: false },
        },
      }),
    ).pf,
    null,
  );
  assert.equal(
    computePayslip(base({ flags: { ...base().flags, pf_applicable: false } }))
      .pf,
    null,
  );
  const esi = computePayslip(
    base({
      lines: lines(20000),
      flags: { ...base().flags, esi_applicable: true },
    }),
  );
  assert.deepEqual([esi.esi.employee, esi.esi.employer], [150, 650]);
  assert.deepEqual(
    esi.deductions.map((d) => d.code),
    ["PF", "ESI"],
  );
  assert.equal(
    computePayslip(
      base({
        lines: lines(30000),
        flags: { ...base().flags, esi_applicable: true },
      }),
    ).esi.employee,
    0,
  );
});

test("professional tax is taken from the employee's state slabs", () => {
  const input = base({
    lines: lines(30000),
    flags: { ...base().flags, pt_applicable: true },
    person: { gender: "male" },
    ptSlabs: slabs("Karnataka"),
  });
  const p = computePayslip(input);
  assert.equal(p.professional_tax, 200);
  assert.ok(p.deductions.some((d) => d.code === "PT" && d.amount === 200));
  assert.equal(
    computePayslip({ ...input, ptSlabs: [] }).professional_tax,
    0,
    "no PT where the state has none",
  );
});

test("TDS projects the year and spreads the remaining tax over the remaining months", () => {
  // 2 lakh a month with 12 lakh already earned: 24 lakh a year, 23.25 lakh after the standard deduction.
  const big = base({
    lines: lines(200000),
    ytd: { taxable_income: 1200000, tds_deducted: 0 },
  });
  const p = computePayslip(big);
  assert.equal(p.tds.projected_income, 2400000);
  assert.equal(p.tds.taxable_income, 2325000);
  assert.equal(p.tds.annual_tax, 292500);
  assert.equal(p.tds.months_left, 6);
  assert.equal(p.tds.this_month, 48750);
  assert.equal(p.net_pay, 200000 - 3000 - 48750);
  // Tax already deducted reduces what is left to collect.
  assert.equal(
    computePayslip({
      ...big,
      ytd: { taxable_income: 1200000, tds_deducted: 100000 },
    }).tds.this_month,
    32083,
  );
  // Over-deduction never produces a negative TDS.
  assert.equal(
    computePayslip({
      ...big,
      ytd: { taxable_income: 1200000, tds_deducted: 400000 },
    }).tds.this_month,
    0,
  );
  // March is the last month: everything still due is collected.
  const march = computePayslip({
    ...big,
    month: "2027-03",
    ytd: { taxable_income: 2200000, tds_deducted: 250000 },
  });
  assert.equal(march.tds.months_left, 1);
  assert.equal(
    march.tds.this_month,
    Math.max(0, march.tds.annual_tax - 250000),
  );
  // A one-off taxable bonus lifts the projection; a non-taxable adjustment does not.
  const bonus = computePayslip({
    ...big,
    adjustments: [
      { kind: "earning", name: "Bonus", amount: 120000, taxable: 1 },
    ],
  });
  assert.ok(bonus.tds.this_month > p.tds.this_month);
  assert.equal(bonus.gross_earnings, 320000);
  const reimb = computePayslip({
    ...big,
    adjustments: [
      { kind: "earning", name: "Reimbursement", amount: 5000, taxable: 0 },
    ],
  });
  assert.equal(reimb.tds.this_month, p.tds.this_month);
  assert.equal(reimb.gross_earnings, 205000);
  // Switching off TDS.
  assert.equal(
    computePayslip({
      ...big,
      config: { ...DEFAULT_CONFIG, tds: { enabled: false } },
    }).tds,
    null,
  );
});

test("old regime counts declared deductions and professional tax", () => {
  const old = {
    ...base().flags,
    pf_applicable: false,
    tax_regime: "old",
    declared_deductions: 150000,
  };
  const p = computePayslip(
    base({ month: "2026-04", lines: lines(100000), flags: old, ytd: {} }),
  );
  // 12 lakh a year, less 50,000 standard and 1,50,000 declared: 10 lakh taxable.
  assert.equal(p.tds.taxable_income, 1000000);
  assert.equal(p.tds.annual_tax, 117000);
  assert.equal(p.tds.this_month, 9750);
  // Professional tax of 200 a month lowers taxable income by 2,400 over the year.
  const withPt = computePayslip(
    base({
      month: "2026-04",
      lines: lines(100000),
      flags: { ...old, pt_applicable: true },
      ptSlabs: slabs("Karnataka"),
      person: { gender: "male" },
      ytd: {},
    }),
  );
  assert.equal(withPt.tds.taxable_income, 997600);
});

test("one-off earnings and deductions", () => {
  const p = computePayslip(
    base({
      adjustments: [
        { kind: "earning", name: "Arrears", amount: 5000, taxable: 1 },
        { kind: "deduction", name: "Salary advance", amount: 2000 },
      ],
    }),
  );
  assert.equal(p.gross_earnings, 65000);
  assert.deepEqual(p.deductions.map((d) => [d.name, d.amount]).slice(-1), [
    ["Salary advance", 2000],
  ]);
  assert.equal(p.net_pay, 65000 - 3000 - 2000);
  const broke = computePayslip(
    base({
      adjustments: [{ kind: "deduction", name: "Recovery", amount: 70000 }],
    }),
  );
  assert.ok(broke.net_pay < 0);
  assert.ok(
    broke.warnings.includes("negative_net_pay") &&
      broke.warnings.includes("deductions_over_50_percent"),
  );
});
