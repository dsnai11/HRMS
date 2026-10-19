import { computePayslip } from "./engine.js";

export const nextMonth = (month) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 7);
};
const monthText = (m) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${m}-01T00:00:00Z`));

/**
 * What a back-dated salary would have paid, month by month, against what the
 * approved runs actually paid. Provident fund is included; ESI, professional tax
 * and TDS are not recomputed (TDS catches up through the projection).
 */
export async function computeArrears(
  app,
  { companyId, userId, effective, locked, lines, flags, config },
) {
  const effMonth = effective.slice(0, 7);
  // A later salary already on file still governs the months from its own start.
  const later = (
    await app.db
      .prepare(
        "SELECT MIN(substr(effective_from,1,7)) m FROM employee_salaries WHERE user_id=? AND substr(effective_from,1,7)>?",
      )
      .get(userId, effMonth)
  ).m;
  const items = await app.db
    .prepare(
      "SELECT r.month,i.data FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.user_id=? AND r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=? ORDER BY r.month",
    )
    .all(userId, companyId, effMonth, locked);
  const quiet = {
    ...config,
    esi: { enabled: false },
    pt: { enabled: false },
    tds: { enabled: false },
  };
  const rows = [];
  for (const item of items) {
    if (later && item.month >= later) continue;
    const old = JSON.parse(item.data);
    const oldGross = old.earnings
      .filter((e) => e.code !== "ADJ")
      .reduce((s, e) => s + e.amount, 0);
    const slip = computePayslip({
      month: item.month,
      config: quiet,
      lines,
      attendance: { paid_days: old.paid_days },
      adjustments: [],
      flags: { ...flags, esi_applicable: false, pt_applicable: false },
      ytd: {},
    });
    rows.push({
      month: item.month,
      old_gross: oldGross,
      new_gross: slip.gross_earnings,
      gross_diff: slip.gross_earnings - oldGross,
      pf_diff: (slip.pf?.employee ?? 0) - (old.pf?.employee ?? 0),
    });
  }
  const changed = rows.filter((r) => r.gross_diff || r.pf_diff);
  return {
    pay_in_month: nextMonth(locked),
    rows,
    total_gross: rows.reduce((s, r) => s + r.gross_diff, 0),
    total_pf: rows.reduce((s, r) => s + r.pf_diff, 0),
    label: changed.length
      ? `Arrears ${monthText(changed[0].month)}${changed.length > 1 ? ` – ${monthText(changed.at(-1).month)}` : ""}`
      : "Arrears",
  };
}
