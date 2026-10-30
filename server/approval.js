import { can } from "./rbac.js";
import { TEAM_SQL } from "./attendance-report.js";
import { branchScope } from "./scope.js";
import { delegatorsOf } from "./delegation.js";

const inTeamOf = async (app, managerId, personId) =>
  Boolean(
    await app.db
      .prepare(`SELECT id FROM (${TEAM_SQL}) team WHERE id=?`)
      .get(managerId, personId),
  );

// Who may decide a person's request: HR/admin, anyone above them in the reporting line,
// or someone standing in today for such a manager (delegation). Nobody decides their own.
export async function mayDecide(app, approver, requesterId) {
  if (approver.id === requesterId) return false;
  if (can(approver, "leave.approve")) {
    if (!approver.branch_scope?.length) return true;
    // A branch-limited HR role decides only for its branches (or its own team).
    const r = await app.db
      .prepare("SELECT branch_id FROM users WHERE id=?")
      .get(requesterId);
    if (r && approver.branch_scope.includes(r.branch_id)) return true;
  }
  if (await inTeamOf(app, approver.id, requesterId)) return true;
  for (const away of await delegatorsOf(app.db, approver.id))
    if (away !== requesterId && (await inTeamOf(app, away, requesterId))) return true;
  return false;
}

// "AND r.user_id IN (…)" scoping for an approver's inbox: HR sees the company,
// managers see their team (and the teams of managers they stand in for today),
// everyone else sees nothing.
export async function inboxScope(app, user) {
  if (can(user, "leave.approve")) return branchScope(user, "r.user_id");
  const owners = [];
  if (
    await app.db
      .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
      .get(user.id)
  )
    owners.push(user.id);
  owners.push(...(await delegatorsOf(app.db, user.id)));
  if (!owners.length) return null;
  return {
    sql: ` AND (${owners.map(() => `r.user_id IN (${TEAM_SQL})`).join(" OR ")})`,
    params: owners,
  };
}

// OD trips and overtime claims waiting for this approver (their team, or their branches for HR).
async function pendingTrips(app, user) {
  const scope = await inboxScope(app, user);
  if (!scope) return 0;
  let n = 0;
  for (const table of ["od_visits", "overtime_requests"]) {
    const rows = await app.db
      .prepare(`SELECT r.user_id FROM ${table} r WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql} LIMIT 300`)
      .all(user.company_id, user.id, ...scope.params);
    for (const r of rows) if (await mayDecide(app, user, r.user_id)) n++;
  }
  return n;
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
  n = Number(n) + (await pendingTrips(app, user));
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
  // Bank detail changes wait for HR or payroll (never the person who asked).
  if (can(user, "payroll.manage") || can(user, "employees.write"))
    n += (
      await app.db
        .prepare(
          "SELECT COUNT(*) n FROM bank_change_requests WHERE company_id=? AND status='pending' AND user_id<>?",
        )
        .get(user.company_id, user.id)
    ).n;
  const scope = await inboxScope(app, user);
  if (!scope) return n;
  for (const table of ["leave_requests", "regularizations", "comp_off_credits"])
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
