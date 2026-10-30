import {
  HttpError,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { round } from "../payroll/engine.js";
import { encashmentRate, gratuity } from "../payroll/extras.js";
import { balances } from "../leave-ledger.js";
import { exitLetter } from "../letters.js";
import { loadConfig } from "./payroll-setup.js";

const KINDS = [
  "resignation",
  "termination",
  "retirement",
  "end_of_contract",
  "absconding",
  "other",
];
// Leave encashment on resignation or retirement is exempt up to this amount.
const ENCASHMENT_EXEMPT = 2500000;
const CLEARANCE = [
  ["Manager", "Hand over work and records"],
  ["IT", "Return laptop and other devices"],
  ["IT", "Disable email and system access"],
  ["Finance", "Settle advances, loans and pending claims"],
  ["HR", "Collect ID card and access card"],
  ["HR", "Conduct the exit interview"],
];
const days = (a, b) =>
  Math.round(
    (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000,
  );
const addDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const monthOf = (d) => d.slice(0, 7);

export function registerExit(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const monthLocked = async (companyId, m) => {
    const run = await db
      .prepare("SELECT status FROM payroll_runs WHERE company_id=? AND month=?")
      .get(companyId, m);
    return Boolean(run && run.status !== "draft");
  };
  const noticeFor = async (person) =>
    person.notice_days ??
    (
      await db
        .prepare("SELECT notice_days FROM companies WHERE id=?")
        .get(person.company_id)
    ).notice_days;

  async function startClearance(exit) {
    for (const [dept, item] of CLEARANCE)
      await db
        .prepare(
          "INSERT INTO exit_clearance(exit_id,department,item) VALUES(?,?,?)",
        )
        .run(exit.id, dept, item);
    for (const a of await db
      .prepare("SELECT * FROM assets WHERE assigned_to=? AND status='assigned'")
      .all(exit.user_id))
      await db
        .prepare(
          "INSERT INTO exit_clearance(exit_id,department,item,asset_id) VALUES(?,?,?,?)",
        )
        .run(exit.id, "Admin", `Return ${a.name} (${a.tag})`, a.id);
  }
  // Separation requests a manager raised start their exit the same way (separation.js).
  app.startExitClearance = startClearance;
  const EXIT_SELECT = `SELECT x.*,u.name employee_name,u.employee_code,u.date_of_joining,d.name department_name,g.name designation_name
    FROM exits x JOIN users u ON u.id=x.user_id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN designations g ON g.id=u.designation_id`;

  // ---- employee ---------------------------------------------------------------------------------
  router.get("/api/exit/mine", async ({ user, send }) => {
    const x = await db
      .prepare("SELECT * FROM exits WHERE user_id=? ORDER BY id DESC LIMIT 1")
      .get(user.id);
    return send(200, { exit: x ?? null, notice_days: await noticeFor(user) });
  });
  router.post("/api/exit/resign", async ({ user, body, send, audit }) => {
    if (user.role === "super_admin")
      throw new HttpError(403, "Not available for this account.");
    if (
      await db
        .prepare(
          "SELECT id FROM exits WHERE user_id=? AND status IN ('pending','accepted')",
        )
        .get(user.id)
    )
      throw new HttpError(409, "You already have an exit in progress.");
    const b = await body();
    const requested = isoDate(b.requested_last_day, "Requested last day");
    if (requested && requested < today())
      throw new HttpError(400, "Requested last day cannot be in the past.");
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,requested_last_day,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              "resignation",
              "employee",
              today(),
              await noticeFor(user),
              requested,
              string(b.reason, "Reason", 500),
              user.id,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("resignation_submitted", { id });
      return id;
    });
    return send(201, { id });
  });
  router.post("/api/exit/withdraw", async ({ user, send, audit }) => {
    const x = await db
      .prepare(
        "SELECT * FROM exits WHERE user_id=? AND status='pending' AND initiated_by='employee'",
      )
      .get(user.id);
    if (!x)
      throw new HttpError(
        409,
        "There is no pending resignation to withdraw. Ask HR if it was already accepted.",
      );
    await db
      .prepare("UPDATE exits SET status='withdrawn' WHERE id=?")
      .run(x.id);
    await audit("resignation_withdrawn", { id: x.id });
    return send(200, { ok: true });
  });

  // ---- HR: list, start, decide ---------------------------------------------------------------
  router.get(
    "/api/admin/exits",
    { perm: "exit.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `${EXIT_SELECT} WHERE x.company_id=? ${status ? "AND x.status=?" : ""} ORDER BY x.id DESC LIMIT 300`,
          )
          .all(...(status ? [companyId, status] : [companyId])),
      );
    },
  );
  router.post(
    "/api/admin/exits",
    { perm: "exit.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const person = await owned("users", b.user_id, companyId, "employee");
      if (person.role === "super_admin" || !person.active)
        throw new HttpError(400, "Choose an active employee.");
      if (person.id === user.id)
        throw new HttpError(
          400,
          "You cannot start your own exit here. Use Resign.",
        );
      if (
        await db
          .prepare(
            "SELECT id FROM exits WHERE user_id=? AND status IN ('pending','accepted')",
          )
          .get(person.id)
      )
        throw new HttpError(
          409,
          "This employee already has an exit in progress.",
        );
      const kind = oneOf(b.kind, "Type", KINDS);
      const lwd = isoDate(b.last_working_day, "Last working day");
      if (!lwd) throw new HttpError(400, "Last working day is required.");
      const given = isoDate(b.notice_given_on, "Notice date") ?? today();
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,last_working_day,waive_notice,reason,status,decided_by,decided_at,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,'accepted',?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                kind,
                "company",
                given,
                await noticeFor(person),
                lwd,
                b.waive_notice ? 1 : 0,
                optionalString(b.reason, "Reason", 500),
                user.id,
                nowIso(),
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await db
          .prepare("UPDATE users SET exit_date=? WHERE id=?")
          .run(lwd, person.id);
        await startClearance({ id, user_id: person.id });
        await audit("exit_started", { id, employeeId: person.id, kind, lwd });
        return id;
      });
      return send(201, { id });
    },
  );
  router.get(
    "/api/admin/exits/:id",
    { perm: "exit.manage" },
    async ({ params, companyId, send }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      const settlement = await db
        .prepare(
          "SELECT * FROM settlements WHERE exit_id=? AND status='posted'",
        )
        .get(x.id);
      return send(200, {
        ...(await db.prepare(`${EXIT_SELECT} WHERE x.id=?`).get(x.id)),
        clearance: await db
          .prepare(
            "SELECT c.*,u.name cleared_by_name FROM exit_clearance c LEFT JOIN users u ON u.id=c.cleared_by WHERE c.exit_id=? ORDER BY c.id",
          )
          .all(x.id),
        settlement: settlement
          ? { ...settlement, data: JSON.parse(settlement.data) }
          : null,
      });
    },
  );
  router.post(
    "/api/admin/exits/:id/decide",
    { perm: "exit.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      if (x.status !== "pending")
        throw new HttpError(409, `This exit is already ${x.status}.`);
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["accepted", "rejected"]);
      const note = optionalString(b.note, "Note", 300);
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Say why the resignation is not accepted.");
      const lwd =
        decision === "accepted"
          ? (isoDate(b.last_working_day, "Last working day") ??
            addDays(x.notice_given_on, x.notice_days))
          : null;
      if (lwd && lwd < x.notice_given_on)
        throw new HttpError(
          400,
          "Last working day cannot be before the notice date.",
        );
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE exits SET status=?,last_working_day=?,waive_notice=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?",
          )
          .run(
            decision,
            lwd,
            b.waive_notice ? 1 : 0,
            user.id,
            nowIso(),
            note,
            x.id,
          );
        if (decision === "accepted") {
          await db
            .prepare("UPDATE users SET exit_date=? WHERE id=?")
            .run(lwd, x.user_id);
          await startClearance(x);
        }
        await audit("exit_decided", { id: x.id, decision, lwd });
      });
      return send(200, { ok: true });
    },
  );
  router.patch(
    "/api/admin/exits/:id",
    { perm: "exit.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      if (x.status !== "accepted")
        throw new HttpError(409, "Only an accepted exit can be changed.");
      if (
        await db
          .prepare(
            "SELECT id FROM settlements WHERE exit_id=? AND status='posted'",
          )
          .get(x.id)
      )
        throw new HttpError(
          409,
          "Void the settlement before changing the last working day.",
        );
      const b = await body();
      const lwd =
        b.last_working_day === undefined
          ? x.last_working_day
          : isoDate(b.last_working_day, "Last working day");
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE exits SET last_working_day=?,waive_notice=? WHERE id=?",
          )
          .run(
            lwd,
            b.waive_notice === undefined
              ? x.waive_notice
              : b.waive_notice
                ? 1
                : 0,
            x.id,
          );
        await db
          .prepare("UPDATE users SET exit_date=? WHERE id=?")
          .run(lwd, x.user_id);
        await audit("exit_updated", { id: x.id, lwd });
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/exits/:id/cancel",
    { perm: "exit.manage" },
    async ({ params, companyId, send, audit }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      if (!["pending", "accepted"].includes(x.status))
        throw new HttpError(409, `This exit is already ${x.status}.`);
      if (
        await db
          .prepare(
            "SELECT id FROM settlements WHERE exit_id=? AND status='posted'",
          )
          .get(x.id)
      )
        throw new HttpError(409, "Void the settlement first.");
      await transaction(async () => {
        await db
          .prepare("UPDATE exits SET status='withdrawn' WHERE id=?")
          .run(x.id);
        await db
          .prepare("UPDATE users SET exit_date=NULL WHERE id=?")
          .run(x.user_id);
        await db
          .prepare("DELETE FROM exit_clearance WHERE exit_id=?")
          .run(x.id);
        await audit("exit_cancelled", { id: x.id });
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/exits/:id/interview",
    { perm: "exit.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      const b = await body();
      await db
        .prepare(
          "UPDATE exits SET interview_notes=?,interview_reason=?,would_rejoin=? WHERE id=?",
        )
        .run(
          string(b.notes, "Notes", 3000),
          optionalString(b.reason, "Main reason", 100),
          b.would_rejoin === undefined ? null : b.would_rejoin ? 1 : 0,
          x.id,
        );
      await audit("exit_interview", { id: x.id });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/exits/:id/clearance/:itemId",
    async ({ user, params, body, send, audit }) => {
      const x = await owned("exits", params.id, user.company_id, "exit");
      const item = await db
        .prepare("SELECT * FROM exit_clearance WHERE id=? AND exit_id=?")
        .get(integer(Number(params.itemId)), x.id);
      if (!item) throw new HttpError(404, "Clearance item not found.");
      const manager =
        item.department === "Manager" &&
        (
          await db
            .prepare("SELECT manager_id FROM users WHERE id=?")
            .get(x.user_id)
        ).manager_id === user.id;
      if (!can(user, "exit.manage") && !manager)
        throw new HttpError(403, "You cannot clear this item.");
      if (x.status !== "accepted")
        throw new HttpError(409, "The exit is not in progress.");
      const b = await body();
      const cleared = b.cleared === false ? 0 : 1;
      if (cleared && item.asset_id) {
        const a = await db
          .prepare("SELECT status,assigned_to FROM assets WHERE id=?")
          .get(item.asset_id);
        if (a.status === "assigned" && a.assigned_to === x.user_id)
          throw new HttpError(
            409,
            "Record the asset as returned under Assets first.",
          );
      }
      await db
        .prepare(
          "UPDATE exit_clearance SET cleared=?,cleared_by=?,cleared_at=?,note=? WHERE id=?",
        )
        .run(
          cleared,
          cleared ? user.id : null,
          cleared ? nowIso() : null,
          optionalString(b.note, "Note", 200),
          item.id,
        );
      await audit("exit_clearance", { id: x.id, item: item.id, cleared });
      return send(200, { ok: true });
    },
  );

  // ---- full and final settlement -------------------------------------------------------------------
  async function computeSettlement(x, person, payIn, exclude = []) {
    const lwd = x.last_working_day;
    const info = [];
    const lines = [];
    const salary = await db
      .prepare(
        "SELECT * FROM employee_salaries WHERE company_id=? AND user_id=? AND substr(effective_from,1,7)<=? ORDER BY effective_from DESC LIMIT 1",
      )
      .get(x.company_id, person.id, monthOf(lwd));
    const slines = salary
      ? await db
          .prepare(
            "SELECT * FROM employee_salary_lines WHERE salary_id=? ORDER BY id",
          )
          .all(salary.id)
      : [];
    if (!salary)
      info.push(
        "No salary is set, so nothing can be calculated. Set the salary first.",
      );
    else
      info.push(
        `Salary up to ${lwd} is paid through the ${payIn} payroll run (days after the last working day are not paid).`,
      );
    const config = await loadConfig(db, x.company_id);
    const keep = (key) => !exclude.includes(key);

    if (salary) {
      // Notice shortfall on a resignation, unless waived.
      if (x.kind === "resignation" && !x.waive_notice) {
        const served = Math.max(0, days(x.notice_given_on, lwd));
        const short = Math.max(0, x.notice_days - served);
        if (short)
          lines.push({
            key: "notice",
            kind: "deduction",
            name: `Notice period shortfall (${short} days)`,
            amount: round((salary.monthly_gross / 30) * short),
            taxable: false,
            note: `Notice ${x.notice_days} days, served ${served}. One day = gross ÷ 30.`,
          });
      }
      // Leave encashment of paid, encashable leave types.
      const rate = encashmentRate(
        slines.map((l) => ({ ...l, is_basic: Boolean(l.is_basic) })),
        config.leaveEncashment,
      );
      let enc = 0;
      const encLines = [];
      for (const b of await balances(app, person, lwd)) {
        const type = await db
          .prepare("SELECT * FROM leave_types WHERE id=?")
          .get(b.leave_type_id);
        if (!type.encashable || b.balance === null || b.balance <= 0) continue;
        const amt = round(rate * b.balance);
        enc += amt;
        encLines.push({ type, days: b.balance, year: b.year, amount: amt });
      }
      if (enc && keep("encashment")) {
        const exempt = ["resignation", "retirement"].includes(x.kind)
          ? Math.min(enc, ENCASHMENT_EXEMPT)
          : 0;
        lines.push({
          key: "encashment",
          kind: "earning",
          name: `Leave encashment (${encLines.map((l) => `${l.days} ${l.type.code}`).join(", ")})`,
          amount: enc,
          taxable: exempt < enc,
          note: exempt
            ? `Exempt from tax up to ₹25 lakh on resignation or retirement${exempt < enc ? "; the amount above that is taxable" : ""}.`
            : "Taxable: exemption applies only on resignation or retirement.",
          ledger: encLines.map((l) => ({
            leave_type_id: l.type.id,
            year: l.year,
            days: l.days,
          })),
        });
      }
      // Gratuity.
      if (person.date_of_joining) {
        const basic = slines
          .filter((l) => l.is_basic)
          .reduce((s, l) => s + l.amount, 0);
        const gross = slines.reduce((s, l) => s + l.amount, 0);
        const g = gratuity({
          wages: Math.max(basic, gross / 2),
          joined: person.date_of_joining,
          asOf: lwd,
          employmentType: person.employment_type ?? "full_time",
        });
        if (g.eligible && g.payable && keep("gratuity"))
          lines.push({
            key: "gratuity",
            kind: "earning",
            name: `Gratuity (${g.counted_years} years)`,
            amount: g.payable,
            taxable: false,
            note: "Within the ₹20 lakh exempt limit.",
          });
        else if (!g.eligible)
          info.push(
            `Gratuity not payable: ${g.service_years} years of service, ${g.eligible_after_years ?? "n/a"} needed.`,
          );
      } else info.push("No date of joining, so gratuity could not be checked.");
    }
    // Loan and advance balance is recovered by moving the instalments into the same run.
    const loans = await db
      .prepare(
        "SELECT s.id,s.month,s.amount,l.kind FROM payroll_loan_schedule s JOIN payroll_loans l ON l.id=s.loan_id WHERE l.user_id=? AND l.status='active' AND s.status='pending' AND s.month>?",
      )
      .all(person.id, payIn);
    const loanTotal = loans.reduce((s, r) => s + r.amount, 0);
    if (loanTotal)
      info.push(
        `Remaining loan and advance instalments of ₹${loanTotal} will be recovered in the ${payIn} run, together with any already due.`,
      );
    const claims = await db
      .prepare(
        "SELECT COALESCE(SUM(COALESCE(approved_amount,amount)),0) n FROM reimbursement_claims WHERE user_id=? AND status='approved'",
      )
      .get(person.id);
    if (claims.n)
      info.push(
        `Approved reimbursement claims of ₹${claims.n} will be paid in the same run.`,
      );
    const pending = await db
      .prepare(
        "SELECT COUNT(*) n FROM reimbursement_claims WHERE user_id=? AND status='pending'",
      )
      .get(person.id);
    if (pending.n)
      info.push(
        `${pending.n} reimbursement claim(s) are still waiting for approval and will not be paid unless decided first.`,
      );
    for (let i = lines.length - 1; i >= 0; i--)
      if (!keep(lines[i].key)) lines.splice(i, 1);
    const earn = lines
      .filter((l) => l.kind === "earning")
      .reduce((s, l) => s + l.amount, 0);
    const ded = lines
      .filter((l) => l.kind === "deduction")
      .reduce((s, l) => s + l.amount, 0);
    return {
      last_working_day: lwd,
      pay_in_month: payIn,
      lines,
      loan_instalments: loans,
      loan_total: loanTotal,
      info,
      total_earnings: earn,
      total_deductions: ded,
    };
  }
  const payInFor = async (x, b, companyId) => {
    const m = b.pay_in_month ?? monthOf(x.last_working_day);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m))
      throw new HttpError(400, "Choose a month like 2026-11.");
    if (m < monthOf(x.last_working_day))
      throw new HttpError(400, "Pay in the last month of service or later.");
    if (await monthLocked(companyId, m))
      throw new HttpError(
        409,
        `${m} payroll is already approved. Choose a later month.`,
      );
    return m;
  };
  const loadAccepted = async (id, companyId) => {
    const x = await owned("exits", id, companyId, "exit");
    if (x.status !== "accepted")
      throw new HttpError(409, "The exit must be accepted first.");
    return x;
  };
  router.get(
    "/api/admin/exits/:id/settlement-preview",
    { perm: "payroll.read" },
    async ({ params, companyId, query, send }) => {
      const x = await loadAccepted(params.id, companyId);
      const person = await db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(x.user_id);
      const exclude = (query.get("exclude") ?? "").split(",").filter(Boolean);
      return send(
        200,
        await computeSettlement(
          x,
          person,
          await payInFor(
            x,
            { pay_in_month: query.get("pay_in_month") ?? undefined },
            companyId,
          ),
          exclude,
        ),
      );
    },
  );
  // Posting adds the lines to the pay-in month's payroll, where tax and net pay are worked out.
  router.post(
    "/api/admin/exits/:id/settlement",
    { perm: "payroll.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const x = await loadAccepted(params.id, companyId);
      if (
        await db
          .prepare(
            "SELECT id FROM settlements WHERE exit_id=? AND status='posted'",
          )
          .get(x.id)
      )
        throw new HttpError(
          409,
          "The settlement has already been posted. Void it to redo it.",
        );
      const person = await db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(x.user_id);
      const b = await body();
      const payIn = await payInFor(x, b, companyId);
      const calc = await computeSettlement(
        x,
        person,
        payIn,
        Array.isArray(b.exclude) ? b.exclude : [],
      );
      if (calc.info.some((i) => i.startsWith("No salary")))
        throw new HttpError(409, "Set the employee's salary first.");
      const extras = (Array.isArray(b.extras) ? b.extras : []).map((e) => ({
        key: "extra",
        kind: oneOf(e.kind, "Type", ["earning", "deduction"]),
        name: string(e.name, "Description", 80),
        amount: round(number(e.amount, "Amount", 1, 100000000)),
        taxable: e.taxable !== false,
        note: null,
      }));
      const all = [...calc.lines, ...extras];
      await transaction(async () => {
        const posted = [];
        for (const l of all) {
          let ledgerIds = [];
          if (l.key === "encashment")
            for (const e of l.ledger)
              ledgerIds.push(
                Number(
                  (
                    await db
                      .prepare(
                        "INSERT INTO leave_ledger(company_id,user_id,leave_type_id,leave_year,kind,days,period,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                      )
                      .run(
                        companyId,
                        person.id,
                        e.leave_type_id,
                        e.year,
                        "encashment",
                        -e.days,
                        null,
                        "Encashed at exit",
                        user.id,
                        nowIso(),
                      )
                  ).lastInsertRowid,
                ),
              );
          const adj = Number(
            (
              await db
                .prepare(
                  "INSERT INTO payroll_adjustments(company_id,user_id,month,kind,name,amount,taxable,note,created_by,created_at,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  companyId,
                  person.id,
                  payIn,
                  l.kind,
                  l.name,
                  l.amount,
                  l.taxable ? 1 : 0,
                  l.note,
                  user.id,
                  nowIso(),
                  "fnf",
                  x.id,
                )
            ).lastInsertRowid,
          );
          posted.push({
            ...l,
            adjustment_id: adj,
            ledger_ids: ledgerIds,
            ledger: undefined,
          });
        }
        // Pull future loan instalments into the final run, remembering where they were.
        const moved = [];
        for (const s of calc.loan_instalments) {
          moved.push({ id: s.id, month: s.month });
          await db
            .prepare("UPDATE payroll_loan_schedule SET month=? WHERE id=?")
            .run(payIn, s.id);
        }
        await db
          .prepare(
            "INSERT INTO settlements(company_id,exit_id,user_id,pay_in_month,data,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (exit_id) DO UPDATE SET status='posted',pay_in_month=EXCLUDED.pay_in_month,data=EXCLUDED.data,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at",
          )
          .run(
            companyId,
            x.id,
            person.id,
            payIn,
            JSON.stringify({
              lines: posted,
              moved_instalments: moved,
              info: calc.info,
              last_working_day: x.last_working_day,
            }),
            user.id,
            nowIso(),
          );
        await audit("settlement_posted", {
          id: x.id,
          payIn,
          lines: posted.length,
        });
      });
      return send(201, { ok: true, pay_in_month: payIn });
    },
  );
  router.delete(
    "/api/admin/exits/:id/settlement",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      const s = await db
        .prepare(
          "SELECT * FROM settlements WHERE exit_id=? AND status='posted'",
        )
        .get(x.id);
      if (!s) throw new HttpError(404, "No posted settlement.");
      if (await monthLocked(companyId, s.pay_in_month))
        throw new HttpError(409, "That month's payroll is already approved.");
      const data = JSON.parse(s.data);
      await transaction(async () => {
        for (const l of data.lines) {
          await db
            .prepare("DELETE FROM payroll_adjustments WHERE id=?")
            .run(l.adjustment_id);
          for (const id of l.ledger_ids ?? [])
            await db
              .prepare(
                "DELETE FROM leave_ledger WHERE id=? AND kind='encashment'",
              )
              .run(id);
        }
        for (const m of data.moved_instalments)
          await db
            .prepare(
              "UPDATE payroll_loan_schedule SET month=? WHERE id=? AND status='pending'",
            )
            .run(m.month, m.id);
        await db
          .prepare("UPDATE settlements SET status='void' WHERE id=?")
          .run(s.id);
        await audit("settlement_voided", { id: x.id });
      });
      return send(200, { ok: true });
    },
  );

  // ---- completion and letters ----------------------------------------------------------------------
  router.post(
    "/api/admin/exits/:id/complete",
    { perm: "exit.manage" },
    async ({ user, params, companyId, send, audit }) => {
      const x = await loadAccepted(params.id, companyId);
      const open = await db
        .prepare(
          "SELECT COUNT(*) n FROM exit_clearance WHERE exit_id=? AND cleared=0",
        )
        .get(x.id);
      if (open.n)
        throw new HttpError(409, `${open.n} clearance item(s) are still open.`);
      if (x.last_working_day > today())
        throw new HttpError(409, "The last working day has not come yet.");
      const s = await db
        .prepare(
          "SELECT * FROM settlements WHERE exit_id=? AND status='posted'",
        )
        .get(x.id);
      if (!s)
        throw new HttpError(409, "Post the full and final settlement first.");
      const run = await db
        .prepare(
          "SELECT status FROM payroll_runs WHERE company_id=? AND month=?",
        )
        .get(companyId, s.pay_in_month);
      if (!run || run.status === "draft")
        throw new HttpError(
          409,
          `Approve the ${s.pay_in_month} payroll run, which pays the settlement, before completing the exit.`,
        );
      if (
        await db
          .prepare(
            "SELECT id FROM assets WHERE assigned_to=? AND status='assigned'",
          )
          .get(x.user_id)
      )
        throw new HttpError(
          409,
          "Company assets are still assigned to this person.",
        );
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE exits SET status='completed',completed_at=? WHERE id=?",
          )
          .run(nowIso(), x.id);
        await db.prepare("UPDATE users SET active=0 WHERE id=?").run(x.user_id);
        await db
          .prepare(
            "UPDATE devices SET status='revoked' WHERE user_id=? AND status<>'revoked'",
          )
          .run(x.user_id);
        await db
          .prepare(
            "UPDATE payroll_loans SET status='cancelled' WHERE user_id=? AND status='active' AND NOT EXISTS (SELECT 1 FROM payroll_loan_schedule s WHERE s.loan_id=payroll_loans.id AND s.status='pending')",
          )
          .run(x.user_id);
        await audit("exit_completed", { id: x.id, employeeId: x.user_id });
      });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/exits/:id/letter",
    { perm: "exit.manage" },
    async ({ params, companyId, query, send }) => {
      const x = await owned("exits", params.id, companyId, "exit");
      if (x.status !== "completed")
        throw new HttpError(
          409,
          "Letters are available once the exit is complete.",
        );
      const kind = oneOf(query.get("kind") ?? "experience", "Letter", [
        "relieving",
        "experience",
      ]);
      const row = await db.prepare(`${EXIT_SELECT} WHERE x.id=?`).get(x.id);
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        company: company.name,
        ...exitLetter(kind, {
          company: company.name,
          person: {
            name: row.employee_name,
            employee_code: row.employee_code,
            designation_name: row.designation_name,
            department_name: row.department_name,
          },
          joined: row.date_of_joining ?? row.created_at.slice(0, 10),
          lastDay: x.last_working_day,
          today: today(),
        }),
      });
    },
  );
}
