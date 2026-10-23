import { HttpError, email, integer, isoDate, number, oneOf, optionalString } from "../http.js";
import { inBranchScope } from "../scope.js";

// Extra profile sections, as the earlier HR portal kept them: personal details,
// medical information, nominees and insurance. Employees keep the first three up to
// date; insurance policies are recorded by HR.
const BLOOD = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"];
const MARITAL = ["single", "married", "divorced", "widowed"];
const COVER = ["health", "life", "accident", "other"];
const text = (v, label, max) => optionalString(v, label, max);

function personal(b = {}) {
  return {
    father_name: text(b.father_name, "Father's name", 100),
    blood_group: b.blood_group ? oneOf(b.blood_group, "Blood group", BLOOD) : null,
    marital_status: b.marital_status ? oneOf(b.marital_status, "Marital status", MARITAL) : null,
    children: b.children === undefined || b.children === null || b.children === "" ? null : number(b.children, "Number of children", 0, 20),
    nationality: text(b.nationality, "Nationality", 50),
    personal_email: b.personal_email ? email(b.personal_email) : null,
  };
}
function medical(b = {}) {
  return {
    allergies: text(b.allergies, "Allergies", 300),
    conditions: text(b.conditions, "Medical conditions", 300),
    doctor: text(b.doctor, "Family doctor", 150),
  };
}
function nominees(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 5) throw new HttpError(400, "Add up to five nominees.");
  const out = list.map((n) => ({
    name: text(n?.name, "Nominee name", 100) ?? (() => { throw new HttpError(400, "Each nominee needs a name."); })(),
    relation: text(n?.relation, "Relation", 50),
    date_of_birth: isoDate(n?.date_of_birth, "Nominee date of birth"),
    share: number(n?.share ?? 100, "Share", 0, 100),
  }));
  const total = out.reduce((s, n) => s + n.share, 0);
  if (out.length && Math.abs(total - 100) > 0.01)
    throw new HttpError(400, `Nominee shares must add up to 100% (now ${total}%).`);
  return out;
}
function insurance(list) {
  if (!Array.isArray(list)) return [];
  if (list.length > 5) throw new HttpError(400, "Add up to five policies.");
  return list.map((p) => ({
    type: oneOf(p?.type ?? "health", "Cover type", COVER),
    provider: text(p?.provider, "Insurer", 100),
    policy_no: text(p?.policy_no, "Policy number", 50),
    sum_insured: p?.sum_insured ? number(p.sum_insured, "Sum insured", 0, 1e10) : null,
    valid_till: isoDate(p?.valid_till, "Valid till"),
    covers: text(p?.covers, "Who is covered", 200),
  }));
}

export function registerEmployeeDetails(router, app) {
  const { db } = app;
  const nowIso = () => new Date(app.clock()).toISOString();
  const load = async (userId) => {
    const r = await db.prepare("SELECT * FROM employee_details WHERE user_id=?").get(userId);
    return {
      personal: JSON.parse(r?.personal || "{}"),
      medical: JSON.parse(r?.medical || "{}"),
      nominees: JSON.parse(r?.nominees || "[]"),
      insurance: JSON.parse(r?.insurance || "[]"),
      updated_at: r?.updated_at ?? null,
      options: { blood_groups: BLOOD, marital: MARITAL, cover: COVER },
    };
  };
  const save = async (userId, by, sections) => {
    const current = await load(userId);
    const next = { ...current, ...sections };
    await db
      .prepare(
        `INSERT INTO employee_details(user_id,personal,medical,nominees,insurance,updated_by,updated_at) VALUES(?,?,?,?,?,?,?)
         ON CONFLICT (user_id) DO UPDATE SET personal=excluded.personal,medical=excluded.medical,nominees=excluded.nominees,
         insurance=excluded.insurance,updated_by=excluded.updated_by,updated_at=excluded.updated_at`,
      )
      .run(
        userId,
        JSON.stringify(next.personal),
        JSON.stringify(next.medical),
        JSON.stringify(next.nominees),
        JSON.stringify(next.insurance),
        by,
        nowIso(),
      );
  };
  // Only the sections sent are changed.
  const sections = (b, withInsurance) => ({
    ...(b.personal !== undefined ? { personal: personal(b.personal) } : {}),
    ...(b.medical !== undefined ? { medical: medical(b.medical) } : {}),
    ...(b.nominees !== undefined ? { nominees: nominees(b.nominees) } : {}),
    ...(withInsurance && b.insurance !== undefined ? { insurance: insurance(b.insurance) } : {}),
  });

  router.get("/api/profile/details", async ({ user, send }) => send(200, await load(user.id)));
  router.put("/api/profile/details", async ({ user, body, send, audit }) => {
    const b = await body(32768);
    if (b.insurance !== undefined)
      throw new HttpError(403, "Insurance policies are recorded by HR.");
    const s = sections(b, false);
    await save(user.id, user.id, s);
    await audit("profile_details_updated", { sections: Object.keys(s) });
    return send(200, await load(user.id));
  });

  const target = async (user, id, companyId) => {
    const u = await db
      .prepare("SELECT id,branch_id FROM users WHERE id=? AND company_id=? AND role<>'super_admin'")
      .get(integer(Number(id)), companyId);
    if (!u || !inBranchScope(user, u.branch_id)) throw new HttpError(404, "Employee not found.");
    return u;
  };
  router.get(
    "/api/admin/employees/:id/details",
    { perm: "employees.read" },
    async ({ user, params, companyId, send }) =>
      send(200, await load((await target(user, params.id, companyId)).id)),
  );
  router.put(
    "/api/admin/employees/:id/details",
    { perm: "employees.write" },
    async ({ user, params, companyId, body, send, audit }) => {
      const u = await target(user, params.id, companyId);
      const s = sections(await body(32768), true);
      await save(u.id, user.id, s);
      await audit("employee_details_updated", { id: u.id, sections: Object.keys(s) });
      return send(200, await load(u.id));
    },
  );
}
