import {
  HttpError,
  csvCell,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide, inboxScope } from "../approval.js";
import { round } from "../payroll/engine.js";
import { taxYearOf } from "../payroll/tax.js";
import {
  encashmentRate,
  gratuity,
  loanSchedule,
  statutoryBonus,
  BONUS,
} from "../payroll/extras.js";
import { balances, yearBalance } from "../leave-ledger.js";
import { loadConfig, readPrivate } from "./payroll-setup.js";
import { daysInMonth } from "../payroll/engine.js";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const month = (v, label = "Month") => {
  if (!MONTH.test(v ?? ""))
    throw new HttpError(400, `${label}: use a month like 2026-10.`);
  return v;
};

export function registerPayrollExtras(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());

  const monthLocked = async (companyId, m) => {
    const run = await db
      .prepare("SELECT status FROM payroll_runs WHERE company_id=? AND month=?")
      .get(companyId, m);
    return Boolean(run && run.status !== "draft");
  };
  const latestSalary = async (companyId, userId, upToMonth) => {
    const salary = await db
      .prepare(
        "SELECT * FROM employee_salaries WHERE company_id=? AND user_id=? AND substr(effective_from,1,7)<=? ORDER BY effective_from DESC LIMIT 1",
      )
      .get(companyId, userId, upToMonth);
    if (!salary) return null;
    const lines = (
      await db
        .prepare(
          "SELECT * FROM employee_salary_lines WHERE salary_id=? ORDER BY id",
        )
        .all(salary.id)
    ).map((l) => ({ ...l, is_basic: Boolean(l.is_basic) }));
    return { salary, lines };
  };

  // ---- loans and advances ------------------------------------------------------------
  router.get(
    "/api/admin/payroll/loans",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      const rows = await db
        .prepare(
          `SELECT l.*,u.name employee_name,u.employee_code,
             (SELECT COALESCE(SUM(amount),0) FROM payroll_loan_schedule s WHERE s.loan_id=l.id AND s.status='pending') outstanding
           FROM payroll_loans l JOIN users u ON u.id=l.user_id WHERE l.company_id=? ${status ? "AND l.status=?" : ""} ORDER BY l.id DESC LIMIT 300`,
        )
        .all(...(status ? [companyId, status] : [companyId]));
      return send(200, rows);
    },
  );
  router.get(
    "/api/admin/payroll/loans/:id",
    { perm: "payroll.read" },
    async ({ params, companyId, send }) => {
      const loan = await requireOwned(
        db,
        "payroll_loans",
        integer(Number(params.id)),
        companyId,
        "loan",
      );
      return send(200, {
        ...loan,
        schedule: await db
          .prepare(
            "SELECT * FROM payroll_loan_schedule WHERE loan_id=? ORDER BY month,id",
          )
          .all(loan.id),
      });
    },
  );
  router.post(
    "/api/admin/payroll/loans",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const person = await requireOwned(
        db,
        "users",
        integer(b.user_id),
        companyId,
        "employee",
      );
      const kind = oneOf(b.kind ?? "loan", "Type", ["loan", "advance"]);
      const principal = Math.round(number(b.principal, "Amount", 1, 100000000));
      const installments = number(b.installments, "Instalments", 1, 120);
      if (!Number.isInteger(installments))
        throw new HttpError(400, "Instalments must be a whole number.");
      const start = month(b.start_month, "First deduction");
      if (await monthLocked(companyId, start))
        throw new HttpError(
          409,
          "That month's payroll is already approved. Start from a later month.",
        );
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO payroll_loans(company_id,user_id,kind,principal,installments,start_month,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                kind,
                principal,
                installments,
                start,
                optionalString(b.note, "Note", 300),
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        for (const s of loanSchedule(principal, installments, start))
          await db
            .prepare(
              "INSERT INTO payroll_loan_schedule(loan_id,month,amount) VALUES(?,?,?)",
            )
            .run(id, s.month, s.amount);
        await audit("payroll_loan_created", {
          id,
          employeeId: person.id,
          kind,
          principal,
          installments,
        });
        return id;
      });
      return send(201, { id });
    },
  );
  // Skip an instalment: it moves to the end of the schedule.
  router.post(
    "/api/admin/payroll/loans/:id/skip",
    { perm: "payroll.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const loan = await requireOwned(
        db,
        "payroll_loans",
        integer(Number(params.id)),
        companyId,
        "loan",
      );
      if (loan.status !== "active")
        throw new HttpError(409, "This loan is not active.");
      const m = month((await body()).month);
      const s = await db
        .prepare(
          "SELECT * FROM payroll_loan_schedule WHERE loan_id=? AND month=? AND status='pending'",
        )
        .get(loan.id, m);
      if (!s) throw new HttpError(404, "No pending instalment in that month.");
      if (await monthLocked(companyId, m))
        throw new HttpError(409, "That month's payroll is already approved.");
      await transaction(async () => {
        const last = await db
          .prepare(
            "SELECT month FROM payroll_loan_schedule WHERE loan_id=? ORDER BY month DESC LIMIT 1",
          )
          .get(loan.id);
        const [y, mo] = last.month.split("-").map(Number);
        const next =
          mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
        await db
          .prepare("UPDATE payroll_loan_schedule SET month=? WHERE id=?")
          .run(next, s.id);
        await audit("payroll_loan_skipped", { id: loan.id, month: m });
      });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/admin/payroll/loans/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const loan = await requireOwned(
        db,
        "payroll_loans",
        integer(Number(params.id)),
        companyId,
        "loan",
      );
      if (loan.status !== "active")
        throw new HttpError(409, "This loan is not active.");
      await transaction(async () => {
        await db
          .prepare("UPDATE payroll_loans SET status='cancelled' WHERE id=?")
          .run(loan.id);
        await db
          .prepare(
            "UPDATE payroll_loan_schedule SET status='cancelled' WHERE loan_id=? AND status='pending'",
          )
          .run(loan.id);
        await audit("payroll_loan_cancelled", { id: loan.id });
      });
      return send(200, { ok: true });
    },
  );
  router.get("/api/loans", async ({ user, send }) => {
    const loans = await db
      .prepare("SELECT * FROM payroll_loans WHERE user_id=? ORDER BY id DESC")
      .all(user.id);
    for (const l of loans)
      l.schedule = await db
        .prepare(
          "SELECT month,amount,status FROM payroll_loan_schedule WHERE loan_id=? ORDER BY month",
        )
        .all(l.id);
    return send(200, loans);
  });

  // ---- reimbursement claims --------------------------------------------------------------
  router.get("/api/claim-types", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT id,name,annual_limit,taxable,active FROM claim_types WHERE company_id=? AND active=1 ORDER BY name",
        )
        .all(user.company_id),
    ),
  );
  router.get(
    "/api/admin/claim-types",
    { perm: "payroll.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare("SELECT * FROM claim_types WHERE company_id=? ORDER BY name")
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/claim-types",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const name = string(b.name, "Name", 60);
      const limit =
        b.annual_limit === undefined ||
        b.annual_limit === null ||
        b.annual_limit === ""
          ? null
          : number(b.annual_limit, "Yearly limit", 1, 100000000);
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO claim_types(company_id,name,annual_limit,taxable,created_at) VALUES(?,?,?,?,?)",
              )
              .run(companyId, name, limit, b.taxable ? 1 : 0, nowIso())
          ).lastInsertRowid,
        );
        await audit("claim_type_created", { id, name });
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/claim-types/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const row = await requireOwned(
        db,
        "claim_types",
        integer(Number(params.id)),
        companyId,
        "claim type",
      );
      const b = await body();
      const limit =
        b.annual_limit === undefined
          ? row.annual_limit
          : b.annual_limit === null || b.annual_limit === ""
            ? null
            : number(b.annual_limit, "Yearly limit", 1, 100000000);
      await db
        .prepare(
          "UPDATE claim_types SET name=?,annual_limit=?,taxable=?,active=? WHERE id=?",
        )
        .run(
          b.name === undefined ? row.name : string(b.name, "Name", 60),
          limit,
          b.taxable === undefined ? row.taxable : b.taxable ? 1 : 0,
          b.active === undefined ? row.active : b.active ? 1 : 0,
          row.id,
        );
      await audit("claim_type_updated", { id: row.id });
      return send(200, { ok: true });
    },
  );

  const CLAIM_SELECT = `SELECT c.*,t.name type_name,u.name employee_name,u.employee_code FROM reimbursement_claims c
    JOIN claim_types t ON t.id=c.claim_type_id JOIN users u ON u.id=c.user_id`;
  // The tax year the claim's expense date falls in, for the yearly limit.
  const yearOf = (date) => taxYearOf(date.slice(0, 7));
  const usedInYear = async (typeId, userId, year, exceptId = 0) =>
    (
      await db
        .prepare(
          `SELECT expense_date,COALESCE(approved_amount,amount) a FROM reimbursement_claims
           WHERE user_id=? AND claim_type_id=? AND status IN ('pending','approved','paid') AND id<>?`,
        )
        .all(userId, typeId, exceptId)
    )
      .filter((r) => yearOf(r.expense_date) === year)
      .reduce((s, r) => s + r.a, 0);

  router.get("/api/claims", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${CLAIM_SELECT} WHERE c.user_id=? ORDER BY c.id DESC LIMIT 200`,
        )
        .all(user.id),
    ),
  );
  router.post("/api/claims", async ({ user, body, send, audit }) => {
    const b = await body();
    const type = await requireOwned(
      db,
      "claim_types",
      integer(b.claim_type_id),
      user.company_id,
      "claim type",
    );
    if (!type.active)
      throw new HttpError(409, "That claim type is not in use.");
    const date = isoDate(b.expense_date, "Expense date");
    if (!date || date > today())
      throw new HttpError(400, "Expense date cannot be in the future.");
    const amount = number(b.amount, "Amount", 1, 10000000);
    if (type.annual_limit) {
      const used = await usedInYear(type.id, user.id, yearOf(date));
      if (used + amount > type.annual_limit)
        throw new HttpError(
          409,
          `This would exceed the yearly limit of ₹${type.annual_limit} for ${type.name} (₹${used} already claimed).`,
        );
    }
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO reimbursement_claims(company_id,user_id,claim_type_id,expense_date,amount,description,reference,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              type.id,
              date,
              round(amount),
              string(b.description, "Description", 300),
              optionalString(b.reference, "Bill reference", 120),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("claim_submitted", { id, type: type.name, amount });
      return id;
    });
    return send(201, { id });
  });
  router.delete("/api/claims/:id", async ({ user, params, send, audit }) => {
    const c = await requireOwned(
      db,
      "reimbursement_claims",
      integer(Number(params.id)),
      user.company_id,
      "claim",
    );
    if (c.user_id !== user.id || c.status !== "pending")
      throw new HttpError(409, "Only your own pending claim can be withdrawn.");
    await db
      .prepare("UPDATE reimbursement_claims SET status='cancelled' WHERE id=?")
      .run(c.id);
    await audit("claim_withdrawn", { id: c.id });
    return send(200, { ok: true });
  });
  // Claims waiting on this approver (managers see their team, HR and payroll see all).
  router.get("/api/claims/inbox", async ({ user, send }) => {
    let scope = await inboxScope(app, user);
    if (!scope && can(user, "payroll.manage")) scope = { sql: "", params: [] };
    if (!scope) return send(200, []);
    return send(
      200,
      await db
        .prepare(
          `${CLAIM_SELECT.replace("u ON u.id=c.user_id", "u ON u.id=c.user_id")} WHERE c.company_id=? AND c.status='pending' AND c.user_id<>?${scope.sql.replace(/r\.user_id/g, "c.user_id")} ORDER BY c.id LIMIT 200`,
        )
        .all(user.company_id, user.id, ...scope.params),
    );
  });
  router.get(
    "/api/admin/claims",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `${CLAIM_SELECT} WHERE c.company_id=? ${status ? "AND c.status=?" : ""} ORDER BY c.id DESC LIMIT 300`,
          )
          .all(...(status ? [companyId, status] : [companyId])),
      );
    },
  );
  router.post(
    "/api/claims/:id/decide",
    async ({ user, params, body, send, audit }) => {
      const c = await requireOwned(
        db,
        "reimbursement_claims",
        integer(Number(params.id)),
        user.company_id,
        "claim",
      );
      if (c.status !== "pending")
        throw new HttpError(409, `This claim is already ${c.status}.`);
      const allowed =
        c.user_id !== user.id &&
        ((await mayDecide(app, user, c.user_id)) ||
          can(user, "payroll.manage"));
      if (!allowed) throw new HttpError(403, "You cannot decide this claim.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 300);
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Say why the claim is rejected.");
      let approved = c.amount;
      if (decision === "approved" && b.approved_amount !== undefined)
        approved = number(b.approved_amount, "Approved amount", 1, c.amount);
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE reimbursement_claims SET status=?,approved_amount=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?",
          )
          .run(
            decision,
            decision === "approved" ? round(approved) : null,
            user.id,
            nowIso(),
            note,
            c.id,
          );
        await audit("claim_decided", { id: c.id, decision, approved });
      });
      return send(200, { ok: true });
    },
  );

  // ---- statutory bonus -------------------------------------------------------------------------
  // Months of a financial year from approved runs; wages are the full-month salary
  // lines that make up statutory wages (basic and allowances that count for PF/ESI).
  async function bonusFor(companyId, year, config) {
    const from = `${year}-04`;
    const to = `${year + 1}-03`;
    const items = await db
      .prepare(
        `SELECT i.user_id,i.paid_days,i.data,r.month,u.name,u.employee_code FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
         JOIN users u ON u.id=i.user_id WHERE r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=?`,
      )
      .all(companyId, from, to);
    const by = new Map();
    for (const it of items) {
      const d = JSON.parse(it.data);
      const wages = (d.earnings ?? [])
        .filter(
          (e) =>
            e.code !== "ADJ" &&
            (e.is_basic || e.esi_wage || /^(BASIC|DA)$/i.test(e.code)),
        )
        .reduce((s, e) => s + (e.full ?? e.amount), 0);
      const rec = by.get(it.user_id) ?? {
        user_id: it.user_id,
        name: it.name,
        employee_code: it.employee_code,
        months: [],
      };
      rec.months.push({
        wages,
        paid_days: it.paid_days,
        days_in_month: daysInMonth(it.month),
      });
      by.set(it.user_id, rec);
    }
    return [...by.values()].map((r) => ({
      user_id: r.user_id,
      name: r.name,
      employee_code: r.employee_code,
      months_paid: r.months.length,
      ...statutoryBonus(r.months, config.bonus),
    }));
  }
  const bonusYear = (v) => {
    const y = Number(v);
    if (!Number.isInteger(y) || y < 2020 || y > 2100)
      throw new HttpError(
        400,
        "Choose the financial year it starts in, like 2026.",
      );
    return y;
  };
  router.get(
    "/api/admin/payroll/bonus",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const year = bonusYear(query.get("year"));
      const config = await loadConfig(db, companyId);
      const rows = await bonusFor(companyId, year, config);
      return send(200, {
        year,
        rate: config.bonus.rate,
        minimum_wage: config.bonus.minimumWage,
        rules: BONUS,
        rows,
        total: round(rows.reduce((s, r) => s + r.amount, 0)),
      });
    },
  );
  router.post(
    "/api/admin/payroll/bonus",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const year = bonusYear(b.year);
      const payIn = month(b.pay_in_month, "Pay in");
      if (await monthLocked(companyId, payIn))
        throw new HttpError(409, "That month's payroll is already approved.");
      const done = await db
        .prepare(
          "SELECT id FROM payroll_adjustments WHERE company_id=? AND source='bonus' AND source_ref=? LIMIT 1",
        )
        .get(companyId, year);
      if (done)
        throw new HttpError(
          409,
          "Bonus for this year has already been added. Delete those lines first to redo it.",
        );
      const config = await loadConfig(db, companyId);
      const rows = (await bonusFor(companyId, year, config)).filter(
        (r) => r.amount > 0,
      );
      if (!rows.length)
        throw new HttpError(409, "Nobody is eligible for bonus for that year.");
      await transaction(async () => {
        for (const r of rows)
          await db
            .prepare(
              "INSERT INTO payroll_adjustments(company_id,user_id,month,kind,name,amount,taxable,note,created_by,created_at,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              r.user_id,
              payIn,
              "earning",
              `Statutory bonus ${year}-${String(year + 1).slice(2)}`,
              r.amount,
              1,
              null,
              user.id,
              nowIso(),
              "bonus",
              year,
            );
        await audit("statutory_bonus_added", {
          year,
          payIn,
          people: rows.length,
        });
      });
      return send(201, { added: rows.length });
    },
  );

  // ---- leave encashment ---------------------------------------------------------------------------
  router.post(
    "/api/admin/employees/:id/leave-encashment",
    { perm: "payroll.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const b = await body();
      const type = await requireOwned(
        db,
        "leave_types",
        integer(b.leave_type_id),
        companyId,
        "leave type",
      );
      if (!type.encashable)
        throw new HttpError(409, "This leave type cannot be encashed.");
      const days = number(b.days, "Days", 0.5, 366);
      const payIn = month(b.pay_in_month, "Pay in");
      if (await monthLocked(companyId, payIn))
        throw new HttpError(409, "That month's payroll is already approved.");
      const bal = (await balances(app, person, today())).find(
        (x) => x.leave_type_id === type.id,
      );
      if (!bal || bal.available < days)
        throw new HttpError(
          409,
          `Only ${bal?.available ?? 0} days are available to encash.`,
        );
      const found = await latestSalary(companyId, person.id, payIn);
      if (!found) throw new HttpError(409, "This employee has no salary set.");
      const config = await loadConfig(db, companyId);
      const rate = encashmentRate(found.lines, config.leaveEncashment);
      const amount = round(rate * days);
      const id = await transaction(async () => {
        const ledgerId = Number(
          (
            await db
              .prepare(
                "INSERT INTO leave_ledger(company_id,user_id,leave_type_id,leave_year,kind,days,period,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                type.id,
                bal.year,
                "encashment",
                -days,
                null,
                `Encashed with ${payIn} salary`,
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO payroll_adjustments(company_id,user_id,month,kind,name,amount,taxable,note,created_by,created_at,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                payIn,
                "earning",
                `Leave encashment (${days} days ${type.code})`,
                amount,
                1,
                null,
                user.id,
                nowIso(),
                "encashment",
                ledgerId,
              )
          ).lastInsertRowid,
        );
        await audit("leave_encashed", {
          employeeId: person.id,
          type: type.code,
          days,
          amount,
          payIn,
        });
        return id;
      });
      return send(201, { id, amount, rate: round(rate) });
    },
  );
  // Deleting an encashment line gives the days back.
  router.delete(
    "/api/admin/payroll/encashments/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const adj = await requireOwned(
        db,
        "payroll_adjustments",
        integer(Number(params.id)),
        companyId,
        "adjustment",
      );
      if (adj.source !== "encashment")
        throw new HttpError(400, "That is not a leave encashment.");
      if (await monthLocked(companyId, adj.month))
        throw new HttpError(409, "That month's payroll is already approved.");
      await transaction(async () => {
        await db
          .prepare("DELETE FROM leave_ledger WHERE id=? AND kind='encashment'")
          .run(adj.source_ref);
        await db
          .prepare("DELETE FROM payroll_adjustments WHERE id=?")
          .run(adj.id);
        await audit("leave_encashment_reversed", { id: adj.id });
      });
      return send(200, { ok: true });
    },
  );

  // ---- gratuity ------------------------------------------------------------------------------------
  // Wages for gratuity: basic (plus DA) raised to half of gross under the labour codes.
  const gratuityWages = (found) => {
    const basic = found.lines
      .filter((l) => l.is_basic)
      .reduce((s, l) => s + l.amount, 0);
    const gross = found.lines.reduce((s, l) => s + l.amount, 0);
    return Math.max(basic, gross / 2);
  };
  async function gratuityFor(companyId, person, asOf) {
    if (!person.date_of_joining)
      return {
        user_id: person.id,
        name: person.name,
        error: "no_joining_date",
      };
    const found = await latestSalary(companyId, person.id, asOf.slice(0, 7));
    if (!found)
      return { user_id: person.id, name: person.name, error: "no_salary" };
    const wages = gratuityWages(found);
    return {
      user_id: person.id,
      name: person.name,
      employee_code: person.employee_code,
      joined: person.date_of_joining,
      wages: round(wages),
      ...gratuity({
        wages,
        joined: person.date_of_joining,
        asOf,
        employmentType: person.employment_type ?? "full_time",
      }),
    };
  }
  router.get(
    "/api/admin/employees/:id/gratuity",
    { perm: "payroll.read" },
    async ({ params, companyId, query, send }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const asOf = isoDate(query.get("as_of") ?? today(), "As of");
      return send(200, await gratuityFor(companyId, person, asOf));
    },
  );
  router.get(
    "/api/admin/payroll/gratuity-liability",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const asOf = isoDate(query.get("as_of") ?? today(), "As of");
      const people = await db
        .prepare(
          "SELECT * FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' ORDER BY name",
        )
        .all(companyId);
      const rows = [];
      for (const p of people) rows.push(await gratuityFor(companyId, p, asOf));
      const ok = rows.filter((r) => !r.error);
      return send(200, {
        as_of: asOf,
        rows,
        provision: round(ok.reduce((s, r) => s + r.provision, 0)),
        payable_if_all_left: round(ok.reduce((s, r) => s + r.payable, 0)),
      });
    },
  );

  // ---- Form 130 (annual salary and tax statement) and Form 138 (quarterly TDS) -------------------
  // Data for the employer's filing and for the statement given to each employee; the
  // official forms are generated from the TRACES/Income-tax utilities with this data.
  async function taxRows(companyId, year) {
    const from = `${year}-04`;
    const to = `${year + 1}-03`;
    const items = await db
      .prepare(
        `SELECT i.user_id,i.gross,i.taxable_earnings,i.tds,i.pt,i.data,r.month,u.name,u.employee_code
         FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id JOIN users u ON u.id=i.user_id
         WHERE r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=? ORDER BY u.name,r.month`,
      )
      .all(companyId, from, to);
    const opening = new Map(
      (
        await db
          .prepare(
            "SELECT * FROM payroll_opening WHERE company_id=? AND tax_year=?",
          )
          .all(companyId, year)
      ).map((o) => [o.user_id, o]),
    );
    const by = new Map();
    for (const it of items) {
      const d = JSON.parse(it.data);
      const pf = (d.deductions ?? [])
        .filter((x) => x.code === "PF")
        .reduce((s, x) => s + x.amount, 0);
      const r = by.get(it.user_id) ?? {
        user_id: it.user_id,
        name: it.name,
        employee_code: it.employee_code,
        months: [],
        gross: 0,
        taxable: 0,
        tds: 0,
        pt: 0,
        pf: 0,
      };
      r.months.push({
        month: it.month,
        taxable: it.taxable_earnings,
        tds: it.tds,
      });
      r.gross += it.gross;
      r.taxable += it.taxable_earnings;
      r.tds += it.tds;
      r.pt += it.pt;
      r.pf += pf;
      by.set(it.user_id, r);
    }
    for (const [uid, o] of opening)
      if (by.has(uid)) {
        const r = by.get(uid);
        r.opening = {
          taxable_income: o.taxable_income,
          tds: o.tds_deducted,
          pt: o.pt_deducted,
        };
        r.taxable += o.taxable_income;
        r.tds += o.tds_deducted;
        r.pt += o.pt_deducted;
      }
    return [...by.values()];
  }
  router.get(
    "/api/admin/payroll/tax-statement",
    { perm: "payroll.read" },
    async ({ companyId, query, res, headers, audit, send }) => {
      const year = bonusYear(query.get("year"));
      const rows = await taxRows(companyId, year);
      const form = query.get("form") ?? "130";
      if (query.get("format") !== "csv") return send(200, { year, rows });
      let header, out;
      if (form === "138") {
        const quarter = Number(query.get("quarter"));
        if (![1, 2, 3, 4].includes(quarter))
          throw new HttpError(400, "Choose quarter 1 to 4.");
        const months = [
          [4, 5, 6],
          [7, 8, 9],
          [10, 11, 12],
          [1, 2, 3],
        ][quarter - 1].map(
          (m) => `${m >= 4 ? year : year + 1}-${String(m).padStart(2, "0")}`,
        );
        header = [
          "Employee code",
          "Name",
          "PAN",
          "Month",
          "Taxable income",
          "Tax deducted",
        ];
        out = [];
        for (const r of rows) {
          const pan = (await readPrivate(app, r.user_id)).pan ?? "PANNOTAVBL";
          for (const m of r.months.filter((x) => months.includes(x.month)))
            out.push([r.employee_code, r.name, pan, m.month, m.taxable, m.tds]);
        }
      } else {
        header = [
          "Employee code",
          "Name",
          "PAN",
          "Gross salary",
          "Taxable income",
          "Provident fund",
          "Professional tax",
          "Tax deducted",
        ];
        out = [];
        for (const r of rows) {
          const pan = (await readPrivate(app, r.user_id)).pan ?? "PANNOTAVBL";
          out.push([
            r.employee_code,
            r.name,
            pan,
            round(r.gross),
            round(r.taxable),
            round(r.pf),
            round(r.pt),
            round(r.tds),
          ]);
        }
      }
      await audit("tax_statement_exported", { year, form, rows: out.length });
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="form-${form}-${year}${form === "138" ? `-q${query.get("quarter")}` : ""}.csv"`,
      });
      res.end(
        "﻿" +
          [
            header.map(csvCell).join(","),
            ...out.map((r) => r.map(csvCell).join(",")),
          ].join("\r\n"),
      );
    },
  );
}
