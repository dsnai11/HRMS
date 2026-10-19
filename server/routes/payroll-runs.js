import { HttpError, csvCell, integer, isoDate, number } from "../http.js";
import { requireOwned } from "../scope.js";
import { computeMuster } from "../muster.js";
import { monthRange } from "../calendar.js";
import { computePayslip } from "../payroll/engine.js";
import { taxYearOf } from "../payroll/tax.js";
import { loadConfig, readPrivate } from "./payroll-setup.js";
import { encryptionKey } from "../crypto-store.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const monthName = (m) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${m}-01T00:00:00Z`));

export function registerPayrollRuns(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const currentMonth = () => app.dayOf(nowIso()).slice(0, 7);

  // Computes every payable employee for the run's month and replaces the run's items.
  async function computeRun(run) {
    const { company_id: companyId, month } = run;
    const config = await loadConfig(db, companyId);
    const muster = await computeMuster(app, { companyId, month });
    const musterOf = new Map(muster.people.map((p) => [p.user_id, p]));
    const people = await db
      .prepare(
        `SELECT u.id,u.name,u.employee_code,u.gender,u.date_of_birth,b.state branch_state,d.name department_name,g.name designation_name
         FROM users u LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN designations g ON g.id=u.designation_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' ORDER BY u.name,u.id`,
      )
      .all(companyId);
    const salaries = new Map(
      (
        await db
          .prepare(
            "SELECT DISTINCT ON (user_id) * FROM employee_salaries WHERE company_id=? AND substr(effective_from,1,7)<=? ORDER BY user_id,effective_from DESC",
          )
          .all(companyId, month)
      ).map((s) => [s.user_id, s]),
    );
    const lineRows = salaries.size
      ? await db
          .prepare(
            `SELECT * FROM employee_salary_lines WHERE salary_id IN (${[...salaries.values()].map(() => "?").join(",")}) ORDER BY id`,
          )
          .all(...[...salaries.values()].map((s) => s.id))
      : [];
    const linesOf = new Map();
    for (const l of lineRows)
      linesOf.set(l.salary_id, [...(linesOf.get(l.salary_id) ?? []), l]);
    const adjustments = await db
      .prepare(
        "SELECT * FROM payroll_adjustments WHERE company_id=? AND month=?",
      )
      .all(companyId, month);
    const slabs = await db
      .prepare("SELECT * FROM pt_slabs WHERE company_id=?")
      .all(companyId);
    const taxYear = taxYearOf(month);
    const opening = new Map(
      (
        await db
          .prepare(
            "SELECT * FROM payroll_opening WHERE company_id=? AND tax_year=?",
          )
          .all(companyId, taxYear)
      ).map((o) => [o.user_id, o]),
    );
    const prior = new Map(
      (
        await db
          .prepare(
            `SELECT i.user_id,SUM(i.taxable_earnings) income,SUM(i.tds) tds,SUM(i.pt) pt FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
             WHERE r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<? GROUP BY i.user_id`,
          )
          .all(companyId, `${taxYear}-04`, month)
      ).map((r) => [r.user_id, r]),
    );

    const skipped = [];
    const items = [];
    for (const p of people) {
      const salary = salaries.get(p.id);
      if (!salary) {
        skipped.push({
          user_id: p.id,
          name: p.name,
          employee_code: p.employee_code,
          reason: "no_salary",
        });
        continue;
      }
      const m = musterOf.get(p.id);
      const o = opening.get(p.id) ?? {};
      const pr = prior.get(p.id) ?? {};
      const mine = adjustments
        .filter((a) => a.user_id === p.id)
        .map((a) => ({
          kind: a.kind,
          name: a.name,
          amount: a.amount,
          taxable: Boolean(a.taxable),
        }));
      const slip = computePayslip({
        month,
        config,
        lines: (linesOf.get(salary.id) ?? []).map((l) => ({
          code: l.code,
          name: l.name,
          amount: l.amount,
          is_basic: Boolean(l.is_basic),
          taxable: Boolean(l.taxable),
          esi_wage: Boolean(l.esi_wage),
        })),
        attendance: { paid_days: m?.payable_days ?? 0 },
        adjustments: mine,
        flags: {
          pf_applicable: Boolean(salary.pf_applicable),
          esi_applicable: Boolean(salary.esi_applicable),
          pt_applicable: Boolean(salary.pt_applicable),
          eps_eligible: Boolean(salary.eps_eligible),
          tax_regime: salary.tax_regime,
          declared_deductions: salary.declared_deductions,
        },
        person: { gender: p.gender, date_of_birth: p.date_of_birth },
        ptSlabs: slabs.filter(
          (s) =>
            p.branch_state &&
            s.state.toLowerCase() === p.branch_state.trim().toLowerCase(),
        ),
        ytd: {
          taxable_income: (o.taxable_income ?? 0) + (pr.income ?? 0),
          tds_deducted: (o.tds_deducted ?? 0) + (pr.tds ?? 0),
          pt_deducted: (o.pt_deducted ?? 0) + (pr.pt ?? 0),
        },
      });
      const notCounted =
        m?.days.filter((d) => d.status === "not_started").length ?? 0;
      if (notCounted)
        slip.warnings.push("attendance_not_counted_for_some_days");
      if (!m) slip.warnings.push("no_attendance");
      if (config.pt.enabled && salary.pt_applicable && !p.branch_state)
        slip.warnings.push("no_branch_state_for_pt");
      items.push({ person: p, slip, salary });
    }
    await db.prepare("DELETE FROM payroll_items WHERE run_id=?").run(run.id);
    for (const { person, slip } of items)
      await db
        .prepare(
          "INSERT INTO payroll_items(run_id,company_id,user_id,gross,deductions,net,employer_cost,paid_days,lop_days,taxable_earnings,tds,pt,warnings,data) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          run.id,
          companyId,
          person.id,
          slip.gross_earnings,
          slip.total_deductions,
          slip.net_pay,
          slip.employer_cost,
          slip.paid_days,
          slip.lop_days,
          slip.taxable_earnings,
          slip.tds?.this_month ?? 0,
          slip.professional_tax,
          JSON.stringify(slip.warnings),
          JSON.stringify({
            employee: {
              name: person.name,
              employee_code: person.employee_code,
              department: person.department_name,
              designation: person.designation_name,
            },
            ...slip,
          }),
        );
    await db
      .prepare("UPDATE payroll_runs SET skipped=? WHERE id=?")
      .run(JSON.stringify(skipped), run.id);
    return { computed: items.length, skipped };
  }

  const totalsSql = `SELECT COUNT(i.id) employees,COALESCE(SUM(i.gross),0) gross,COALESCE(SUM(i.deductions),0) deductions,COALESCE(SUM(i.net),0) net,COALESCE(SUM(i.employer_cost),0) employer_cost
    FROM payroll_items i WHERE i.run_id=?`;
  const loadRun = async (id, companyId) => {
    const run = await db
      .prepare("SELECT * FROM payroll_runs WHERE id=? AND company_id=?")
      .get(id, companyId);
    if (!run) throw new HttpError(404, "Payroll run not found.");
    return run;
  };

  router.get(
    "/api/admin/payroll/runs",
    { perm: "payroll.read" },
    async ({ companyId, send }) => {
      const runs = await db
        .prepare(
          "SELECT * FROM payroll_runs WHERE company_id=? ORDER BY month DESC LIMIT 60",
        )
        .all(companyId);
      for (const r of runs)
        Object.assign(r, await db.prepare(totalsSql).get(r.id), {
          skipped: JSON.parse(r.skipped),
        });
      return send(200, runs);
    },
  );

  router.post(
    "/api/admin/payroll/runs",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      if (!MONTH.test(b.month ?? ""))
        throw new HttpError(400, "Choose a month like 2026-09.");
      if (
        b.month > currentMonth() ||
        (b.month === currentMonth() && b.allow_current !== true)
      )
        throw new HttpError(
          422,
          "Payroll can only be run for a completed month.",
        );
      if (
        await db
          .prepare("SELECT id FROM payroll_runs WHERE company_id=? AND month=?")
          .get(companyId, b.month)
      )
        throw new HttpError(
          409,
          "A payroll run for that month already exists.",
        );
      const result = await transaction(async () => {
        const run = {
          id: Number(
            (
              await db
                .prepare(
                  "INSERT INTO payroll_runs(company_id,month,created_by,created_at) VALUES(?,?,?,?)",
                )
                .run(companyId, b.month, user.id, nowIso())
            ).lastInsertRowid,
          ),
          company_id: companyId,
          month: b.month,
        };
        const r = await computeRun(run);
        await audit("payroll_run_created", {
          id: run.id,
          month: b.month,
          computed: r.computed,
        });
        return { id: run.id, ...r };
      });
      return send(201, result);
    },
  );

  router.get(
    "/api/admin/payroll/runs/:id",
    { perm: "payroll.read" },
    async ({ params, companyId, send }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      const items = await db
        .prepare(
          "SELECT i.user_id,u.name,u.employee_code,d.name department_name,i.paid_days,i.lop_days,i.gross,i.deductions,i.net,i.employer_cost,i.tds,i.pt,i.warnings FROM payroll_items i JOIN users u ON u.id=i.user_id LEFT JOIN departments d ON d.id=u.department_id WHERE i.run_id=? ORDER BY u.name",
        )
        .all(run.id);
      return send(200, {
        run: { ...run, skipped: JSON.parse(run.skipped) },
        totals: await db.prepare(totalsSql).get(run.id),
        items: items.map((i) => ({ ...i, warnings: JSON.parse(i.warnings) })),
      });
    },
  );
  router.get(
    "/api/admin/payroll/runs/:id/items/:userId",
    { perm: "payroll.read" },
    async ({ params, companyId, send }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      const item = await db
        .prepare("SELECT data FROM payroll_items WHERE run_id=? AND user_id=?")
        .get(run.id, integer(Number(params.userId)));
      if (!item) throw new HttpError(404, "That employee is not in this run.");
      return send(200, JSON.parse(item.data));
    },
  );

  router.post(
    "/api/admin/payroll/runs/:id/recompute",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      if (run.status !== "draft")
        throw new HttpError(409, "An approved run cannot be recomputed.");
      const r = await transaction(async () => {
        const r = await computeRun(run);
        await audit("payroll_run_recomputed", {
          id: run.id,
          month: run.month,
          computed: r.computed,
        });
        return r;
      });
      return send(200, r);
    },
  );
  router.post(
    "/api/admin/payroll/runs/:id/approve",
    { perm: "payroll.approve" },
    async ({ user, params, companyId, send, audit }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      if (run.status !== "draft")
        throw new HttpError(409, `This run is already ${run.status}.`);
      const config = await loadConfig(db, companyId);
      if (config.approval.separateApprover && run.created_by === user.id)
        throw new HttpError(
          403,
          "Someone other than the person who prepared this run must approve it.",
        );
      const items = await db
        .prepare("SELECT warnings FROM payroll_items WHERE run_id=?")
        .all(run.id);
      if (!items.length)
        throw new HttpError(409, "There is nothing to approve in this run.");
      if (
        items.some((i) => JSON.parse(i.warnings).includes("negative_net_pay"))
      )
        throw new HttpError(
          409,
          "Some employees have negative net pay. Adjust their deductions first.",
        );
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE payroll_runs SET status='approved',approved_by=?,approved_at=? WHERE id=?",
          )
          .run(user.id, nowIso(), run.id);
        await audit("payroll_run_approved", { id: run.id, month: run.month });
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/payroll/runs/:id/paid",
    { perm: "payroll.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      if (run.status !== "approved")
        throw new HttpError(409, "Only an approved run can be marked paid.");
      const paidOn = isoDate(
        (await body()).paid_on ?? app.dayOf(nowIso()),
        "Paid on",
      );
      await transaction(async () => {
        await db
          .prepare("UPDATE payroll_runs SET status='paid',paid_on=? WHERE id=?")
          .run(paidOn, run.id);
        await audit("payroll_run_paid", {
          id: run.id,
          month: run.month,
          paidOn,
        });
      });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/admin/payroll/runs/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      if (run.status !== "draft")
        throw new HttpError(409, "Only a draft run can be deleted.");
      await db.prepare("DELETE FROM payroll_runs WHERE id=?").run(run.id);
      await audit("payroll_run_deleted", { id: run.id, month: run.month });
      return send(200, { ok: true });
    },
  );

  // ---- exports ---------------------------------------------------------------------------------------
  const csv = (rows, header) =>
    "﻿" +
    [
      header.map((h) => h[1]).join(","),
      ...rows.map((r) => header.map(([k]) => csvCell(r[k])).join(",")),
    ].join("\r\n");
  router.get(
    "/api/admin/payroll/runs/:id/export",
    { perm: "payroll.read" },
    async ({ params, companyId, query, res, headers, audit }) => {
      const run = await loadRun(integer(Number(params.id)), companyId);
      const type = query.get("type") ?? "register";
      const rows = (
        await db
          .prepare(
            "SELECT i.user_id,i.data FROM payroll_items i JOIN users u ON u.id=i.user_id WHERE i.run_id=? ORDER BY u.name",
          )
          .all(run.id)
      ).map((r) => ({ user_id: r.user_id, ...JSON.parse(r.data) }));
      const dedAmount = (r, code) =>
        r.deductions
          .filter((d) => d.code === code)
          .reduce((s, d) => s + d.amount, 0);
      let header, out;
      if (type === "register") {
        header = [
          ["code", "Employee code"],
          ["name", "Name"],
          ["department", "Department"],
          ["paid_days", "Paid days"],
          ["lop_days", "Loss of pay days"],
          ["gross", "Gross earnings"],
          ["pf", "PF (employee)"],
          ["esi", "ESI (employee)"],
          ["pt", "Professional tax"],
          ["tds", "TDS"],
          ["other", "Other deductions"],
          ["net", "Net pay"],
          ["employer", "Employer cost"],
        ];
        out = rows.map((r) => ({
          code: r.employee.employee_code,
          name: r.employee.name,
          department: r.employee.department,
          paid_days: r.paid_days,
          lop_days: r.lop_days,
          gross: r.gross_earnings,
          pf: dedAmount(r, "PF"),
          esi: dedAmount(r, "ESI"),
          pt: dedAmount(r, "PT"),
          tds: dedAmount(r, "TDS"),
          other: dedAmount(r, "ADJ"),
          net: r.net_pay,
          employer: r.employer_cost,
        }));
      } else if (type === "pf") {
        header = [
          ["uan", "UAN"],
          ["name", "Name"],
          ["gross", "Gross wages"],
          ["wages", "EPF wages"],
          ["eps_wages", "EPS/EDLI wages"],
          ["employee", "EPF (employee)"],
          ["eps", "EPS (employer)"],
          ["epf", "EPF (employer)"],
          ["edli", "EDLI"],
          ["admin", "Admin charges"],
        ];
        out = [];
        for (const r of rows.filter((x) => x.pf))
          out.push({
            uan: (await readPrivate(app, r.user_id)).uan ?? "MISSING",
            name: r.employee.name,
            gross: r.gross_earnings,
            wages: r.pf.wages,
            eps_wages: r.pf.eps_wages,
            employee: r.pf.employee,
            eps: r.pf.employerEps,
            epf: r.pf.employerEpf,
            edli: r.pf.edli,
            admin: r.pf.admin,
          });
      } else if (type === "esi") {
        header = [
          ["ip", "ESI number"],
          ["name", "Name"],
          ["days", "Paid days"],
          ["wages", "ESI wages"],
          ["employee", "Employee"],
          ["employer", "Employer"],
        ];
        out = [];
        for (const r of rows.filter((x) => x.esi && x.esi.employee))
          out.push({
            ip: (await readPrivate(app, r.user_id)).esi_ip ?? "MISSING",
            name: r.employee.name,
            days: r.paid_days,
            wages: r.esi.wages,
            employee: r.esi.employee,
            employer: r.esi.employer,
          });
      } else if (type === "pt") {
        header = [
          ["code", "Employee code"],
          ["name", "Name"],
          ["gross", "Gross"],
          ["pt", "Professional tax"],
        ];
        out = rows
          .filter((r) => r.professional_tax)
          .map((r) => ({
            code: r.employee.employee_code,
            name: r.employee.name,
            gross: r.gross_earnings,
            pt: r.professional_tax,
          }));
      } else if (type === "bank") {
        if (run.status === "draft")
          throw new HttpError(
            409,
            "Approve the run before creating the bank file.",
          );
        header = [
          ["code", "Employee code"],
          ["holder", "Account holder"],
          ["bank", "Bank"],
          ["account", "Account number"],
          ["ifsc", "IFSC"],
          ["net", "Amount"],
          ["narration", "Narration"],
        ];
        out = [];
        for (const r of rows.filter((x) => x.net_pay > 0)) {
          const d = await readPrivate(app, r.user_id);
          out.push({
            code: r.employee.employee_code,
            holder: d.account_holder ?? r.employee.name,
            bank: d.bank_name ?? "",
            account: d.bank_account ?? "MISSING",
            ifsc: d.ifsc ?? "MISSING",
            net: r.net_pay,
            narration: `Salary ${monthName(run.month)}`,
          });
        }
        await audit("bank_advice_exported", {
          id: run.id,
          month: run.month,
          rows: out.length,
        });
      } else throw new HttpError(400, "Unknown export type.");
      // PF and ESI files carry identity numbers that were stored encrypted.
      if (type === "pf" || type === "esi")
        await audit("statutory_file_exported", {
          id: run.id,
          month: run.month,
          type,
          rows: out.length,
        });
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="payroll-${type}-${run.month}.csv"`,
      });
      res.end(csv(out, header));
    },
  );

  // ---- payslips for employees ---------------------------------------------------------------------------
  router.get("/api/payslips", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT r.id run_id,r.month,r.status,r.paid_on,i.gross,i.deductions,i.net FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.user_id=? AND r.status IN ('approved','paid') ORDER BY r.month DESC",
        )
        .all(user.id),
    ),
  );
  router.get("/api/payslips/:runId", async ({ user, params, send }) => {
    const row = await db
      .prepare(
        "SELECT i.data,r.month,r.status,c.name company FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id JOIN companies c ON c.id=r.company_id WHERE r.id=? AND i.user_id=? AND r.status IN ('approved','paid')",
      )
      .get(integer(Number(params.runId)), user.id);
    if (!row) throw new HttpError(404, "Payslip not found.");
    const data = JSON.parse(row.data);
    delete data.warnings; // internal review notes are not for the employee
    return send(200, { company: row.company, ...data });
  });
}
