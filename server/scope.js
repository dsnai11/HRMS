import { HttpError } from "./http.js";
import { permissionsFor } from "./rbac.js";

// Confirms a referenced row exists and belongs to the caller's company, so ids
// from another company can never be attached to this one.
export async function requireOwned(db, table, id, companyId, label) {
  if (id === null || id === undefined) return null;
  const row = await db
    .prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`)
    .get(id, companyId);
  if (!row) throw new HttpError(400, `Select an existing ${label}.`);
  return row;
}

// A custom role can be limited to some branches. HR lists then show only people in
// those branches: append `sql` to a WHERE clause and `params` to its values.
export function branchScope(user, userIdColumn = "u.id") {
  const ids = user.branch_scope;
  if (!ids?.length) return { sql: "", params: [] };
  return {
    sql: ` AND ${userIdColumn} IN (SELECT id FROM users WHERE branch_id IN (${ids.map(() => "?").join(",")}))`,
    params: [...ids],
  };
}
export const inBranchScope = (user, branchId) =>
  !user.branch_scope?.length || user.branch_scope.includes(branchId);

// Active people in a company holding any of these rights, through a built-in role or a
// custom one; used to choose who hears about HR events. Rows are { id }.
export async function staffWith(db, companyId, perms, exceptId = 0) {
  const rows = await db
    .prepare(
      `SELECT u.id,u.role,r.permissions FROM users u LEFT JOIN custom_roles r ON r.id=u.custom_role_id
       WHERE u.company_id=? AND u.active=1 AND u.id<>? AND u.role IN ('admin','hr','payroll','custom')`,
    )
    .all(companyId, exceptId);
  return rows
    .filter((u) => {
      const has =
        u.role === "custom" ? JSON.parse(u.permissions || "[]") : permissionsFor(u.role);
      return perms.some((p) => has.includes(p));
    })
    .map((u) => ({ id: u.id }));
}
