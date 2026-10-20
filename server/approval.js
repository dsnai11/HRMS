import { can } from "./rbac.js";
import { TEAM_SQL } from "./attendance-report.js";

// Who may decide a person's request: HR/admin, or anyone above them in the
// reporting line. Nobody decides their own.
export async function mayDecide(app, approver, requesterId) {
  if (approver.id === requesterId) return false;
  if (can(approver, "leave.approve")) return true;
  return Boolean(
    await app.db
      .prepare(`SELECT id FROM (${TEAM_SQL}) team WHERE id=?`)
      .get(approver.id, requesterId),
  );
}

// "AND r.user_id IN (…)" scoping for an approver's inbox: HR sees the company,
// managers see their team, everyone else sees nothing.
export async function inboxScope(app, user) {
  if (can(user, "leave.approve")) return { sql: "", params: [] };
  if (
    await app.db
      .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
      .get(user.id)
  )
    return { sql: ` AND r.user_id IN (${TEAM_SQL})`, params: [user.id] };
  return null;
}

export async function pendingApprovals(app, user) {
  // Interviews to give feedback on and joining tasks for this person.
  let n = (
    await app.db
      .prepare(
        "SELECT COUNT(*) n FROM interviews WHERE interviewer_id=? AND status='scheduled'",
      )
      .get(user.id)
  ).n;
  n += (
    await app.db
      .prepare(
        `SELECT COUNT(*) n FROM onboarding_tasks t JOIN users u ON u.id=t.user_id
         WHERE t.company_id=? AND t.done=0 AND ((t.owner='manager' AND u.manager_id=?)
           OR (t.owner IN ('it','finance','admin') AND EXISTS (SELECT 1 FROM onboarding_owner_members m WHERE m.company_id=t.company_id AND m.owner=t.owner AND m.user_id=?))
           ${can(user, "recruitment.manage") ? "OR t.owner IN ('hr','it','finance','admin')" : ""})`,
      )
      .get(user.company_id, user.id, user.id)
  ).n;
  const scope = await inboxScope(app, user);
  if (!scope) return n;
  for (const table of ["leave_requests", "regularizations"])
    n += (
      await app.db
        .prepare(
          `SELECT COUNT(*) n FROM ${table} r WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql}`,
        )
        .get(user.company_id, user.id, ...scope.params)
    ).n;
  n += (
    await app.db
      .prepare(
        `SELECT COUNT(*) n FROM reimbursement_claims r WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql}`,
      )
      .get(user.company_id, user.id, ...scope.params)
  ).n;
  return n;
}
