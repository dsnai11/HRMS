import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BONUS,
  encashmentRate,
  gratuity,
  gratuityYears,
  loanSchedule,
  serviceBetween,
  statutoryBonus,
} from "../server/payroll/extras.js";

test("loan instalments are whole rupees and add back to the principal", () => {
  assert.deepEqual(loanSchedule(12000, 4, "2026-11"), [
    { month: "2026-11", amount: 3000 },
    { month: "2026-12", amount: 3000 },
    { month: "2027-01", amount: 3000 },
    { month: "2027-02", amount: 3000 },
  ]);
  const odd = loanSchedule(10000, 3, "2026-12");
  assert.deepEqual(
    odd.map((s) => s.amount),
    [3333, 3333, 3334],
  );
  assert.deepEqual(
    odd.map((s) => s.month),
    ["2026-12", "2027-01", "2027-02"],
    "rolls over the year",
  );
  assert.equal(
    odd.reduce((s, x) => s + x.amount, 0),
    10000,
  );
  assert.deepEqual(loanSchedule(500, 1, "2026-11"), [
    { month: "2026-11", amount: 500 },
  ]);
});

test("statutory bonus: eligibility, the calculation floor and the rate", () => {
  const year = (wages, days = 30) =>
    Array.from({ length: 12 }, () => ({
      wages,
      paid_days: days,
      days_in_month: 30,
    }));
  assert.equal(BONUS.eligibilityCeiling, 21000);
  // Wages of 15,000 are capped at 7,000 for the calculation: 7,000 × 12 × 8.33% = 6,997.20.
  assert.deepEqual(statutoryBonus(year(15000), { rate: 8.33 }), {
    eligible: true,
    amount: 6997,
    days: 360,
    base: 84000,
    ceiling: 7000,
  });
  assert.equal(statutoryBonus(year(15000), { rate: 20 }).amount, 16800);
  // A higher minimum wage raises the calculation wage (but never above the actual wage).
  assert.equal(
    statutoryBonus(year(15000), { rate: 8.33, minimumWage: 10000 }).amount,
    round2(10000 * 12 * 0.0833),
  );
  assert.equal(
    statutoryBonus(year(5000), { rate: 8.33 }).base,
    60000,
    "wages below the floor count as they are",
  );
  // Above 21,000 a month there is no entitlement.
  assert.deepEqual(statutoryBonus(year(21001), { rate: 20 }), {
    eligible: false,
    amount: 0,
    days: 0,
    base: 0,
    ceiling: 7000,
  });
  // Part-year employees are paid in proportion; fewer than 30 days earns nothing.
  assert.equal(
    statutoryBonus(
      [
        { wages: 7000, paid_days: 15, days_in_month: 30 },
        { wages: 7000, paid_days: 15, days_in_month: 30 },
      ],
      { rate: 10 },
    ).amount,
    700,
  );
  assert.equal(
    statutoryBonus([{ wages: 7000, paid_days: 29, days_in_month: 30 }], {
      rate: 10,
    }).eligible,
    false,
  );
  assert.equal(statutoryBonus([], { rate: 10 }).eligible, false);
});
const round2 = (n) => Math.floor(n + 0.5 + 1e-9);

test("gratuity counts completed years, a part-year over six months, and the 20 lakh cap", () => {
  assert.deepEqual(serviceBetween("2020-01-15", "2026-10-19"), {
    months: 81,
    extraDays: 4,
    years: 6,
  });
  assert.equal(
    serviceBetween("2026-10-19", "2026-10-18").months,
    0,
    "not yet a month",
  );
  assert.equal(
    gratuityYears({ months: 6 * 12 + 6, extraDays: 0 }),
    6,
    "exactly six months does not round up",
  );
  assert.equal(gratuityYears({ months: 6 * 12 + 6, extraDays: 1 }), 7);
  assert.equal(gratuityYears({ months: 6 * 12 + 7, extraDays: 0 }), 7);
  assert.equal(gratuityYears({ months: 5 * 12 + 2, extraDays: 0 }), 5);
  // Reference example: wages 50,000, 9 years counted (8 years 7 months) = 2,59,615.
  const ref = gratuity({
    wages: 50000,
    joined: "2018-03-01",
    asOf: "2026-10-05",
  });
  assert.deepEqual(
    [ref.service_years, ref.counted_years, ref.eligible, ref.payable],
    [8, 9, true, 259615],
  );
  // Not yet eligible: nothing is payable, but a provision accrues.
  const early = gratuity({
    wages: 50000,
    joined: "2024-01-01",
    asOf: "2026-10-19",
  });
  assert.deepEqual(
    [early.eligible, early.payable, early.eligible_after_years],
    [false, 0, 5],
  );
  assert.equal(
    early.provision,
    Math.floor((50000 * 15 * (33 / 12)) / 26 + 0.5),
  );
  // Fixed-term staff qualify after a year; interns and consultants never.
  assert.equal(
    gratuity({
      wages: 30000,
      joined: "2025-06-01",
      asOf: "2026-10-19",
      employmentType: "contract",
    }).eligible,
    true,
  );
  assert.equal(
    gratuity({
      wages: 30000,
      joined: "2020-06-01",
      asOf: "2026-10-19",
      employmentType: "intern",
    }).eligible,
    false,
  );
  // The statutory cap.
  assert.equal(
    gratuity({ wages: 500000, joined: "2000-01-01", asOf: "2026-10-19" })
      .payable,
    2000000,
  );
});

test("leave encashment per-day rate follows the company's basis", () => {
  const lines = [
    { amount: 30000, is_basic: true },
    { amount: 12000, is_basic: false },
    { amount: 18000, is_basic: false },
  ];
  assert.equal(encashmentRate(lines), 1000);
  assert.equal(encashmentRate(lines, { basis: "gross", divisor: 30 }), 2000);
  assert.equal(
    encashmentRate(lines, { basis: "basic", divisor: 26 }),
    30000 / 26,
  );
});
