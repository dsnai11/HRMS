import { HttpError } from "./http.js";

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
