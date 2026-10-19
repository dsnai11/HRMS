import { randomInt } from "node:crypto";
import { HttpError } from "../http.js";
import { can } from "../rbac.js";

const WORDS = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const tempPassword = () =>
  Array.from({ length: 12 }, () => WORDS[randomInt(WORDS.length)]).join("");
const key = (v) =>
  String(v ?? "")
    .trim()
    .toLowerCase();
const isDate = (v) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  !Number.isNaN(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const MAX_ROWS = 150; // password hashing is the slow part; the portal sends files in chunks of 100
const yes = (v, fallback) =>
  v === undefined || v === ""
    ? fallback
    : ["yes", "y", "true", "1"].includes(key(v));

// Loads people, departments and so on in bulk from a spreadsheet exported as CSV (the portal
// parses the file and sends rows). Both imports take dry_run to check without saving.
export function registerBulk(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();

  router.post(
    "/api/admin/employees/import",
    { perm: "employees.write" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(2_000_000);
      if (!Array.isArray(b.rows) || !b.rows.length)
        throw new HttpError(400, "Add at least one row.");
      if (b.rows.length > MAX_ROWS)
        throw new HttpError(413, `Send at most ${MAX_ROWS} rows at a time.`);
      const dry = b.dry_run === true,
        createMissing = b.create_missing === true;
      const lookup = async (table) =>
        new Map(
          (
            await db
              .prepare(`SELECT id,name FROM ${table} WHERE company_id=?`)
              .all(companyId)
          ).map((r) => [key(r.name), r.id]),
        );
      const orgs = {
        departments: await lookup("departments"),
        designations: await lookup("designations"),
        branches: await lookup("branches"),
      };
      const workplaces = await lookup("workplaces");
      const wanted = [
        ...new Set(b.rows.map((r) => key(r?.email)).filter(Boolean)),
      ];
      const people = await db
        .prepare(
          `SELECT id,employee_code,email FROM users WHERE company_id=? ${wanted.length ? `OR lower(email) IN (${wanted.map(() => "?").join(",")})` : ""}`,
        )
        .all(companyId, ...wanted);
      const codes = new Map(
        people
          .filter((p) => p.employee_code)
          .map((p) => [key(p.employee_code), p.id]),
      );
      const emails = new Set(people.map((p) => key(p.email)));
      const report = [],
        accepted = [],
        batchCodes = new Set(),
        batchEmails = new Set();

      b.rows.forEach((raw, i) => {
        const r = raw ?? {};
        const line = i + 1;
        const fail = (reason) =>
          report.push({
            line,
            name: r.name ?? "",
            email: r.email ?? "",
            status: "failed",
            reason,
          });
        const name = String(r.name ?? "").trim(),
          email = key(r.email);
        if (!name) return fail("Name is missing");
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          return fail("Email is missing or not valid");
        if (emails.has(email) || batchEmails.has(email))
          return fail("Email is already registered");
        const code = String(r.employee_code ?? "").trim();
        if (code && (codes.has(key(code)) || batchCodes.has(key(code))))
          return fail("Employee code is already in use");
        for (const k of ["date_of_birth", "date_of_joining"])
          if (r[k] && !isDate(r[k]))
            return fail(`${k.replaceAll("_", " ")} must be YYYY-MM-DD`);
        if (r.gender && !["male", "female", "other"].includes(key(r.gender)))
          return fail("Gender must be male, female or other");
        if (
          r.employment_type &&
          ![
            "full_time",
            "part_time",
            "contract",
            "intern",
            "consultant",
          ].includes(key(r.employment_type))
        )
          return fail(
            "Employment type must be full_time, part_time, contract, intern or consultant",
          );
        const refs = {};
        for (const [field, table] of [
          ["department", "departments"],
          ["designation", "designations"],
          ["branch", "branches"],
        ]) {
          const v = String(r[field] ?? "").trim();
          if (!v) continue;
          if (orgs[table].has(key(v))) refs[field] = v;
          else if (createMissing) refs[field] = v;
          else
            return fail(
              `Unknown ${field} "${v}" (tick "create missing" to add it)`,
            );
        }
        const wp = String(r.workplace ?? "").trim();
        if (wp && !workplaces.has(key(wp)))
          return fail(
            `Unknown workplace "${wp}" (workplaces need map coordinates, so add them first)`,
          );
        batchEmails.add(email);
        if (code) batchCodes.add(key(code));
        accepted.push({ line, r, name, email, code, refs, wp });
      });
      // Reporting managers must exist, in the company or in this file.
      for (const a of accepted) {
        const m = String(a.r.manager_code ?? "").trim();
        if (m && !codes.has(key(m)) && !batchCodes.has(key(m))) {
          report.push({
            line: a.line,
            name: a.name,
            email: a.email,
            status: "failed",
            reason: `Manager code "${m}" not found`,
          });
          a.skip = true;
        }
      }
      const todo = accepted.filter((a) => !a.skip);
      if (dry)
        return send(200, {
          dry_run: true,
          would_create: todo.length,
          failed: report.length,
          report: report.slice(0, 300),
        });

      const credentials = [];
      const created = [];
      for (const a of todo) {
        try {
          const ensure = async (table, name) => {
            const id = orgs[table].get(key(name));
            if (id) return id;
            const made =
              table === "branches"
                ? Number(
                    (
                      await db
                        .prepare(
                          "INSERT INTO branches(company_id,name,state,created_at) VALUES(?,?,?,?)",
                        )
                        .run(
                          companyId,
                          name,
                          String(a.r.branch_state ?? "").trim() || null,
                          nowIso(),
                        )
                    ).lastInsertRowid,
                  )
                : Number(
                    (
                      await db
                        .prepare(
                          `INSERT INTO ${table}(company_id,name,created_at) VALUES(?,?,?)`,
                        )
                        .run(companyId, name, nowIso())
                    ).lastInsertRowid,
                  );
            orgs[table].set(key(name), made);
            return made;
          };
          const body2 = {
            name: a.name,
            email: a.email,
            password: tempPassword(),
            ...(a.code ? { employee_code: a.code } : {}),
            ...(a.r.phone ? { phone: String(a.r.phone).trim() } : {}),
            ...(a.r.gender ? { gender: key(a.r.gender) } : {}),
            ...(a.r.date_of_birth ? { date_of_birth: a.r.date_of_birth } : {}),
            ...(a.r.date_of_joining
              ? { date_of_joining: a.r.date_of_joining }
              : {}),
            ...(a.r.employment_type
              ? { employment_type: key(a.r.employment_type) }
              : {}),
          };
          if (a.refs.department)
            body2.department_id = await ensure(
              "departments",
              a.refs.department,
            );
          if (a.refs.designation)
            body2.designation_id = await ensure(
              "designations",
              a.refs.designation,
            );
          if (a.refs.branch)
            body2.branch_id = await ensure("branches", a.refs.branch);
          if (a.wp) body2.workplace_id = workplaces.get(key(a.wp));
          const id = await app.createEmployee(user, companyId, body2, audit);
          const row = await db
            .prepare("SELECT employee_code FROM users WHERE id=?")
            .get(id);
          codes.set(key(row.employee_code), id);
          created.push({ id, a });
          credentials.push({
            employee_code: row.employee_code,
            name: a.name,
            email: a.email,
            temp_password: body2.password,
          });
          report.push({
            line: a.line,
            name: a.name,
            email: a.email,
            status: "created",
          });
        } catch (e) {
          report.push({
            line: a.line,
            name: a.name,
            email: a.email,
            status: "failed",
            reason: e instanceof HttpError ? e.message : "Could not be created",
          });
        }
      }
      // Reporting lines, now that everyone in the file exists. A manager may not report back to the person.
      for (const { id, a } of created) {
        const m = String(a.r.manager_code ?? "").trim();
        if (!m) continue;
        const managerId = codes.get(key(m));
        if (!managerId || managerId === id) continue;
        let cursor = managerId,
          loops = false;
        for (let i = 0; cursor && i < 100; i++) {
          if (cursor === id) {
            loops = true;
            break;
          }
          cursor = (
            await db
              .prepare("SELECT manager_id FROM users WHERE id=?")
              .get(cursor)
          )?.manager_id;
        }
        if (loops)
          report.push({
            line: a.line,
            name: a.name,
            email: a.email,
            status: "created",
            reason:
              "Manager not set: it would make the reporting line circular",
          });
        else
          await db
            .prepare("UPDATE users SET manager_id=? WHERE id=?")
            .run(managerId, id);
      }
      await audit("employees_imported", {
        created: created.length,
        failed: report.filter((r) => r.status === "failed").length,
      });
      return send(200, {
        dry_run: false,
        created: created.length,
        failed: report.filter((r) => r.status === "failed").length,
        report: report.slice(0, 300),
        credentials,
      });
    },
  );

  router.post(
    "/api/admin/payroll/salaries/import",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(1_000_000);
      if (!Array.isArray(b.rows) || !b.rows.length)
        throw new HttpError(400, "Add at least one row.");
      if (b.rows.length > MAX_ROWS * 2)
        throw new HttpError(
          413,
          `Send at most ${MAX_ROWS * 2} rows at a time.`,
        );
      const dry = b.dry_run === true;
      const comps = (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM salary_components WHERE company_id=? AND active=1",
          )
          .get(companyId)
      ).n;
      if (!comps)
        throw new HttpError(
          409,
          "Set up the salary structure first (Payroll → Salary structure).",
        );
      const byCode = new Map(
        (
          await db
            .prepare(
              "SELECT id,employee_code,role FROM users WHERE company_id=? AND employee_code IS NOT NULL",
            )
            .all(companyId)
        ).map((u) => [key(u.employee_code), u]),
      );
      const report = [];
      let ok = 0;
      for (const [i, r] of b.rows.entries()) {
        const line = i + 1,
          code = String(r?.employee_code ?? "").trim();
        const fail = (reason) =>
          report.push({ line, code, status: "failed", reason });
        const person = byCode.get(key(code));
        if (!person) {
          fail("Unknown employee code");
          continue;
        }
        const gross = Number(r.monthly_gross);
        if (!(gross >= 1 && gross <= 10000000)) {
          fail("Monthly gross must be a number");
          continue;
        }
        if (!isDate(String(r.effective_from ?? ""))) {
          fail("Effective from must be YYYY-MM-DD");
          continue;
        }
        if (dry) {
          ok++;
          continue;
        }
        try {
          await app.setSalary(
            user,
            companyId,
            person.id,
            {
              effective_from: r.effective_from,
              monthly_gross: gross,
              pf_applicable: yes(r.pf, true),
              // ESI cover applies up to ₹21,000 a month; override with the esi column.
              esi_applicable: yes(r.esi, gross <= 21000),
              pt_applicable: yes(r.pt, true),
              tax_regime: key(r.tax_regime) === "old" ? "old" : "new",
              note: "Imported",
              ...(b.allow_arrears === true ? { arrears: true } : {}),
            },
            audit,
          );
          ok++;
          report.push({ line, code, status: "saved" });
        } catch (e) {
          fail(e instanceof HttpError ? e.message : "Could not be saved");
        }
      }
      if (!dry)
        await audit("salaries_imported", {
          saved: ok,
          failed: report.filter((r) => r.status === "failed").length,
        });
      return send(200, {
        dry_run: dry,
        ok,
        failed: report.filter((r) => r.status === "failed").length,
        report: report.slice(0, 300),
      });
    },
  );
}
