import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { designationName, planSheet } from "../server/routes/designation-grades.js";

// Laxmi's designation and grade sheet (Book3.xlsx, 5 Nov 2026), as rows with sheet line numbers.
const SHEET = [
  ["ADMIN - SUPPORT STAFF", "A1, A2"],
  ["ASSISTANT VICE PRESIDENT", "C1"],
  ["CHIEF STRATEGY OFFICER", "C1"],
  ["STATE BUSINESS HEAD", "C1"],
  ["DEPUTY VICE PRESIDENT", "C2"],
  ["ZONAL HEAD/MANAGER", "C2, C3"],
  ["CHIEF INFORMATION SECURITY OFFICER", "C3"],
  ["NATIONAL HEAD", "C3"],
  ["VICE PRESIDENT", "C3"],
  ["CHIEF BUSINESS OFFICER/CHIEF COMPLIANCE OFFICER/CHIEF FINANCIAL OFFICER/CHIEF TECHNOLOGY OFFICER/CHIEF TREASURY OFFICER", "D2"],
  ["SENIOR VICE PRESIDENT", "D1"],
  ["CHIEF MANAGER", "F1"],
  ["REGIONAL MANAGER", "F1, F2"],
  ["CYBER SECURITY ANALYST AND IT AUDITOR", "M1"],
  ["CLUSTER MANAGER/SENIOR CLUSTER MANAGER/TERRITORY MANAGER", "M1, M2"],
  ["AREA MANAGER", "M3, M4"],
  ["MANAGER/SENIOR MANAGER/HUB MANAGER", "M1,M2,M3, M4"],
  ["ASSISTANT MANAGER", "O1, O2"],
  ["TEAM LEADER", "O1,O2"],
  ["CASHIER", "O2"],
  ["BUSINESS ANALYST", "O3"],
  ["DEPUTY MANAGER", "O3, O4"],
  ["ABM-TL/ASSISTANT BRANCH MANAGER/BRANCH MANAGER/SENIOR BRANCH MANAGER/SENIOR RELATIONSHIP MANAGER", "O1,O2,O3, O4"],
  ["COORDINATOR/ IT AUDITOR/ TELE EXECUTIVE/DISBURSEMENT OFFICER/EXECUTIVE/ASSISTANT BRANCH MANAGER - RO/ SENIOR EXECUTIVE/ OFFICER/ RECOVERY OFFICER", "S1, S2, S3, S4"],
].map(([designation, grades], i) => ({ line: i + 2, designation, grades }));
// The same sheet with the zonal line naming both roles in full.
const FIXED = SHEET.map((r) => (r.line === 7 ? { ...r, designation: "ZONAL HEAD/ZONAL MANAGER" } : r));

test("the sheet: names in Title Case, one designation per name, grades sorted", () => {
  assert.equal(designationName("ABM-TL"), "ABM-TL");
  assert.equal(designationName(" ASSISTANT BRANCH MANAGER - RO"), "Assistant Branch Manager - RO");
  assert.equal(designationName("CYBER SECURITY ANALYST AND IT AUDITOR"), "Cyber Security Analyst and IT Auditor");
  assert.equal(designationName("Vice president"), "Vice president", "mixed case is kept as typed");

  // As provided, "ZONAL HEAD/MANAGER" names a plain "Manager", which line 18 also names.
  const asGiven = planSheet(SHEET);
  assert.deepEqual(asGiven.problems.map((p) => p.line), [18]);
  assert.match(asGiven.problems[0].reason, /Manager is also on line 7/);

  const plan = planSheet(FIXED);
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.designations.length, 45);
  assert.deepEqual(plan.grades, ["A1", "A2", "C1", "C2", "C3", "D1", "D2", "F1", "F2", "M1", "M2", "M3", "M4", "O1", "O2", "O3", "O4", "S1", "S2", "S3", "S4"]);
  const byName = Object.fromEntries(plan.designations.map((d) => [d.name, d.grades]));
  assert.deepEqual(byName["Zonal Manager"], ["C2", "C3"]);
  assert.deepEqual(byName["Manager"], ["M1", "M2", "M3", "M4"]);
  assert.deepEqual(byName["Chief Treasury Officer"], ["D2"]);
  assert.deepEqual(byName["IT Auditor"], ["S1", "S2", "S3", "S4"]);
  assert.deepEqual(byName["Assistant Branch Manager"], ["O1", "O2", "O3", "O4"]);

  assert.match(planSheet([{ line: 4, designation: "Clerk", grades: "" }]).problems[0].reason, /No grade for Clerk/);
  assert.match(planSheet([{ line: 4, designation: "Clerk", grades: "S1 (old)" }]).problems[0].reason, /is not a grade/);
});

test("import from the sheet, grades by hand, and a warning for a grade outside the designation", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server } = createApp({ db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  let admin = null;
  admin = (
    await (
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.test", password: "Admin-password-123", native: true }),
      })
    ).json()
  ).token;

  // Before: two designations of the old list, one person on each.
  const vp = (await call("/admin/designations", { name: "Vice president" })).data.id;
  const ciso = (await call("/admin/designations", { name: "CISO" })).data.id;
  const person = (
    await call("/admin/employees", { name: "Ravi", email: "ravi@example.test", password: "Temporary-pass-123", designation_id: vp })
  ).data;
  assert.equal(person.warning, null);
  await call("/admin/employees", { name: "Sita", email: "sita@example.test", password: "Temporary-pass-123", designation_id: ciso });

  // The sheet as given: shown with its problem, and not imported.
  const preview = await call("/admin/designations/import", { rows: SHEET });
  assert.equal(preview.status, 200);
  assert.equal(preview.data.applied, false);
  assert.equal(preview.data.problems[0].line, 18);
  assert.equal((await call("/admin/designations/import", { rows: SHEET, apply: true })).status, 422);
  assert.equal((await call("/admin/grades")).data.length, 0, "nothing saved");

  // The fixed sheet: previewed, then imported.
  const check = (await call("/admin/designations/import", { rows: FIXED })).data;
  const vpLine = check.designations.find((d) => d.name === "Vice President");
  assert.equal(vpLine.status, "updated");
  assert.match(vpLine.note, /renamed from Vice president; grades added/);
  assert.deepEqual(check.notInSheet, [{ name: "CISO", employees: 1 }]);
  assert.equal(check.grades.filter((g) => g.status === "new").length, 21);
  const done = await call("/admin/designations/import", { rows: FIXED, apply: true });
  assert.equal(done.status, 200);
  assert.equal(done.data.applied, true);
  assert.equal((await call("/admin/grades")).data.length, 21);
  const list = (await call("/admin/designations")).data;
  assert.equal(list.length, 46, "45 from the sheet and CISO");
  assert.equal(list.find((d) => d.id === vp).name, "Vice President", "same designation, renamed; Ravi keeps it");
  assert.equal(list.find((d) => d.name === "Area Manager").grade_names, "M3, M4");
  assert.equal(list.find((d) => d.id === ciso).grade_names, null);
  // Importing the same sheet again changes nothing.
  assert.ok((await call("/admin/designations/import", { rows: FIXED })).data.designations.every((d) => d.status === "unchanged"));

  // The employee form gets each designation's grades.
  const org = (await call("/admin/org")).data;
  const id = (list, name) => list.find((x) => x.name === name).id;
  const area = id(org.designations, "Area Manager");
  const [m3, o1] = [id(org.grades, "M3"), id(org.grades, "O1")];
  assert.deepEqual(
    org.designation_grades.filter(([d]) => d === area).map(([, g]) => g).sort(),
    [id(org.grades, "M3"), id(org.grades, "M4")].sort(),
  );

  // A grade outside the designation's: saved, with a warning. A fitting one: no warning.
  const odd = (
    await call("/admin/employees", { name: "Amit", email: "amit@example.test", password: "Temporary-pass-123", designation_id: area, grade_id: o1 })
  ).data;
  assert.match(odd.warning, /grade O1 is not one of the grades for Area Manager \(M3, M4\)/);
  assert.equal((await db.prepare("SELECT grade_id FROM users WHERE id=?").get(odd.id)).grade_id, o1, "saved anyway");
  assert.equal((await call(`/admin/employees/${odd.id}`, { grade_id: m3 }, "PATCH")).data.warning, null);
  assert.match((await call(`/admin/employees/${odd.id}`, { grade_id: o1 }, "PATCH")).data.warning, /O1/);

  // Grades set by hand for one designation.
  assert.equal((await call(`/admin/designations/${area}/grades`, { grade_ids: [m3, o1] }, "PUT")).status, 200);
  assert.equal((await call(`/admin/employees/${odd.id}`, { name: "Amit K" }, "PATCH")).data.warning, null);
  assert.equal((await call(`/admin/designations/${area}/grades`, { grade_ids: [999999] }, "PUT")).status, 400);
  assert.equal((await call(`/admin/designations/${area}/grades`, { grade_ids: [] }, "PUT")).status, 200);
  assert.equal((await call(`/admin/employees/${odd.id}`, { grade_id: id(org.grades, "S4") }, "PATCH")).data.warning, null, "no grades set: any grade fits");
});
