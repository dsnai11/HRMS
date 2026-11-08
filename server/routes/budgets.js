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
import { permissionsOf } from "../rbac.js";
import { inBranchScope, requireOwned, staffWith } from "../scope.js";
import { taxYearOf } from "../payroll/tax.js";

// Branch budgets (see migration 062). Each financial year (April to March) has a budget for
// every branch and the head office, made of budget heads, in whole rupees by month. Finance
// prepares it (budget.manage), submits it, and someone else approves it (budget.approve).
// After approval a change needs a reason and is kept in budget_revisions.
// Actual spending: payroll employer cost of the people in the branch (approved and paid
// runs), approved reimbursement claims, and spending entered by hand for the other heads.
// People count against the branch they are in today, as in the payroll cost report.
const DEFAULT_HEADS = [
  ["SAL", "Salaries and wages", "payroll"],
  ["REIMB", "Staff reimbursements", "claims"],
  ["INC", "Incentives", "manual"],
  ["REC", "Recruitment", "manual"],
  ["TRN", "Training", "manual"],
  ["WEL", "Staff welfare", "manual"],
];
const MONTH_KEYS = ["apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec", "jan", "feb", "mar"];
const STATUS_LABEL = { draft: "Draft", submitted: "Submitted for approval", approved: "Approved" };
const monthRe = /^\d{4}-(0[1-9]|1[0-2])$/;

export const fyMonths = (fy) =>
  MONTH_KEYS.map((_, i) => {
    const m = ((3 + i) % 12) + 1;
    return `${m >= 4 ? fy : fy + 1}-${String(m).padStart(2, "0")}`;
  });
export const fyLabel = (fy) => `${fy}-${String(fy + 1).slice(2)}`;
// A yearly amount in whole rupees spread over twelve months; March takes the remainder.
export const spread = (annual) => {
  const each = Math.floor(annual / 12);
  return MONTH_KEYS.map((_, i) => (i === 11 ? annual - each * 11 : each));
};
const rupees = (v, label) =>
  Math.round(number(typeof v === "string" && v.trim() !== "" ? Number(v.replace(/,/g, "")) : v, label, 0, 1e11));
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
// Over budget, close to it (90% or more), within it, or no budget for the period.
const flagOf = (actual, budget) =>
  !budget ? (actual ? "no_budget" : "none") : actual > budget ? "over" : actual >= budget * 0.9 ? "near" : "ok";

export function registerBudgets(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const thisMonth = () => app.dayOf(nowIso()).slice(0, 7);
  const currentFy = () => taxYearOf(thisMonth());
  const fyOf = (v) => {
    const fy = v === undefined || v === null || v === "" ? currentFy() : Number(v);
    if (!Number.isInteger(fy) || fy < 2020 || fy > 2100)
      throw new HttpError(400, "Choose a valid financial year.");
    return fy;
  };

  async function heads(companyId) {
    const list = () =>
      db.prepare("SELECT * FROM budget_heads WHERE company_id=? ORDER BY sort_order,id").all(companyId);
    let rows = await list();
    if (!rows.length) {
      // A starting set for an NBFC branch network; finance can rename, add or retire heads.
      for (const [i, [code, name, source]] of DEFAULT_HEADS.entries())
        await db
          .prepare(
            "INSERT INTO budget_heads(company_id,name,code,source,sort_order,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING",
          )
          .run(companyId, name, code, source, i + 1, nowIso());
      rows = await list();
    }
    return rows;
  }
  // Branches the caller may see: all, or those of a branch-limited role. The head office first.
  const branchesFor = async (user, companyId) =>
    (
      await db
        .prepare(
          "SELECT id,name,code,city,state,zone,region,head_office,active FROM branches WHERE company_id=? ORDER BY head_office DESC,zone,region,name",
        )
        .all(companyId)
    ).filter((b) => inBranchScope(user, b.id));
  async function yearRow(companyId, fy) {
    return (
      (await db.prepare("SELECT * FROM budget_years WHERE company_id=? AND fy=?").get(companyId, fy)) ?? {
        fy,
        status: "draft",
      }
    );
  }
  async function editableYear(companyId, fy, reason) {
    const y = await yearRow(companyId, fy);
    if (y.status === "submitted")
      throw new HttpError(409, "This budget is waiting for approval. Send it back to draft to change it.");
    if (y.status === "approved" && !reason)
      throw new HttpError(400, "The budget is approved: give a reason for the change.");
    return y;
  }
  const branchOf = async (user, companyId, id) => {
    const b = await requireOwned(db, "branches", integer(Number(id)), companyId, "branch");
    if (!inBranchScope(user, b.id)) throw new HttpError(403, "This branch is outside your role.");
    return b;
  };
  const headOf = async (companyId, id) =>
    requireOwned(db, "budget_heads", integer(Number(id)), companyId, "budget head");

  // Replaces one branch's budget for one head with twelve monthly amounts, recording a
  // revision if the year is approved. Returns the old and new yearly totals.
  async function setLine({ user, companyId, fy, branchId, headId, months, reason, approved }) {
    const old = await db
      .prepare("SELECT month,amount FROM budget_lines WHERE company_id=? AND branch_id=? AND head_id=? AND fy=?")
      .all(companyId, branchId, headId, fy);
    const oldTotal = old.reduce((s, r) => s + r.amount, 0);
    const newTotal = months.reduce((s, v) => s + v, 0);
    const same =
      old.length === 12 && fyMonths(fy).every((m, i) => old.find((r) => r.month === m)?.amount === months[i]);
    if (same || (!old.length && !newTotal)) return { oldTotal, newTotal, changed: false };
    await db
      .prepare("DELETE FROM budget_lines WHERE company_id=? AND branch_id=? AND head_id=? AND fy=?")
      .run(companyId, branchId, headId, fy);
    if (newTotal)
      for (const [i, m] of fyMonths(fy).entries())
        await db
          .prepare("INSERT INTO budget_lines(company_id,fy,branch_id,head_id,month,amount) VALUES(?,?,?,?,?,?)")
          .run(companyId, fy, branchId, headId, m, months[i]);
    if (approved)
      await db
        .prepare(
          "INSERT INTO budget_revisions(company_id,fy,branch_id,head_id,old_amount,new_amount,reason,revised_by,revised_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(companyId, fy, branchId, headId, oldTotal, newTotal, reason, user.id, nowIso());
    return { oldTotal, newTotal, changed: true };
  }
  // Twelve monthly amounts from a request: `months` (12 numbers) or `annual`, spread evenly.
  const monthsFrom = (b) => {
    if (Array.isArray(b.months)) {
      if (b.months.length !== 12) throw new HttpError(400, "Give twelve monthly amounts, April to March.");
      return b.months.map((v, i) => rupees(v === "" || v == null ? 0 : v, `${MONTH_KEYS[i]} amount`));
    }
    return spread(rupees(b.annual ?? 0, "Yearly budget"));
  };

  // ---- budget plan -----------------------------------------------------------------------------
  router.get("/api/admin/budgets", { perm: "budget.read" }, async ({ user, companyId, query, send }) => {
    const fy = fyOf(query.get("fy"));
    const [list, branches, year] = [await heads(companyId), await branchesFor(user, companyId), await yearRow(companyId, fy)];
    const seen = new Set(branches.map((b) => b.id));
    const lines = {};
    for (const r of await db
      .prepare("SELECT branch_id,head_id,SUM(amount) amount FROM budget_lines WHERE company_id=? AND fy=? GROUP BY branch_id,head_id")
      .all(companyId, fy))
      if (seen.has(r.branch_id)) (lines[r.branch_id] ??= {})[r.head_id] = Number(r.amount);
    const posts = {};
    for (const r of await db
      .prepare("SELECT branch_id,SUM(sanctioned) n FROM budget_posts WHERE company_id=? AND fy=? GROUP BY branch_id")
      .all(companyId, fy))
      posts[r.branch_id] = Number(r.n);
    const name = async (id) => id && (await db.prepare("SELECT name FROM users WHERE id=?").get(id))?.name;
    return send(200, {
      fy,
      label: fyLabel(fy),
      current_fy: currentFy(),
      months: fyMonths(fy),
      status: year.status,
      status_label: STATUS_LABEL[year.status],
      submitted_by: year.submitted_by ?? null,
      submitted_by_name: await name(year.submitted_by),
      submitted_at: year.submitted_at ?? null,
      approved_by_name: await name(year.approved_by),
      approved_at: year.approved_at ?? null,
      note: year.note ?? null,
      heads: list,
      branches,
      lines,
      posts,
      revisions: Number(
        (await db.prepare("SELECT COUNT(*) n FROM budget_revisions WHERE company_id=? AND fy=?").get(companyId, fy)).n,
      ),
    });
  });

  // One branch's monthly budget for one head (for the edit dialog).
  router.get("/api/admin/budgets/line", { perm: "budget.read" }, async ({ user, companyId, query, send }) => {
    const fy = fyOf(query.get("fy"));
    const branch = await branchOf(user, companyId, query.get("branch_id"));
    const head = await headOf(companyId, query.get("head_id"));
    const rows = await db
      .prepare("SELECT month,amount FROM budget_lines WHERE company_id=? AND fy=? AND branch_id=? AND head_id=?")
      .all(companyId, fy, branch.id, head.id);
    return send(200, {
      months: fyMonths(fy).map((m) => ({ month: m, amount: rows.find((r) => r.month === m)?.amount ?? 0 })),
    });
  });

  router.put("/api/admin/budgets/line", { perm: "budget.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const fy = fyOf(b.fy);
    const branch = await branchOf(user, companyId, b.branch_id);
    const head = await headOf(companyId, b.head_id);
    const reason = optionalString(b.reason, "Reason", 300);
    const year = await editableYear(companyId, fy, reason);
    const months = monthsFrom(b);
    const r = await transaction(() =>
      setLine({ user, companyId, fy, branchId: branch.id, headId: head.id, months, reason, approved: year.status === "approved" }),
    );
    if (r.changed)
      await audit("budget_line_set", { fy, branch: branch.id, head: head.code, from: r.oldTotal, to: r.newTotal, reason });
    return send(200, { ok: true, annual: r.newTotal });
  });

  // Spreadsheet import: budget lines (branch, head, yearly or month columns) or the manpower
  // plan (branch, designation, sanctioned). `dry_run` checks the file without saving.
  router.post("/api/admin/budgets/import", { perm: "budget.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body(2_000_000);
    const fy = fyOf(b.fy);
    const kind = oneOf(b.kind ?? "lines", "Import", ["lines", "posts"]);
    const reason = optionalString(b.reason, "Reason", 300);
    const year = await editableYear(companyId, fy, kind === "lines" ? reason : "manpower plan");
    if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, "The file has no rows.");
    if (b.rows.length > 20000) throw new HttpError(400, "Import at most 20,000 rows at a time.");
    const branches = await branchesFor(user, companyId);
    const findBranch = (v) => {
      const key = String(v ?? "").trim().toLowerCase();
      return key && branches.find((x) => (x.code && x.code.toLowerCase() === key) || x.name.toLowerCase() === key);
    };
    const headList = await heads(companyId);
    const designations = await db.prepare("SELECT id,name FROM designations WHERE company_id=?").all(companyId);
    const report = [];
    const work = [];
    const seen = new Set();
    for (const [i, row] of b.rows.entries()) {
      const line = i + 2; // the header is line 1
      const fail = (reason) => report.push({ line, branch: row.branch, status: "failed", reason });
      const branch = findBranch(row.branch ?? row.branch_code);
      if (!branch) {
        fail("Branch not found (use its code or name)");
        continue;
      }
      if (kind === "lines") {
        const key = String(row.head ?? row.head_code ?? "").trim().toLowerCase();
        const head = headList.find((h) => h.code.toLowerCase() === key || h.name.toLowerCase() === key);
        if (!head) {
          fail("Budget head not found (use its code)");
          continue;
        }
        let months;
        try {
          const monthly = MONTH_KEYS.some((k) => String(row[k] ?? "").trim() !== "");
          months = monthly
            ? MONTH_KEYS.map((k) => rupees(String(row[k] ?? "").replace(/,/g, "") || 0, k.toUpperCase()))
            : spread(rupees(String(row.annual ?? "").replace(/,/g, ""), "Yearly budget"));
        } catch (e) {
          fail(e.message);
          continue;
        }
        if (seen.has(`${branch.id}:${head.id}`)) {
          fail("This branch and head are already in the file");
          continue;
        }
        seen.add(`${branch.id}:${head.id}`);
        work.push({ line, branch, head, months });
        report.push({ line, branch: branch.name, head: head.code, annual: months.reduce((s, v) => s + v, 0), status: "ok" });
      } else {
        const d = designations.find((x) => x.name.toLowerCase() === String(row.designation ?? "").trim().toLowerCase());
        if (!d) {
          fail("Designation not found (add it under Organization first)");
          continue;
        }
        const n = Number(row.sanctioned);
        if (!Number.isInteger(n) || n < 0 || n > 10000) {
          fail("Sanctioned posts must be a whole number");
          continue;
        }
        work.push({ line, branch, designation: d, n });
        report.push({ line, branch: branch.name, designation: d.name, sanctioned: n, status: "ok" });
      }
    }
    const failed = report.filter((r) => r.status === "failed").length;
    if (b.dry_run || failed) return send(200, { report, ok: report.length - failed, failed, saved: false });
    await transaction(async () => {
      for (const w of work)
        if (kind === "lines")
          await setLine({ user, companyId, fy, branchId: w.branch.id, headId: w.head.id, months: w.months, reason, approved: year.status === "approved" });
        else
          await db
            .prepare(
              "INSERT INTO budget_posts(company_id,fy,branch_id,designation_id,sanctioned) VALUES(?,?,?,?,?) ON CONFLICT (company_id,fy,branch_id,designation_id) DO UPDATE SET sanctioned=EXCLUDED.sanctioned",
            )
            .run(companyId, fy, w.branch.id, w.designation.id, w.n);
    });
    await audit("budget_imported", { fy, kind, rows: work.length, reason });
    return send(200, { report, ok: work.length, failed: 0, saved: true });
  });

  // Starts a year from another year's budget, raised or lowered by a percentage.
  router.post("/api/admin/budgets/copy", { perm: "budget.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const fy = fyOf(b.fy);
    const from = fyOf(b.from_fy);
    if (from === fy) throw new HttpError(400, "Choose a different year to copy from.");
    const year = await yearRow(companyId, fy);
    if (year.status !== "draft") throw new HttpError(409, "Only a draft budget can be filled from another year.");
    const change = number(b.change_pct ?? 0, "Change", -90, 500);
    const allowed = new Set((await branchesFor(user, companyId)).map((x) => x.id));
    const source = await db
      .prepare("SELECT branch_id,head_id,month,amount FROM budget_lines WHERE company_id=? AND fy=? ORDER BY branch_id,head_id,month")
      .all(companyId, from);
    if (!source.length) throw new HttpError(400, `There is no budget for ${fyLabel(from)} to copy.`);
    const fromMonths = fyMonths(from);
    const byLine = new Map();
    for (const r of source) {
      if (!allowed.has(r.branch_id)) continue;
      const k = `${r.branch_id}:${r.head_id}`;
      if (!byLine.has(k)) byLine.set(k, Array(12).fill(0));
      byLine.get(k)[fromMonths.indexOf(r.month)] = Math.round(r.amount * (1 + change / 100));
    }
    await transaction(async () => {
      for (const [k, months] of byLine) {
        const [branchId, headId] = k.split(":").map(Number);
        await setLine({ user, companyId, fy, branchId, headId, months, approved: false });
      }
    });
    await audit("budget_copied", { fy, from, change, lines: byLine.size });
    return send(200, { ok: true, lines: byLine.size });
  });

  // Maker-checker: submit, send back to draft, approve.
  router.post("/api/admin/budgets/status", { perm: "budget.read" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const fy = fyOf(b.fy);
    const action = oneOf(b.action, "Action", ["submit", "return", "approve"]);
    const note = optionalString(b.note, "Note", 300);
    const perms = permissionsOf(user);
    const year = await yearRow(companyId, fy);
    const next = { submit: "submitted", return: "draft", approve: "approved" }[action];
    if (action === "submit") {
      if (!perms.includes("budget.manage")) throw new HttpError(403, "You cannot submit budgets.");
      if (year.status !== "draft") throw new HttpError(409, "Only a draft budget can be submitted.");
      const lines = await db.prepare("SELECT COUNT(*) n FROM budget_lines WHERE company_id=? AND fy=?").get(companyId, fy);
      if (!Number(lines.n)) throw new HttpError(400, "Add budgets for the branches before submitting.");
    } else {
      if (!perms.includes("budget.approve")) throw new HttpError(403, "You cannot approve budgets.");
      if (year.status !== "submitted") throw new HttpError(409, "The budget is not waiting for approval.");
      if (action === "approve" && year.submitted_by === user.id)
        throw new HttpError(403, "Someone other than the person who submitted it must approve the budget.");
      if (action === "return" && !note) throw new HttpError(400, "Say what needs to change.");
    }
    await db
      .prepare(
        `INSERT INTO budget_years(company_id,fy,status,submitted_by,submitted_at,approved_by,approved_at,note) VALUES(?,?,?,?,?,?,?,?)
         ON CONFLICT (company_id,fy) DO UPDATE SET status=EXCLUDED.status,submitted_by=EXCLUDED.submitted_by,submitted_at=EXCLUDED.submitted_at,
         approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at,note=EXCLUDED.note`,
      )
      .run(
        companyId,
        fy,
        next,
        action === "submit" ? user.id : (year.submitted_by ?? null),
        action === "submit" ? nowIso() : (year.submitted_at ?? null),
        action === "approve" ? user.id : null,
        action === "approve" ? nowIso() : null,
        note,
      );
    await audit({ submit: "budget_submitted", return: "budget_returned", approve: "budget_approved" }[action], { fy, note });
    const to =
      action === "submit"
        ? await staffWith(db, companyId, ["budget.approve"], user.id)
        : year.submitted_by && year.submitted_by !== user.id
          ? [{ id: year.submitted_by }]
          : [];
    if (to.length)
      await app.notify(
        to.map((x) => x.id),
        {
          companyId,
          kind: "budget",
          title:
            action === "submit"
              ? `Branch budget ${fyLabel(fy)} is waiting for your approval`
              : action === "approve"
                ? `Branch budget ${fyLabel(fy)} was approved`
                : `Branch budget ${fyLabel(fy)} was sent back`,
          body: note ?? undefined,
          link: "budgets",
        },
      );
    return send(200, { ok: true, status: next });
  });

  router.get("/api/admin/budgets/revisions", { perm: "budget.read" }, async ({ user, companyId, query, send }) => {
    const fy = fyOf(query.get("fy"));
    const rows = await db
      .prepare(
        `SELECT r.*,b.name branch_name,h.name head_name,u.name revised_by_name FROM budget_revisions r
         JOIN branches b ON b.id=r.branch_id JOIN budget_heads h ON h.id=r.head_id LEFT JOIN users u ON u.id=r.revised_by
         WHERE r.company_id=? AND r.fy=? ORDER BY r.id DESC LIMIT 500`,
      )
      .all(companyId, fy);
    return send(200, rows.filter((r) => inBranchScope(user, r.branch_id)));
  });

  // ---- manpower plan ---------------------------------------------------------------------------
  router.get("/api/admin/budgets/posts", { perm: "budget.read" }, async ({ user, companyId, query, send }) => {
    const fy = fyOf(query.get("fy"));
    const branch = await branchOf(user, companyId, query.get("branch_id"));
    const designations = await db
      .prepare("SELECT id,name FROM designations WHERE company_id=? AND active=1 ORDER BY name")
      .all(companyId);
    const plan = await db
      .prepare("SELECT designation_id,sanctioned FROM budget_posts WHERE company_id=? AND fy=? AND branch_id=?")
      .all(companyId, fy, branch.id);
    const filled = await db
      .prepare("SELECT designation_id,COUNT(*) n FROM users WHERE company_id=? AND branch_id=? AND active=1 AND role<>'super_admin' GROUP BY designation_id")
      .all(companyId, branch.id);
    const open = await db
      .prepare("SELECT designation_id,SUM(positions) n FROM job_openings WHERE company_id=? AND branch_id=? AND status='open' GROUP BY designation_id")
      .all(companyId, branch.id);
    const n = (rows, id, f = "n") => Number(rows.find((r) => r.designation_id === id)?.[f] ?? 0);
    return send(200, {
      branch: { id: branch.id, name: branch.name },
      rows: designations.map((d) => ({
        designation_id: d.id,
        name: d.name,
        sanctioned: n(plan, d.id, "sanctioned"),
        filled: n(filled, d.id),
        open: n(open, d.id),
      })),
      no_designation: n(filled, null),
    });
  });
  router.put("/api/admin/budgets/posts", { perm: "budget.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const fy = fyOf(b.fy);
    await editableYear(companyId, fy, "manpower plan");
    const branch = await branchOf(user, companyId, b.branch_id);
    if (!Array.isArray(b.rows)) throw new HttpError(400, "Send the posts for the branch.");
    const rows = [];
    for (const r of b.rows) {
      const d = await requireOwned(db, "designations", integer(Number(r.designation_id)), companyId, "designation");
      const n = Number(r.sanctioned);
      if (!Number.isInteger(n) || n < 0 || n > 10000) throw new HttpError(400, "Sanctioned posts must be a whole number.");
      rows.push([d.id, n]);
    }
    await transaction(async () => {
      for (const [d, n] of rows)
        if (n)
          await db
            .prepare(
              "INSERT INTO budget_posts(company_id,fy,branch_id,designation_id,sanctioned) VALUES(?,?,?,?,?) ON CONFLICT (company_id,fy,branch_id,designation_id) DO UPDATE SET sanctioned=EXCLUDED.sanctioned",
            )
            .run(companyId, fy, branch.id, d, n);
        else
          await db
            .prepare("DELETE FROM budget_posts WHERE company_id=? AND fy=? AND branch_id=? AND designation_id=?")
            .run(companyId, fy, branch.id, d);
    });
    await audit("budget_posts_set", { fy, branch: branch.id, total: rows.reduce((s, [, n]) => s + n, 0) });
    return send(200, { ok: true });
  });

  // ---- budget against actual -------------------------------------------------------------------
  async function report(user, companyId, fy, upto) {
    const months = fyMonths(fy);
    const end = upto ?? (fy === currentFy() ? thisMonth() : fy < currentFy() ? months[11] : null);
    const ytd = end ? months.filter((m) => m <= end) : [];
    const headList = (await heads(companyId)).filter((h) => h.active);
    const branches = await branchesFor(user, companyId);
    const allowed = new Set(branches.map((b) => b.id));
    const scoped = (user.branch_scope ?? []).length > 0;
    const blank = () => Object.fromEntries(headList.map((h) => [h.id, { budget_fy: 0, budget_ytd: 0, actual_ytd: 0 }]));
    const rows = new Map(
      branches.map((b) => [b.id, { ...b, heads: blank(), sanctioned: 0, filled: 0, open: 0 }]),
    );
    // People not assigned to a branch still cost money; they show on their own line.
    const none = { id: null, name: "Not assigned to a branch", zone: null, region: null, head_office: 0, heads: blank(), sanctioned: 0, filled: 0, open: 0 };
    const rowOf = (branchId) => (branchId == null ? (scoped ? null : none) : rows.get(branchId));
    const monthly = Object.fromEntries(months.map((m) => [m, { budget: 0, actual: 0 }]));
    const cell = (branchId, headId) => rowOf(branchId)?.heads[headId];

    for (const l of await db
      .prepare("SELECT branch_id,head_id,month,amount FROM budget_lines WHERE company_id=? AND fy=?")
      .all(companyId, fy)) {
      const c = cell(l.branch_id, l.head_id);
      if (!c) continue;
      c.budget_fy += l.amount;
      monthly[l.month].budget += l.amount;
      if (ytd.includes(l.month)) c.budget_ytd += l.amount;
    }
    const addActual = (branchId, headId, month, amount) => {
      const c = cell(branchId, headId);
      if (!c || !ytd.includes(month)) return;
      c.actual_ytd += amount;
      monthly[month].actual += amount;
    };
    const first = months[0];
    const payrollHead = headList.find((h) => h.source === "payroll");
    if (payrollHead && end) {
      // Months worked out by Salary by branch from the payroll run: each person's employer
      // cost shared across the branches they cover. Other months: the branch they are in.
      const shared = new Set(
        (
          await db
            .prepare("SELECT month FROM salary_allocation_runs WHERE company_id=? AND salary_source='payroll' AND month>=? AND month<=?")
            .all(companyId, first, end)
        ).map((r) => r.month),
      );
      for (const r of await db
        .prepare(
          `SELECT month,branch_id,SUM(amount) amount FROM salary_allocations WHERE company_id=? AND month>=? AND month<=? GROUP BY month,branch_id`,
        )
        .all(companyId, first, end))
        if (shared.has(r.month)) addActual(r.branch_id, payrollHead.id, r.month, Number(r.amount));
      for (const r of await db
        .prepare(
          `SELECT r.month,u.branch_id,SUM(i.employer_cost) amount FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id JOIN users u ON u.id=i.user_id
           WHERE r.company_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=?
             AND NOT EXISTS (SELECT 1 FROM salary_allocation_runs s JOIN salary_allocations a ON a.company_id=s.company_id AND a.month=s.month
                             WHERE s.company_id=r.company_id AND s.month=r.month AND s.salary_source='payroll' AND a.user_id=i.user_id)
           GROUP BY r.month,u.branch_id`,
        )
        .all(companyId, first, end))
        addActual(r.branch_id, payrollHead.id, r.month, Number(r.amount));
    }
    const claimsHead = headList.find((h) => h.source === "claims");
    if (claimsHead && end)
      for (const r of await db
        .prepare(
          `SELECT substr(c.expense_date,1,7) AS month,u.branch_id,SUM(COALESCE(c.approved_amount,c.amount)) amount FROM reimbursement_claims c JOIN users u ON u.id=c.user_id
           WHERE c.company_id=? AND c.status IN ('approved','paid') AND c.expense_date>=? AND c.expense_date<=? GROUP BY substr(c.expense_date,1,7),u.branch_id`,
        )
        .all(companyId, `${first}-01`, `${end}-31`))
        addActual(r.branch_id, claimsHead.id, r.month, Number(r.amount));
    if (end)
      for (const r of await db
        .prepare(
          `SELECT branch_id,head_id,substr(spent_on,1,7) AS month,SUM(amount) amount FROM budget_spend
           WHERE company_id=? AND spent_on>=? AND spent_on<=? GROUP BY branch_id,head_id,substr(spent_on,1,7)`,
        )
        .all(companyId, `${first}-01`, `${end}-31`))
        if (headList.find((h) => h.id === r.head_id && h.source === "manual"))
          addActual(r.branch_id, r.head_id, r.month, Number(r.amount));

    for (const r of await db
      .prepare("SELECT branch_id,SUM(sanctioned) n FROM budget_posts WHERE company_id=? AND fy=? GROUP BY branch_id")
      .all(companyId, fy))
      if (allowed.has(r.branch_id)) rows.get(r.branch_id).sanctioned = Number(r.n);
    for (const r of await db
      .prepare("SELECT branch_id,COUNT(*) n FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' GROUP BY branch_id")
      .all(companyId)) {
      const row = rowOf(r.branch_id);
      if (row) row.filled = Number(r.n);
    }
    for (const r of await db
      .prepare("SELECT branch_id,SUM(positions) n FROM job_openings WHERE company_id=? AND status='open' AND branch_id IS NOT NULL GROUP BY branch_id")
      .all(companyId))
      if (allowed.has(r.branch_id)) rows.get(r.branch_id).open = Number(r.n);

    const finish = (r) => {
      const t = { budget_fy: 0, budget_ytd: 0, actual_ytd: 0 };
      for (const c of Object.values(r.heads)) for (const k of Object.keys(t)) t[k] += c[k];
      for (const c of Object.values(r.heads)) {
        c.utilisation_pct = pct(c.actual_ytd, c.budget_ytd);
        c.flag = flagOf(c.actual_ytd, c.budget_ytd);
      }
      return {
        ...r,
        ...t,
        variance: t.actual_ytd - t.budget_ytd,
        utilisation_pct: pct(t.actual_ytd, t.budget_ytd),
        flag: flagOf(t.actual_ytd, t.budget_ytd),
        vacant: Math.max(r.sanctioned - r.filled, 0),
        excess: r.sanctioned ? Math.max(r.filled - r.sanctioned, 0) : 0,
      };
    };
    const list = [...rows.values()];
    if (Object.values(none.heads).some((c) => c.actual_ytd) || none.filled) list.push(none);
    const branchRows = list.map(finish);
    const sum = (items, label, extra = {}) => {
      const heads = blank();
      const g = { name: label, ...extra, branches: items.length, heads, sanctioned: 0, filled: 0, open: 0 };
      for (const r of items) {
        for (const h of headList) for (const k of ["budget_fy", "budget_ytd", "actual_ytd"]) heads[h.id][k] += r.heads[h.id][k];
        for (const k of ["sanctioned", "filled", "open"]) g[k] += r[k];
      }
      return finish(g);
    };
    const groupBy = (key) => {
      const m = new Map();
      for (const r of branchRows) {
        const name = r.head_office ? "Head office" : r.id == null ? r.name : r[key] || `No ${key}`;
        if (!m.has(name)) m.set(name, []);
        m.get(name).push(r);
      }
      return [...m.entries()].map(([name, items]) => sum(items, name, key === "region" ? { zone: items[0].zone } : {}));
    };
    return {
      fy,
      label: fyLabel(fy),
      upto: end,
      months,
      heads: headList,
      status: (await yearRow(companyId, fy)).status,
      total: sum(branchRows, "All branches"),
      zones: groupBy("zone"),
      regions: groupBy("region"),
      branches: branchRows,
      monthly: months.map((m) => ({ month: m, ...monthly[m], closed: ytd.includes(m) })),
    };
  }

  router.get("/api/admin/budgets/report", { perm: "budget.read" }, async ({ user, companyId, query, res, headers, send }) => {
    const fy = fyOf(query.get("fy"));
    const upto = query.get("upto") || null;
    if (upto && (!monthRe.test(upto) || !fyMonths(fy).includes(upto)))
      throw new HttpError(400, "Choose a month inside the financial year.");
    const r = await report(user, companyId, fy, upto);
    if (query.get("format") !== "csv") return send(200, r);
    const group = oneOf(query.get("group") ?? "branches", "Group", ["branches", "regions", "zones"]);
    const cell = (v) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : csvCell(v ?? ""));
    const lines = [
      [
        group === "branches" ? "Branch" : group === "regions" ? "Region" : "Zone",
        ...(group === "branches" ? ["Code", "Zone", "Region"] : ["Branches"]),
        "Budget for the year",
        `Budget to ${r.upto ?? "date"}`,
        "Actual",
        "Variance",
        "Used %",
        ...r.heads.flatMap((h) => [`${h.code} budget to date`, `${h.code} actual`]),
        "Sanctioned posts",
        "People",
        "Open positions",
        "Vacant posts",
      ]
        .map(csvCell)
        .join(","),
    ];
    for (const g of r[group])
      lines.push(
        [
          g.head_office ? `${g.name} (head office)` : g.name,
          ...(group === "branches" ? [g.code, g.zone, g.region] : [g.branches]),
          g.budget_fy,
          g.budget_ytd,
          g.actual_ytd,
          g.variance,
          g.utilisation_pct ?? "",
          ...r.heads.flatMap((h) => [g.heads[h.id].budget_ytd, g.heads[h.id].actual_ytd]),
          g.sanctioned,
          g.filled,
          g.open,
          g.vacant,
        ]
          .map(cell)
          .join(","),
      );
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="budget-${fyLabel(fy)}-${group}.csv"`,
    });
    return res.end("﻿" + lines.join("\r\n"));
  });

  // ---- spending entered by hand ---------------------------------------------------------------
  router.get("/api/admin/budgets/spend", { perm: "budget.read" }, async ({ user, companyId, query, send }) => {
    const fy = fyOf(query.get("fy"));
    const months = fyMonths(fy);
    const branchId = query.get("branch_id") ? integer(Number(query.get("branch_id"))) : null;
    const rows = await db
      .prepare(
        `SELECT s.*,b.name branch_name,h.name head_name,u.name created_by_name FROM budget_spend s
         JOIN branches b ON b.id=s.branch_id JOIN budget_heads h ON h.id=s.head_id LEFT JOIN users u ON u.id=s.created_by
         WHERE s.company_id=? AND s.spent_on>=? AND s.spent_on<=? ${branchId ? "AND s.branch_id=?" : ""} ORDER BY s.spent_on DESC,s.id DESC LIMIT 500`,
      )
      .all(companyId, `${months[0]}-01`, `${months[11]}-31`, ...(branchId ? [branchId] : []));
    return send(200, rows.filter((r) => inBranchScope(user, r.branch_id)));
  });
  router.post("/api/admin/budgets/spend", { perm: "budget.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const branch = await branchOf(user, companyId, b.branch_id);
    const head = await headOf(companyId, b.head_id);
    if (head.source !== "manual")
      throw new HttpError(400, `${head.name} comes from ${head.source === "payroll" ? "payroll" : "approved claims"}; it is not entered by hand.`);
    const date = isoDate(b.spent_on, "Date");
    if (!date) throw new HttpError(400, "Date is required.");
    if (date > app.dayOf(nowIso())) throw new HttpError(400, "The date cannot be in the future.");
    const amount = rupees(b.amount, "Amount");
    if (!amount) throw new HttpError(400, "Enter the amount spent.");
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO budget_spend(company_id,branch_id,head_id,spent_on,amount,description,reference,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(companyId, branch.id, head.id, date, amount, string(b.description, "Description", 300), optionalString(b.reference, "Reference", 60), user.id, nowIso())
      ).lastInsertRowid,
    );
    await audit("budget_spend_added", { id, branch: branch.id, head: head.code, amount });
    return send(201, { id });
  });
  router.delete("/api/admin/budgets/spend/:id", { perm: "budget.manage" }, async ({ user, companyId, params, send, audit }) => {
    const s = await requireOwned(db, "budget_spend", integer(Number(params.id)), companyId, "spending entry");
    if (!inBranchScope(user, s.branch_id)) throw new HttpError(403, "This branch is outside your role.");
    await db.prepare("DELETE FROM budget_spend WHERE id=?").run(s.id);
    await audit("budget_spend_removed", { id: s.id, branch: s.branch_id, amount: s.amount, description: s.description });
    return send(200, { ok: true });
  });

  // ---- setup: heads and the head office --------------------------------------------------------
  const headFields = async (companyId, b, row) => {
    const source = b.source === undefined && row ? row.source : oneOf(b.source, "Comes from", ["payroll", "claims", "manual"]);
    if (source !== "manual") {
      const other = (await heads(companyId)).find((h) => h.source === source && h.id !== row?.id && h.active);
      if (other) throw new HttpError(400, `${other.name} already takes its spending from ${source === "payroll" ? "payroll" : "claims"}.`);
    }
    return {
      name: b.name === undefined && row ? row.name : string(b.name, "Name", 80),
      code: b.code === undefined && row ? row.code : string(b.code, "Code", 12).toUpperCase(),
      source,
    };
  };
  router.post("/api/admin/budgets/heads", { perm: "budget.manage" }, async ({ companyId, body, send, audit }) => {
    const f = await headFields(companyId, await body());
    const next = Number((await db.prepare("SELECT COALESCE(MAX(sort_order),0)+1 n FROM budget_heads WHERE company_id=?").get(companyId)).n);
    if (await db.prepare("SELECT id FROM budget_heads WHERE company_id=? AND lower(code)=lower(?)").get(companyId, f.code))
      throw new HttpError(409, "Another budget head has this code.");
    const id = Number(
      (
        await db
          .prepare("INSERT INTO budget_heads(company_id,name,code,source,sort_order,created_at) VALUES(?,?,?,?,?,?)")
          .run(companyId, f.name, f.code, f.source, next, nowIso())
      ).lastInsertRowid,
    );
    await audit("budget_head_created", { id, code: f.code });
    return send(201, { id });
  });
  router.patch("/api/admin/budgets/heads/:id", { perm: "budget.manage" }, async ({ companyId, params, body, send, audit }) => {
    const row = await headOf(companyId, params.id);
    const b = await body();
    const active = b.active === undefined ? row.active : b.active ? 1 : 0;
    const f = await headFields(companyId, active ? b : { ...b, source: "manual" }, row);
    if (!active) f.source = row.source;
    if (await db.prepare("SELECT id FROM budget_heads WHERE company_id=? AND lower(code)=lower(?) AND id<>?").get(companyId, f.code, row.id))
      throw new HttpError(409, "Another budget head has this code.");
    await db
      .prepare("UPDATE budget_heads SET name=?,code=?,source=?,active=? WHERE id=?")
      .run(f.name, f.code, f.source, active, row.id);
    await audit("budget_head_updated", { id: row.id, code: f.code, active });
    return send(200, { ok: true });
  });
  router.put("/api/admin/budgets/head-office", { perm: "org.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const branch = await requireOwned(db, "branches", integer(Number(b.branch_id)), companyId, "branch");
    await transaction(async () => {
      await db.prepare("UPDATE branches SET head_office=0 WHERE company_id=?").run(companyId);
      await db.prepare("UPDATE branches SET head_office=1 WHERE id=?").run(branch.id);
    });
    await audit("head_office_set", { branch: branch.id });
    return send(200, { ok: true });
  });
  // Zones and regions for many branches at once: rows of { branch (code or name), zone, region }.
  router.post("/api/admin/budgets/branch-groups", { perm: "org.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body(2_000_000);
    if (!Array.isArray(b.rows) || !b.rows.length) throw new HttpError(400, "The file has no rows.");
    const branches = await db.prepare("SELECT id,name,code FROM branches WHERE company_id=?").all(companyId);
    const report = [];
    const work = [];
    for (const [i, row] of b.rows.entries()) {
      const key = String(row.branch ?? row.branch_code ?? "").trim().toLowerCase();
      const br = key && branches.find((x) => (x.code && x.code.toLowerCase() === key) || x.name.toLowerCase() === key);
      if (!br) {
        report.push({ line: i + 2, branch: row.branch, status: "failed", reason: "Branch not found (use its code or name)" });
        continue;
      }
      try {
        work.push([optionalString(row.zone, "Zone", 80), optionalString(row.region, "Region", 80), br.id]);
        report.push({ line: i + 2, branch: br.name, zone: row.zone, region: row.region, status: "ok" });
      } catch (e) {
        report.push({ line: i + 2, branch: br.name, status: "failed", reason: e.message });
      }
    }
    const failed = report.filter((r) => r.status === "failed").length;
    if (b.dry_run || failed) return send(200, { report, ok: work.length, failed, saved: false });
    await transaction(async () => {
      for (const [zone, region, id] of work)
        await db.prepare("UPDATE branches SET zone=?,region=? WHERE id=?").run(zone, region, id);
    });
    await audit("branch_groups_imported", { rows: work.length });
    return send(200, { report, ok: work.length, failed: 0, saved: true });
  });
}
