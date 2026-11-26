import { HttpError } from "./http.js";

// Hands everyone who reports to one person over to another: their active direct reports, and any
// department they head. Used when a manager leaves, is switched off, or HR moves a team by hand.
// If the new manager was in the team, they move up to the old manager's own manager instead of
// reporting to themselves.
export async function moveTeam(db, companyId, fromId, toId) {
  const from = await db
    .prepare("SELECT id,manager_id FROM users WHERE id=? AND company_id=?")
    .get(fromId, companyId);
  if (!from) throw new HttpError(404, "Employee not found.");
  if (toId === fromId) throw new HttpError(400, "Choose someone else to take over the team.");
  if (toId) {
    const to = await db
      .prepare("SELECT id,active,manager_id FROM users WHERE id=? AND company_id=?")
      .get(toId, companyId);
    if (!to || !to.active) throw new HttpError(400, "The new manager must be an active employee.");
    if (to.manager_id === fromId)
      await db.prepare("UPDATE users SET manager_id=? WHERE id=?").run(from.manager_id === toId ? null : from.manager_id, toId);
  }
  const moved = await db
    .prepare("UPDATE users SET manager_id=? WHERE manager_id=? AND company_id=? AND active=1 AND id<>? RETURNING id")
    .all(toId ?? null, fromId, companyId, toId ?? 0);
  const heads = toId
    ? await db
        .prepare("UPDATE departments SET head_id=? WHERE head_id=? AND company_id=? RETURNING name")
        .all(toId, fromId, companyId)
    : [];
  return { people: moved.length, departments: heads.map((d) => d.name) };
}

/** Finds an active employee by code (or numeric id) in the company; null for an empty value. */
export async function personByCode(db, companyId, code) {
  const v = String(code ?? "").trim();
  if (!v) return null;
  const p = await db
    .prepare(
      "SELECT id,name,employee_code FROM users WHERE company_id=? AND active=1 AND (LOWER(employee_code)=LOWER(?) OR CAST(id AS TEXT)=?) ORDER BY (LOWER(employee_code)=LOWER(?)) DESC LIMIT 1",
    )
    .get(companyId, v, v, v);
  if (!p) throw new HttpError(400, `No active employee with code ${v}.`);
  return p;
}
