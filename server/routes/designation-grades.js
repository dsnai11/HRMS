// Which grades each designation may have. HR sets them one designation at a time
// (Organization → Designations → Grades) or loads the company's designation and grade
// sheet (Import from sheet). An employee given a grade outside their designation's is
// still saved; the save answers with a warning.
import { HttpError, integer } from "../http.js";
import { requireOwned } from "../scope.js";

const now = () => new Date().toISOString();
const natural = (a, b) => a.localeCompare(b, "en", { numeric: true, sensitivity: "base" });
// Short forms kept in capitals when a sheet's ALL-CAPS names are turned into Title Case.
const KEEP_CAPS = new Set(["IT", "RO", "TL", "ABM", "HR", "HO", "MIS", "CEO", "CFO", "COO", "CTO", "CISO", "AVP", "VP", "SVP", "DVP", "EVP"]);
const SMALL = new Set(["and", "of", "the", "for", "in"]);

export function designationName(raw) {
  const s = String(raw ?? "").replace(/\s+/g, " ").trim();
  // Names typed in mixed case are kept exactly as typed.
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .replace(/[a-z]+/g, (w, at) =>
      KEEP_CAPS.has(w.toUpperCase())
        ? w.toUpperCase()
        : SMALL.has(w) && at > 0
          ? w
          : w[0].toUpperCase() + w.slice(1),
    );
}

// Reads the sheet's rows ({ line, designation, grades }). A designation cell may name
// several designations split by "/"; a grade cell lists grades split by commas.
export function planSheet(rows) {
  const problems = [];
  const byKey = new Map();
  const grades = new Set();
  for (const r of rows) {
    const line = r.line;
    const names = String(r.designation ?? "").split("/").map(designationName).filter(Boolean);
    const list = [
      ...new Set(
        String(r.grades ?? "")
          .toUpperCase()
          .split(/[\s,;/]+/)
          .filter(Boolean),
      ),
    ].sort(natural);
    if (!names.length && !list.length) continue;
    if (!names.length) {
      problems.push({ line, reason: "There is a grade but no designation." });
      continue;
    }
    if (!list.length) {
      problems.push({ line, reason: `No grade for ${names.join(", ")}.` });
      continue;
    }
    const bad = list.find((g) => !/^[A-Z0-9][A-Z0-9-]{0,19}$/.test(g));
    if (bad) {
      problems.push({ line, reason: `"${bad}" is not a grade. Write grades like M1, O2, S3.` });
      continue;
    }
    for (const name of names) {
      const key = name.toLowerCase();
      if (name.length > 150) problems.push({ line, reason: `${name.slice(0, 40)}… is too long for a designation.` });
      else if (byKey.has(key))
        problems.push({
          line,
          reason: `${name} is also on line ${byKey.get(key).line}. Put each designation on one line only, or name them apart (for example Zonal Head / Zonal Manager).`,
        });
      else byKey.set(key, { line, name, grades: list });
    }
    for (const g of list) grades.add(g);
  }
  return { designations: [...byKey.values()], grades: [...grades].sort(natural), problems };
}

// The warning for an employee whose grade is not among their designation's grades.
export async function gradeWarning(db, designationId, gradeId) {
  if (!designationId || !gradeId) return null;
  const allowed = await db
    .prepare("SELECT g.id,g.name FROM designation_grades dg JOIN grades g ON g.id=dg.grade_id WHERE dg.designation_id=?")
    .all(designationId);
  if (!allowed.length || allowed.some((g) => g.id === gradeId)) return null;
  const [designation, grade] = await Promise.all([
    db.prepare("SELECT name FROM designations WHERE id=?").get(designationId),
    db.prepare("SELECT name FROM grades WHERE id=?").get(gradeId),
  ]);
  const names = allowed.map((g) => g.name).sort(natural).join(", ");
  return `Saved, but grade ${grade.name} is not one of the grades for ${designation.name} (${names}).`;
}

export function registerDesignationGrades(router, app) {
  const { db, transaction } = app;

  const setGrades = async (companyId, designationId, gradeIds) => {
    await db.prepare("DELETE FROM designation_grades WHERE designation_id=?").run(designationId);
    for (const gradeId of gradeIds)
      await db
        .prepare("INSERT INTO designation_grades(company_id,designation_id,grade_id) VALUES(?,?,?)")
        .run(companyId, designationId, gradeId);
  };

  // The import, checked first (apply: false shows what would change) and then applied.
  router.post(
    "/api/admin/designations/import",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body(300000);
      if (!Array.isArray(b.rows) || !b.rows.length || b.rows.length > 2000)
        throw new HttpError(400, "The sheet has no rows to import.");
      const plan = planSheet(
        b.rows.map((r, i) => ({ line: Number(r?.line) || i + 2, designation: r?.designation, grades: r?.grades })),
      );
      if (!plan.designations.length && !plan.problems.length)
        throw new HttpError(400, "No designations found. The sheet needs a Designation column and a Grade column.");
      const [existingGrades, existingDesignations, links] = await Promise.all([
        db.prepare("SELECT id,name FROM grades WHERE company_id=?").all(companyId),
        db
          .prepare(
            "SELECT d.id,d.name,d.active,(SELECT COUNT(*) FROM users u WHERE u.designation_id=d.id AND u.active=1) employees FROM designations d WHERE d.company_id=?",
          )
          .all(companyId),
        db
          .prepare("SELECT dg.designation_id,g.name FROM designation_grades dg JOIN grades g ON g.id=dg.grade_id WHERE dg.company_id=?")
          .all(companyId),
      ]);
      const gradeByKey = new Map(existingGrades.map((g) => [g.name.toUpperCase(), g]));
      const designationByKey = new Map(existingDesignations.map((d) => [d.name.toLowerCase(), d]));
      const current = new Map();
      for (const l of links) current.set(l.designation_id, [...(current.get(l.designation_id) ?? []), l.name.toUpperCase()]);
      const grades = plan.grades.map((name) => ({ name, status: gradeByKey.has(name) ? "existing" : "new" }));
      const designations = plan.designations.map((d) => {
        const found = designationByKey.get(d.name.toLowerCase());
        if (!found) return { ...d, status: "new" };
        const before = (current.get(found.id) ?? []).sort(natural);
        const changes = [];
        if (found.name !== d.name) changes.push(`renamed from ${found.name}`);
        if (!found.active) changes.push("switched back on");
        if (before.join() !== d.grades.join()) changes.push(before.length ? `grades were ${before.join(", ")}` : "grades added");
        return { ...d, id: found.id, employees: Number(found.employees), status: changes.length ? "updated" : "unchanged", note: changes.join("; ") };
      });
      const inSheet = new Set(plan.designations.map((d) => d.name.toLowerCase()));
      const notInSheet = existingDesignations
        .filter((d) => d.active && !inSheet.has(d.name.toLowerCase()))
        .map((d) => ({ name: d.name, employees: Number(d.employees) }))
        .sort((a, b) => natural(a.name, b.name));
      const report = { grades, designations, notInSheet, problems: plan.problems };
      if (b.apply !== true) return send(200, { ...report, applied: false });
      if (plan.problems.length)
        throw new HttpError(422, "Fix the lines marked in the sheet, then import again.");
      await transaction(async () => {
        const at = now();
        for (const g of grades)
          if (g.status === "new") {
            const id = Number(
              (await db.prepare("INSERT INTO grades(company_id,name,created_at) VALUES(?,?,?)").run(companyId, g.name, at))
                .lastInsertRowid,
            );
            gradeByKey.set(g.name, { id, name: g.name });
          }
        for (const d of designations) {
          if (d.status === "unchanged") continue;
          let id = d.id;
          if (d.status === "new")
            id = Number(
              (await db.prepare("INSERT INTO designations(company_id,name,created_at) VALUES(?,?,?)").run(companyId, d.name, at))
                .lastInsertRowid,
            );
          else await db.prepare("UPDATE designations SET name=?,active=1 WHERE id=?").run(d.name, id);
          await setGrades(companyId, id, d.grades.map((g) => gradeByKey.get(g).id));
        }
        await audit("designation_grades_imported", {
          grades: grades.filter((g) => g.status === "new").length,
          designationsNew: designations.filter((d) => d.status === "new").length,
          designationsUpdated: designations.filter((d) => d.status === "updated").length,
        });
      });
      return send(200, { ...report, applied: true });
    },
  );

  // One designation's grades, set by hand.
  router.put(
    "/api/admin/designations/:id/grades",
    { perm: "org.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const designation = await requireOwned(db, "designations", integer(Number(params.id)), companyId, "designation");
      const b = await body();
      if (!Array.isArray(b.grade_ids) || b.grade_ids.length > 200)
        throw new HttpError(400, "Choose the grades for this designation.");
      const ids = [...new Set(b.grade_ids.map((id) => integer(Number(id))))];
      for (const id of ids) await requireOwned(db, "grades", id, companyId, "grade");
      await transaction(async () => {
        await setGrades(companyId, designation.id, ids);
        await audit("designation_grades_set", { id: designation.id, grades: ids });
      });
      return send(200, { ok: true });
    },
  );
}
