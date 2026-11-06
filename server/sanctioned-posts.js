// Job openings against the branch's sanctioned posts (Branch budgets → Manpower plan).
// An opening that would take a branch and designation above its sanctioned posts for the
// current financial year is not refused: HR is warned and goes ahead only with a reason,
// which is kept on the opening and in the activity log. Branches with no manpower plan for
// the year are not checked.
import { HttpError, optionalString } from "./http.js";
import { taxYearOf } from "./payroll/tax.js";

export async function postsCheck(app, companyId, { branchId, designationId, positions, openingId = null }) {
  if (!branchId || !designationId || !positions) return null;
  const { db } = app;
  const fy = taxYearOf(app.dayOf(new Date(app.clock()).toISOString()).slice(0, 7));
  const planned = await db.prepare("SELECT 1 FROM budget_posts WHERE company_id=? AND fy=? AND branch_id=? LIMIT 1").get(companyId, fy, branchId);
  if (!planned) return null;
  const [post, filled, open, names] = await Promise.all([
    db.prepare("SELECT sanctioned FROM budget_posts WHERE company_id=? AND fy=? AND branch_id=? AND designation_id=?").get(companyId, fy, branchId, designationId),
    db
      .prepare("SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1 AND branch_id=? AND designation_id=? AND role<>'super_admin'")
      .get(companyId, branchId, designationId),
    // Other openings still hiring for the same posts: positions not yet filled by a hire.
    db
      .prepare(
        `SELECT COALESCE(SUM(GREATEST(o.positions - (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id AND c.stage='hired'), 0)),0) n
         FROM job_openings o WHERE o.company_id=? AND o.branch_id=? AND o.designation_id=? AND o.status IN ('open','on_hold')
           AND COALESCE(o.approval_status,'approved') IN ('approved','pending_approval') AND o.id<>?`,
      )
      .get(companyId, branchId, designationId, openingId ?? 0),
    db
      .prepare("SELECT b.name branch, d.name designation FROM branches b, designations d WHERE b.id=? AND d.id=?")
      .get(branchId, designationId),
  ]);
  const sanctioned = Number(post?.sanctioned ?? 0);
  const result = {
    fy,
    branch: names?.branch,
    designation: names?.designation,
    sanctioned,
    filled: Number(filled.n),
    open: Number(open.n),
    requested: positions,
  };
  result.over = Math.max(0, result.filled + result.open + positions - sanctioned);
  return result;
}

// Throws the warning unless HR gave a reason; answers the reason (or null) to store.
export async function requireReasonIfOver(app, companyId, fields, reasonInput, audit, openingId = null) {
  const check = await postsCheck(app, companyId, { ...fields, openingId });
  if (!check?.over) return null;
  const reason = optionalString(reasonInput, "Reason for going above sanctioned posts", 300);
  if (!reason)
    throw new HttpError(
      409,
      `${check.branch}, ${check.designation}: ${check.sanctioned} sanctioned for ${check.fy}-${String(check.fy + 1).slice(2)}, ${check.filled} in post and ${check.open} already open. This opening for ${check.requested} would go ${check.over} over. Give a reason to go ahead.`,
      "over_sanctioned",
    );
  await audit("opening_over_sanctioned", { openingId, ...check, reason });
  return reason;
}
