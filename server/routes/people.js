import { createHash, randomBytes } from "node:crypto";
import {
  HttpError,
  clientIp,
  integer,
  isoDate,
  number,
  oneOf,
  optionalId,
  optionalString,
  password,
  string,
} from "../http.js";
import { passwordHash } from "../db.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { changeLetter } from "../letters.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");
const CHANGE_KINDS = ["promotion", "transfer", "increment", "confirmation"];

export function registerPeople(router, app) {
  const { db, transaction, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);

  // ---- directory -----------------------------------------------------------------------------
  router.get("/api/directory", async ({ user, query, send }) => {
    const where = ["u.company_id=?", "u.active=1", "u.role<>'super_admin'"],
      params = [user.company_id];
    const q = query.get("q")?.trim().toLowerCase();
    if (q)
      (where.push(
        "(lower(u.name) LIKE ? OR lower(u.employee_code) LIKE ? OR lower(g.name) LIKE ? OR lower(d.name) LIKE ?)",
      ),
        params.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`));
    for (const key of ["department_id", "branch_id"])
      if (query.get(key))
        (where.push(`u.${key}=?`),
          params.push(integer(Number(query.get(key)))));
    const rows = await db
      .prepare(
        `SELECT u.id,u.name,u.employee_code,u.email,u.phone,u.manager_id,g.name designation_name,d.name department_name,b.name branch_name,m.name manager_name
           FROM users u LEFT JOIN designations g ON g.id=u.designation_id LEFT JOIN departments d ON d.id=u.department_id
           LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN users m ON m.id=u.manager_id
           WHERE ${where.join(" AND ")} ORDER BY u.name LIMIT 200`,
      )
      .all(...params);
    // Contact details are for HR, the person's manager chain and the person themselves.
    const seeAll = can(user, "employees.read");
    return send(
      200,
      rows.map(({ manager_id, ...p }) =>
        seeAll ||
        p.id === user.id ||
        manager_id === user.id ||
        p.id === user.manager_id
          ? p
          : { ...p, email: null, phone: null },
      ),
    );
  });

  // ---- referrals -----------------------------------------------------------------------------
  router.get("/api/openings/open", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT o.id,o.title,o.positions,d.name department_name,b.name branch_name FROM job_openings o LEFT JOIN departments d ON d.id=o.department_id LEFT JOIN branches b ON b.id=o.branch_id WHERE o.company_id=? AND o.status='open' ORDER BY o.title",
        )
        .all(user.company_id),
    ),
  );
  router.get("/api/referrals", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT c.id,c.name,c.stage,c.created_at,o.title opening_title FROM candidates c LEFT JOIN job_openings o ON o.id=c.opening_id WHERE c.referred_by=? ORDER BY c.id DESC",
        )
        .all(user.id),
    ),
  );
  router.post("/api/referrals", async ({ user, body, send, audit }) => {
    const b = await body();
    const name = string(b.name, "Name", 100);
    const email = optionalString(b.email, "Email", 254);
    const phone = optionalString(b.phone, "Phone", 20);
    if (!email && !phone)
      throw new HttpError(
        400,
        "Give an email or a phone number so HR can reach them.",
      );
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "Enter a valid email.");
    if (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone))
      throw new HttpError(400, "Phone must be a valid number.");
    const opening = optionalId(b.opening_id, "Opening");
    if (opening) {
      const o = await owned(
        "job_openings",
        opening,
        user.company_id,
        "opening",
      );
      if (o.status !== "open")
        throw new HttpError(409, "That opening is closed.");
    }
    if (
      email &&
      (await db
        .prepare(
          "SELECT id FROM candidates WHERE company_id=? AND lower(email)=? AND stage IN ('applied','screening','interview','offer')",
        )
        .get(user.company_id, email.toLowerCase()))
    )
      throw new HttpError(409, "This person is already being considered.");
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO candidates(company_id,opening_id,name,email,phone,source,notes,referred_by,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              opening,
              name,
              email,
              phone,
              `Referral by ${user.name}`,
              optionalString(b.note, "Note", 1000),
              user.id,
              user.id,
              nowIso(),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await db
        .prepare(
          "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
        )
        .run(id, "added", `Referred by ${user.name}`, user.id, nowIso());
      await audit("referral_submitted", { id });
      return id;
    });
    const hr = await db
      .prepare(
        "SELECT id FROM users WHERE company_id=? AND active=1 AND role IN ('hr','admin')",
      )
      .all(user.company_id);
    await app.notify(
      hr.map((h) => h.id),
      {
        companyId: user.company_id,
        kind: "referral",
        title: `${user.name} referred ${name}`,
        link: "hiring",
      },
    );
    return send(201, { id });
  });

  // ---- promotions, transfers, increments, confirmations ------------------------------------------
  const CHANGE = `SELECT c.*,u.name employee_name,u.employee_code,g.name designation_name,d.name department_name,b.name branch_name,m.name manager_name
    FROM employee_changes c JOIN users u ON u.id=c.user_id LEFT JOIN designations g ON g.id=c.designation_id LEFT JOIN departments d ON d.id=c.department_id
    LEFT JOIN branches b ON b.id=c.branch_id LEFT JOIN users m ON m.id=c.manager_id`;
  async function applyChange(c, actor, audit) {
    const person = await db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(c.user_id);
    if (c.status !== "pending")
      throw new HttpError(409, `This change is already ${c.status}.`);
    if (c.effective_date > today())
      throw new HttpError(409, `It takes effect on ${c.effective_date}.`);
    if (c.kind === "increment" && !can(actor, "payroll.manage"))
      throw new HttpError(
        403,
        "Salary revisions are applied by payroll or an administrator.",
      );
    const sets = {};
    for (const k of [
      "designation_id",
      "department_id",
      "branch_id",
      "manager_id",
      "workplace_id",
    ])
      if (c[k]) sets[k] = c[k];
    if (c.manager_id === c.user_id)
      throw new HttpError(400, "A person cannot report to themselves.");
    await transaction(async () => {
      const previous = Object.fromEntries(
        Object.keys(sets).map((k) => [k, person[k]]),
      );
      if (Object.keys(sets).length)
        await db
          .prepare(
            `UPDATE users SET ${Object.keys(sets)
              .map((k) => `${k}=?`)
              .join(",")} WHERE id=?`,
          )
          .run(...Object.values(sets), person.id);
      if (c.kind === "confirmation")
        await db
          .prepare(
            "UPDATE users SET probation_end_date=NULL,probation_notified_on=NULL WHERE id=?",
          )
          .run(person.id);
      if (c.kind === "increment") {
        const prev = await db
          .prepare(
            "SELECT * FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC LIMIT 1",
          )
          .get(person.id);
        if (prev) previous.monthly_gross = prev.monthly_gross;
        // Keep the person's existing statutory settings; only the gross changes.
        await app.setSalary(
          actor,
          c.company_id,
          person.id,
          {
            effective_from: c.effective_date,
            monthly_gross: c.monthly_gross,
            note: c.note ?? "Increment",
            ...(prev
              ? {
                  pf_applicable: Boolean(prev.pf_applicable),
                  esi_applicable:
                    Boolean(prev.esi_applicable) && c.monthly_gross <= 21000,
                  pt_applicable: Boolean(prev.pt_applicable),
                  eps_eligible: Boolean(prev.eps_eligible),
                  tax_regime: prev.tax_regime,
                  declared_deductions: prev.declared_deductions,
                }
              : {}),
            arrears: true,
          },
          audit,
        );
      }
      await db
        .prepare(
          "UPDATE employee_changes SET status='applied',applied_at=?,previous=? WHERE id=?",
        )
        .run(nowIso(), JSON.stringify(previous), c.id);
      await audit("employee_change_applied", {
        id: c.id,
        kind: c.kind,
        employeeId: person.id,
      });
    });
    await app.notify([person.id], {
      companyId: c.company_id,
      kind: "career",
      title: {
        promotion: "You have been promoted",
        transfer: "Your transfer has taken effect",
        increment: "Your salary revision has taken effect",
        confirmation: "You have been confirmed",
      }[c.kind],
      link: "myemployment",
      email: true,
    });
  }
  router.get(
    "/api/admin/changes",
    { perm: "changes.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `${CHANGE} WHERE c.company_id=? ${status ? "AND c.status=?" : ""} ORDER BY c.effective_date DESC,c.id DESC LIMIT 300`,
          )
          .all(
            ...(status
              ? [
                  companyId,
                  oneOf(status, "Status", ["pending", "applied", "cancelled"]),
                ]
              : [companyId]),
          ),
      );
    },
  );
  router.post(
    "/api/admin/changes",
    { perm: "changes.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const person = await owned("users", b.user_id, companyId, "employee");
      if (person.role === "super_admin" || !person.active)
        throw new HttpError(400, "Choose an active employee.");
      const kind = oneOf(b.kind, "Type", CHANGE_KINDS);
      const effective = isoDate(b.effective_date, "Effective date");
      if (!effective) throw new HttpError(400, "Effective date is required.");
      const ref = async (table, key, label) => {
        const v = optionalId(b[key], label);
        if (v) await owned(table, v, companyId, label);
        return v;
      };
      const f = {
        designation_id: await ref(
          "designations",
          "designation_id",
          "designation",
        ),
        department_id: await ref("departments", "department_id", "department"),
        branch_id: await ref("branches", "branch_id", "branch"),
        manager_id: await ref("users", "manager_id", "manager"),
        workplace_id: await ref("workplaces", "workplace_id", "workplace"),
      };
      const gross =
        b.monthly_gross === undefined ||
        b.monthly_gross === null ||
        b.monthly_gross === ""
          ? null
          : Math.round(number(b.monthly_gross, "Monthly gross", 1, 100000000));
      if (kind === "promotion" && !f.designation_id)
        throw new HttpError(400, "Choose the new designation.");
      if (
        kind === "transfer" &&
        !(f.branch_id || f.department_id || f.manager_id || f.workplace_id)
      )
        throw new HttpError(
          400,
          "Choose what changes: branch, department, manager or workplace.",
        );
      if (kind === "increment" && !gross)
        throw new HttpError(400, "Enter the new monthly gross.");
      if (f.manager_id === person.id)
        throw new HttpError(400, "A person cannot report to themselves.");
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO employee_changes(company_id,user_id,kind,effective_date,designation_id,department_id,branch_id,manager_id,workplace_id,monthly_gross,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                kind,
                effective,
                f.designation_id,
                f.department_id,
                f.branch_id,
                f.manager_id,
                f.workplace_id,
                kind === "increment" ? gross : null,
                optionalString(b.note, "Note", 500),
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await audit("employee_change_created", {
          id,
          kind,
          employeeId: person.id,
          effective,
        });
        return id;
      });
      return send(201, { id });
    },
  );
  router.post(
    "/api/admin/changes/:id/apply",
    { perm: "changes.manage" },
    async ({ user, params, companyId, send, audit }) => {
      const c = await owned("employee_changes", params.id, companyId, "change");
      await applyChange(c, user, audit);
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/changes/:id/cancel",
    { perm: "changes.manage" },
    async ({ params, companyId, send, audit }) => {
      const c = await owned("employee_changes", params.id, companyId, "change");
      if (c.status !== "pending")
        throw new HttpError(409, `This change is already ${c.status}.`);
      await db
        .prepare("UPDATE employee_changes SET status='cancelled' WHERE id=?")
        .run(c.id);
      await audit("employee_change_cancelled", { id: c.id });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/changes/:id/letter",
    { perm: "changes.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("employee_changes", params.id, companyId, "change");
      const row = await db.prepare(`${CHANGE} WHERE c.id=?`).get(c.id);
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        company: company.name,
        ...changeLetter({
          company: company.name,
          person: { name: row.employee_name },
          change: c,
          names: {
            designation: row.designation_name,
            department: row.department_name,
            branch: row.branch_name,
            manager: row.manager_name,
          },
          today: today(),
        }),
      });
    },
  );
  router.get("/api/my-changes", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${CHANGE} WHERE c.user_id=? AND c.status='applied' ORDER BY c.effective_date DESC`,
        )
        .all(user.id),
    ),
  );

  // ---- self-service password reset --------------------------------------------------------------------
  // Always answers the same way, so it cannot be used to find out who has an account.
  router.post(
    "/api/forgot-password",
    { public: true },
    async ({ req, body, send }) => {
      rateLimit(`forgot:${clientIp(req)}`, 20);
      const mail = string((await body()).email, "Email", 254).toLowerCase();
      rateLimit(`forgot-email:${mail}`, 3);
      const u = await db
        .prepare(
          "SELECT u.* FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? AND u.active=1 AND c.active=1",
        )
        .get(mail);
      if (u && process.env.APP_URL) {
        const token = randomBytes(32).toString("hex");
        await db
          .prepare(
            "INSERT INTO password_resets(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)",
          )
          .run(u.id, sha(token), Date.now() + 3600000, nowIso());
        await app.notify([u.id], {
          companyId: u.company_id,
          kind: "password",
          inApp: false,
          email: true,
          title: "Reset your HRMS password",
          body: `Open this link within one hour to choose a new password:\n${process.env.APP_URL.replace(/\/$/, "")}/?reset=${token}\n\nIf you did not ask for this, ignore this email.`,
        });
      }
      return send(200, {
        ok: true,
        message:
          "If that address has an account and email is set up, a reset link has been sent. Otherwise ask HR to reset your password.",
      });
    },
  );
  router.post(
    "/api/reset-password",
    { public: true },
    async ({ req, body, send }) => {
      rateLimit(`reset:${clientIp(req)}`, 20);
      const b = await body();
      const pw = password(b.password);
      const row = await db
        .prepare("SELECT * FROM password_resets WHERE token_hash=?")
        .get(sha(String(b.token ?? "")));
      if (!row || row.used_at || row.expires_at < Date.now())
        throw new HttpError(
          400,
          "This reset link is invalid or has expired. Ask for a new one.",
        );
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
          )
          .run(passwordHash(pw), row.user_id);
        await db
          .prepare("UPDATE password_resets SET used_at=? WHERE id=?")
          .run(nowIso(), row.id);
        await db
          .prepare("DELETE FROM sessions WHERE user_id=?")
          .run(row.user_id);
        const u = await db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(row.user_id);
        await app.audit(u, "password_reset", {});
      });
      return send(200, { ok: true });
    },
  );

  // ---- selfie evidence and its setting --------------------------------------------------------------------
  router.get(
    "/api/admin/attendance-settings",
    { perm: "attendance.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT require_selfie,min_app_version FROM companies WHERE id=?",
          )
          .get(companyId),
      ),
  );
  router.patch(
    "/api/admin/attendance-settings",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const row = await db
        .prepare(
          "SELECT require_selfie,min_app_version FROM companies WHERE id=?",
        )
        .get(companyId);
      const min =
        b.min_app_version === undefined
          ? row.min_app_version
          : b.min_app_version
            ? String(b.min_app_version).trim()
            : null;
      if (min && !/^\d+(\.\d+){0,2}$/.test(min))
        throw new HttpError(400, "Version must look like 1.2.0.");
      await db
        .prepare(
          "UPDATE companies SET require_selfie=?,min_app_version=? WHERE id=?",
        )
        .run(
          b.require_selfie === undefined
            ? row.require_selfie
            : b.require_selfie
              ? 1
              : 0,
          min,
          companyId,
        );
      await audit("attendance_settings_updated", {
        require_selfie: b.require_selfie ?? null,
        min_app_version: min,
      });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/shifts/:id/selfie",
    { perm: "attendance.read" },
    async ({ params, companyId, query, res, headers, audit }) => {
      const kind = oneOf(query.get("kind") ?? "in", "Kind", ["in", "out"]);
      const row = await db
        .prepare(
          "SELECT p.data,s.user_id FROM punch_photos p JOIN shifts s ON s.id=p.shift_id JOIN users u ON u.id=s.user_id WHERE p.shift_id=? AND p.kind=? AND u.company_id=?",
        )
        .get(integer(Number(params.id)), kind, companyId);
      if (!row) throw new HttpError(404, "No selfie for this punch.");
      await audit("selfie_viewed", {
        shiftId: Number(params.id),
        employeeId: row.user_id,
      });
      res.writeHead(200, {
        ...headers,
        "Content-Type": "image/jpeg",
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(row.data, "base64"));
    },
  );

  // ---- my tax statement (Form 130 data for the employee) ----------------------------------------------------
  router.get("/api/my/tax-statement", async ({ user, query, send }) => {
    const year = Number(query.get("year"));
    if (!Number.isInteger(year) || year < 2020 || year > 2100)
      throw new HttpError(
        400,
        "Choose the financial year it starts in, like 2026.",
      );
    const rows = await db
      .prepare(
        `SELECT r.month,i.gross,i.taxable_earnings,i.tds,i.pt,i.net,i.data FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id
         WHERE i.user_id=? AND r.status IN ('approved','paid') AND r.month>=? AND r.month<=? ORDER BY r.month`,
      )
      .all(user.id, `${year}-04`, `${year + 1}-03`);
    const months = rows.map((r) => ({
      month: r.month,
      gross: r.gross,
      taxable: r.taxable_earnings,
      tds: r.tds,
      pt: r.pt,
      net: r.net,
      pf: (JSON.parse(r.data).deductions ?? [])
        .filter((d) => d.code === "PF")
        .reduce((s, d) => s + d.amount, 0),
    }));
    const opening = await db
      .prepare("SELECT * FROM payroll_opening WHERE user_id=? AND tax_year=?")
      .get(user.id, year);
    const sum = (k) => months.reduce((s, m) => s + m[k], 0);
    return send(200, {
      year,
      months,
      opening: opening
        ? {
            taxable_income: opening.taxable_income,
            tds: opening.tds_deducted,
            pt: opening.pt_deducted,
          }
        : null,
      totals: {
        gross: sum("gross"),
        taxable: sum("taxable") + (opening?.taxable_income ?? 0),
        tds: sum("tds") + (opening?.tds_deducted ?? 0),
        pt: sum("pt") + (opening?.pt_deducted ?? 0),
        pf: sum("pf"),
      },
    });
  });
}
