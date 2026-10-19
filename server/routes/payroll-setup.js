import {
  HttpError,
  string,
  optionalString,
  number,
  integer,
  isoDate,
  oneOf,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { buildSalaryLines, DEFAULT_CONFIG, round } from "../payroll/engine.js";
import { PT_PRESETS } from "../payroll/statutory.js";
import { taxYearOf } from "../payroll/tax.js";
import {
  encryptionKey,
  encryptJson,
  decryptJson,
  mask,
} from "../crypto-store.js";
import { computeArrears, nextMonth } from "../payroll/arrears.js";

const nowIso = (app) => new Date(app.clock()).toISOString();
const bool = (v, label) => {
  if (typeof v !== "boolean")
    throw new HttpError(400, `${label} must be true or false.`);
  return v;
};

// ---- settings --------------------------------------------------------------------
export async function loadConfig(db, companyId) {
  const row = await db
    .prepare("SELECT config FROM payroll_settings WHERE company_id=?")
    .get(companyId);
  const saved = row ? JSON.parse(row.config) : {};
  const merged = {};
  for (const [section, defaults] of Object.entries({
    ...DEFAULT_CONFIG,
    approval: { separateApprover: false },
    bonus: { rate: 8.33, minimumWage: 0 },
    leaveEncashment: { basis: "basic", divisor: 30 },
  }))
    merged[section] = { ...defaults, ...(saved[section] ?? {}) };
  return merged;
}

// ---- employee personal data ---------------------------------------------------------
const PRIVATE_FIELDS = {
  pan: [/^[A-Z]{5}[0-9]{4}[A-Z]$/, "PAN must look like ABCDE1234F"],
  uan: [/^\d{12}$/, "UAN must be 12 digits"],
  esi_ip: [/^(\d{10}|\d{17})$/, "ESI number must be 10 or 17 digits"],
  bank_account: [/^\d{6,20}$/, "Bank account must be 6–20 digits"],
  ifsc: [/^[A-Z]{4}0[A-Z0-9]{6}$/, "IFSC must look like HDFC0001234"],
  bank_name: [/^.{2,60}$/, "Bank name is too short or too long"],
  account_holder: [
    /^.{2,100}$/,
    "Account holder name is too short or too long",
  ],
};
const SENSITIVE = ["pan", "uan", "esi_ip", "bank_account"];

export async function readPrivate(app, userId) {
  const key = encryptionKey();
  const row = await app.db
    .prepare("SELECT data FROM employee_private WHERE user_id=?")
    .get(userId);
  if (!row || !key) return {};
  return decryptJson(row.data, key);
}
export const maskPrivate = (data) =>
  Object.fromEntries(
    Object.entries(data).map(([k, v]) => [
      k,
      SENSITIVE.includes(k) ? mask(v) : v,
    ]),
  );

export function registerPayrollSetup(router, app) {
  const { db, transaction } = app;

  router.get(
    "/api/admin/payroll/settings",
    { perm: "payroll.read" },
    async ({ companyId, send }) =>
      send(200, {
        ...(await loadConfig(db, companyId)),
        encryption_configured: Boolean(encryptionKey()),
      }),
  );
  router.patch(
    "/api/admin/payroll/settings",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const current = await loadConfig(db, companyId);
      const allowed = {
        pf: ["enabled", "restrictToCeiling", "applyWageCode50Rule"],
        esi: ["enabled"],
        pt: ["enabled"],
        tds: ["enabled"],
        approval: ["separateApprover"],
      };
      // Numeric and choice settings for bonus and leave encashment.
      const rate = b.bonus?.rate;
      if (rate !== undefined)
        current.bonus = {
          ...current.bonus,
          rate: number(rate, "Bonus rate", 8.33, 20),
        };
      const mw = b.bonus?.minimumWage;
      if (mw !== undefined)
        current.bonus = {
          ...current.bonus,
          minimumWage: number(mw, "Minimum wage", 0, 1000000),
        };
      const le = b.leaveEncashment ?? {};
      if (le.basis !== undefined)
        current.leaveEncashment = {
          ...current.leaveEncashment,
          basis: oneOf(le.basis, "Encashment basis", ["basic", "gross"]),
        };
      if (le.divisor !== undefined)
        current.leaveEncashment = {
          ...current.leaveEncashment,
          divisor: number(le.divisor, "Encashment divisor", 20, 31),
        };
      for (const [section, keys] of Object.entries(allowed))
        for (const key of keys) {
          const v = b[section]?.[key];
          if (v !== undefined)
            current[section][key] = bool(v, `${section}.${key}`);
        }
      await transaction(async () => {
        await db
          .prepare(
            "INSERT INTO payroll_settings(company_id,config,updated_at) VALUES(?,?,?) ON CONFLICT (company_id) DO UPDATE SET config=EXCLUDED.config, updated_at=EXCLUDED.updated_at",
          )
          .run(companyId, JSON.stringify(current), nowIso(app));
        await audit("payroll_settings_updated", b);
      });
      return send(200, current);
    },
  );

  // ---- salary structure --------------------------------------------------------------
  const componentFields = (b, existing = {}) => {
    const pick = (k, f) => (b[k] === undefined ? existing[k] : f(b[k]));
    const calc = pick("calc", (v) =>
      oneOf(v, "Calculation", [
        "percent_of_gross",
        "percent_of_basic",
        "fixed",
        "balance",
      ]),
    );
    return {
      name: pick("name", (v) => string(v, "Name", 60)),
      calc,
      value:
        calc === "balance"
          ? 0
          : pick("value", (v) =>
              number(v, "Value", 0, calc === "fixed" ? 10000000 : 100),
            ),
      is_basic: pick("is_basic", (v) => Number(bool(v, "Basic"))),
      taxable: pick("taxable", (v) => Number(bool(v, "Taxable"))),
      esi_wage: pick("esi_wage", (v) => Number(bool(v, "ESI wages"))),
      active: pick("active", (v) => Number(bool(v, "Active"))),
      sort_order: pick("sort_order", (v) => number(v, "Order", 0, 1000)),
    };
  };
  const listComponents = (companyId) =>
    db
      .prepare(
        "SELECT * FROM salary_components WHERE company_id=? ORDER BY sort_order,id",
      )
      .all(companyId);

  router.get(
    "/api/admin/payroll/components",
    { perm: "payroll.read" },
    async ({ companyId, send }) => send(200, await listComponents(companyId)),
  );
  router.post(
    "/api/admin/payroll/components",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const code = string(b.code, "Code", 12).toUpperCase();
      if (!/^[A-Z0-9_]{2,12}$/.test(code))
        throw new HttpError(
          400,
          "Code must be 2–12 letters, digits or underscores.",
        );
      const f = componentFields({
        is_basic: false,
        taxable: true,
        esi_wage: true,
        active: true,
        sort_order: 100,
        value: 0,
        ...b,
      });
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO salary_components(company_id,code,name,calc,value,is_basic,taxable,esi_wage,active,sort_order,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                code,
                f.name,
                f.calc,
                f.value,
                f.is_basic,
                f.taxable,
                f.esi_wage,
                f.active,
                f.sort_order,
                nowIso(app),
              )
          ).lastInsertRowid,
        );
        await audit("salary_component_created", { id, code });
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/payroll/components/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const id = integer(Number(params.id));
      const row = await requireOwned(
        db,
        "salary_components",
        id,
        companyId,
        "component",
      );
      const f = componentFields(await body(), row);
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE salary_components SET name=?,calc=?,value=?,is_basic=?,taxable=?,esi_wage=?,active=?,sort_order=? WHERE id=?",
          )
          .run(
            f.name,
            f.calc,
            f.value,
            f.is_basic,
            f.taxable,
            f.esi_wage,
            f.active,
            f.sort_order,
            id,
          );
        await audit("salary_component_updated", { id, ...f });
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/payroll/components/seed-defaults",
    { perm: "payroll.manage" },
    async ({ companyId, send, audit }) => {
      // Basic at 50% of gross satisfies the labour codes' wage definition by itself.
      const defaults = [
        ["BASIC", "Basic salary", "percent_of_gross", 50, 1, 10],
        ["HRA", "House rent allowance", "percent_of_basic", 40, 0, 20],
        ["SPECIAL", "Special allowance", "balance", 0, 0, 30],
      ];
      let created = 0;
      await transaction(async () => {
        for (const [code, name, calc, value, isBasic, order] of defaults) {
          if (
            await db
              .prepare(
                "SELECT id FROM salary_components WHERE company_id=? AND upper(code)=?",
              )
              .get(companyId, code)
          )
            continue;
          await db
            .prepare(
              "INSERT INTO salary_components(company_id,code,name,calc,value,is_basic,taxable,esi_wage,active,sort_order,created_at) VALUES(?,?,?,?,?,?,1,1,1,?,?)",
            )
            .run(
              companyId,
              code,
              name,
              calc,
              value,
              isBasic,
              order,
              nowIso(app),
            );
          created++;
        }
        await audit("salary_components_seeded", { created });
      });
      return send(201, { created });
    },
  );
  router.post(
    "/api/admin/payroll/salary-preview",
    { perm: "payroll.read" },
    async ({ companyId, body, send }) => {
      const b = await body();
      const gross = number(b.monthly_gross, "Monthly gross", 1, 10000000);
      try {
        return send(
          200,
          buildSalaryLines(await listComponents(companyId), gross),
        );
      } catch (e) {
        throw new HttpError(422, e.message);
      }
    },
  );

  // ---- professional-tax slabs -------------------------------------------------------------
  router.get(
    "/api/admin/payroll/pt-presets",
    { perm: "payroll.read" },
    async ({ send }) => send(200, Object.keys(PT_PRESETS)),
  );
  router.get(
    "/api/admin/payroll/pt-slabs",
    { perm: "payroll.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT * FROM pt_slabs WHERE company_id=? ORDER BY lower(state),COALESCE(gender,''),COALESCE(month,0),from_amount",
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/payroll/pt-slabs/preset",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const state = oneOf(
        (await body()).state,
        "State",
        Object.keys(PT_PRESETS),
      );
      await transaction(async () => {
        await db
          .prepare(
            "DELETE FROM pt_slabs WHERE company_id=? AND lower(state)=lower(?)",
          )
          .run(companyId, state);
        for (const [from, to, amount, gender, month] of PT_PRESETS[state])
          await db
            .prepare(
              "INSERT INTO pt_slabs(company_id,state,from_amount,to_amount,amount,gender,month) VALUES(?,?,?,?,?,?,?)",
            )
            .run(companyId, state, from, to, amount, gender, month);
        await audit("pt_slabs_preset_loaded", { state });
      });
      return send(201, { rows: PT_PRESETS[state].length });
    },
  );
  router.post(
    "/api/admin/payroll/pt-slabs",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const state = string(b.state, "State", 60);
      const from = number(b.from_amount, "From", 0, 10000000);
      const to =
        b.to_amount === null || b.to_amount === undefined || b.to_amount === ""
          ? null
          : number(b.to_amount, "To", from, 10000000);
      const amount = number(b.amount, "Tax", 0, 100000);
      const gender = b.gender
        ? oneOf(b.gender, "Gender", ["male", "female", "other"])
        : null;
      const month = b.month ? number(b.month, "Month", 1, 12) : null;
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO pt_slabs(company_id,state,from_amount,to_amount,amount,gender,month) VALUES(?,?,?,?,?,?,?)",
              )
              .run(companyId, state, from, to, amount, gender, month)
          ).lastInsertRowid,
        );
        await audit("pt_slab_added", { id, state });
        return id;
      });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/payroll/pt-slabs/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const row = await requireOwned(
        db,
        "pt_slabs",
        integer(Number(params.id)),
        companyId,
        "slab",
      );
      await db.prepare("DELETE FROM pt_slabs WHERE id=?").run(row.id);
      await audit("pt_slab_deleted", { id: row.id, state: row.state });
      return send(200, { ok: true });
    },
  );

  // ---- salaries ------------------------------------------------------------------------------
  const lastLockedMonth = async (companyId) =>
    (
      await db
        .prepare(
          "SELECT MAX(month) m FROM payroll_runs WHERE company_id=? AND status IN ('approved','paid')",
        )
        .get(companyId)
    ).m;

  router.get(
    "/api/admin/payroll/salaries",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const where = ["u.company_id=?", "u.active=1", "u.role<>'super_admin'"],
        params = [companyId];
      const q = query.get("q")?.trim().toLowerCase();
      if (q) {
        where.push("(lower(u.name) LIKE ? OR lower(u.employee_code) LIKE ?)");
        params.push(`%${q}%`, `%${q}%`);
      }
      const limit = Math.min(
          Math.max(Number(query.get("limit")) || 50, 1),
          200,
        ),
        offset = Math.max(Number(query.get("offset")) || 0, 0);
      const clause = where.join(" AND ");
      const total = (
        await db
          .prepare(`SELECT COUNT(*) n FROM users u WHERE ${clause}`)
          .get(...params)
      ).n;
      const items = await db
        .prepare(
          `SELECT u.id,u.name,u.employee_code,d.name department_name,s.monthly_gross,s.effective_from,s.tax_regime,s.pf_applicable,s.esi_applicable
         FROM users u LEFT JOIN departments d ON d.id=u.department_id
         LEFT JOIN employee_salaries s ON s.id=(SELECT id FROM employee_salaries WHERE user_id=u.id ORDER BY effective_from DESC LIMIT 1)
         WHERE ${clause} ORDER BY u.name,u.id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);
      return send(200, { items, total, limit, offset });
    },
  );
  router.get(
    "/api/admin/employees/:id/salary",
    { perm: "payroll.read" },
    async ({ params, companyId, send }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const history = await db
        .prepare(
          "SELECT * FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC",
        )
        .all(person.id);
      for (const h of history)
        h.lines = await db
          .prepare(
            "SELECT code,name,amount FROM employee_salary_lines WHERE salary_id=? ORDER BY id",
          )
          .all(h.id);
      return send(200, history);
    },
  );
  // Reads and checks a salary request; shared by the preview and the real thing.
  async function salarySpec(companyId, personId, b) {
    const person = await requireOwned(
      db,
      "users",
      personId,
      companyId,
      "employee",
    );
    if (person.role === "super_admin")
      throw new HttpError(
        400,
        "The platform owner is not paid through payroll.",
      );
    const effective = isoDate(b.effective_from, "Effective from");
    if (!effective) throw new HttpError(400, "Effective from is required.");
    const gross = number(b.monthly_gross, "Monthly gross", 1, 10000000);
    const flag = (k, d) => (b[k] === undefined ? d : Number(bool(b[k], k)));
    const regime =
      b.tax_regime === undefined
        ? "new"
        : oneOf(b.tax_regime, "Tax regime", ["new", "old"]);
    const declared =
      b.declared_deductions === undefined
        ? 0
        : number(b.declared_deductions, "Declared deductions", 0, 100000000);
    const components = await listComponents(companyId);
    let built;
    try {
      built = buildSalaryLines(components, gross);
    } catch (e) {
      throw new HttpError(422, e.message);
    }
    const comps = new Map(components.map((c) => [c.id, c]));
    const flags = {
      pf_applicable: flag("pf_applicable", 1),
      esi_applicable: flag("esi_applicable", 0),
      pt_applicable: flag("pt_applicable", 1),
      eps_eligible: flag("eps_eligible", 1),
      tax_regime: regime,
      declared_deductions: declared,
    };
    const engineLines = built.map((l) => {
      const c = comps.get(l.component_id);
      return {
        code: l.code,
        name: l.name,
        amount: l.amount,
        is_basic: Boolean(c.is_basic),
        taxable: Boolean(c.taxable),
        esi_wage: Boolean(c.esi_wage),
      };
    });
    return {
      person,
      effective,
      gross,
      flags,
      built,
      comps,
      engineLines,
      note: optionalString(b.note, "Note", 300),
    };
  }
  const arrearsFor = async (companyId, spec, locked) =>
    computeArrears(app, {
      companyId,
      userId: spec.person.id,
      effective: spec.effective,
      locked,
      lines: spec.engineLines,
      flags: {
        ...spec.flags,
        pf_applicable: Boolean(spec.flags.pf_applicable),
        eps_eligible: Boolean(spec.flags.eps_eligible),
      },
      config: await loadConfig(db, companyId),
    });

  router.post(
    "/api/admin/employees/:id/salary-arrears",
    { perm: "payroll.read" },
    async ({ params, companyId, body, send }) => {
      const spec = await salarySpec(
        companyId,
        integer(Number(params.id)),
        await body(),
      );
      const locked = await lastLockedMonth(companyId);
      if (!locked || spec.effective.slice(0, 7) > locked)
        return send(200, {
          rows: [],
          total_gross: 0,
          total_pf: 0,
          pay_in_month: null,
        });
      return send(200, await arrearsFor(companyId, spec, locked));
    },
  );
  router.post(
    "/api/admin/employees/:id/salary",
    { perm: "payroll.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const b = await body();
      const spec = await salarySpec(companyId, integer(Number(params.id)), b);
      const locked = await lastLockedMonth(companyId);
      const backdated = Boolean(locked) && spec.effective.slice(0, 7) <= locked;
      if (backdated && b.arrears !== true)
        throw new HttpError(
          409,
          `Payroll for ${locked} is already approved. To back-date this revision, confirm that the difference should be paid as arrears in ${nextMonth(locked)}.`,
        );
      const arrears = backdated
        ? await arrearsFor(companyId, spec, locked)
        : null;
      const { person, effective, gross, flags, built, comps } = spec;
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO employee_salaries(company_id,user_id,effective_from,monthly_gross,pf_applicable,esi_applicable,pt_applicable,eps_eligible,tax_regime,declared_deductions,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                effective,
                round(gross),
                flags.pf_applicable,
                flags.esi_applicable,
                flags.pt_applicable,
                flags.eps_eligible,
                flags.tax_regime,
                flags.declared_deductions,
                spec.note,
                user.id,
                nowIso(app),
              )
          ).lastInsertRowid,
        );
        for (const l of built) {
          const c = comps.get(l.component_id);
          await db
            .prepare(
              "INSERT INTO employee_salary_lines(salary_id,component_id,code,name,amount,is_basic,taxable,esi_wage) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              id,
              c.id,
              l.code,
              l.name,
              l.amount,
              c.is_basic,
              c.taxable,
              c.esi_wage,
            );
        }
        if (arrears && arrears.total_gross !== 0) {
          const add = (kind, name, amount, source, taxable) =>
            db
              .prepare(
                "INSERT INTO payroll_adjustments(company_id,user_id,month,kind,name,amount,taxable,note,created_by,created_at,source,source_ref) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                arrears.pay_in_month,
                kind,
                name,
                round(Math.abs(amount)),
                taxable,
                `Back-dated salary revision from ${effective}`,
                user.id,
                nowIso(app),
                source,
                id,
              );
          if (arrears.total_gross > 0) {
            await add(
              "earning",
              arrears.label,
              arrears.total_gross,
              "arrears",
              1,
            );
            if (arrears.total_pf > 0)
              await add(
                "deduction",
                "PF on arrears (employee)",
                arrears.total_pf,
                "arrears_pf",
                0,
              );
          } else
            await add(
              "deduction",
              "Arrears recovery (salary reduced retrospectively)",
              arrears.total_gross,
              "arrears",
              0,
            );
        }
        await audit("salary_set", {
          employeeId: person.id,
          effective_from: effective,
          arrears: arrears
            ? { month: arrears.pay_in_month, months: arrears.rows.length }
            : null,
        });
        return id;
      });
      return send(201, { id, lines: built, arrears });
    },
  );
  router.get(
    "/api/admin/payroll/opening",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const year = query.get("tax_year")
        ? Number(query.get("tax_year"))
        : taxYearOf(new Date(app.clock()).toISOString().slice(0, 7));
      return send(
        200,
        await db
          .prepare(
            "SELECT o.*,u.name employee_name,u.employee_code FROM payroll_opening o JOIN users u ON u.id=o.user_id WHERE o.company_id=? AND o.tax_year=? ORDER BY u.name",
          )
          .all(companyId, year),
      );
    },
  );
  router.post(
    "/api/admin/payroll/opening",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const person = await requireOwned(
        db,
        "users",
        integer(b.user_id),
        companyId,
        "employee",
      );
      const year = number(b.tax_year, "Tax year", 2020, 2100);
      const income = number(
        b.taxable_income,
        "Taxable income so far",
        0,
        1000000000,
      );
      const tds = number(b.tds_deducted, "Tax deducted so far", 0, 1000000000);
      const pt =
        b.pt_deducted === undefined
          ? 0
          : number(b.pt_deducted, "Professional tax so far", 0, 1000000);
      await transaction(async () => {
        await db
          .prepare(
            "INSERT INTO payroll_opening(company_id,user_id,tax_year,taxable_income,tds_deducted,pt_deducted) VALUES(?,?,?,?,?,?) ON CONFLICT (user_id,tax_year) DO UPDATE SET taxable_income=EXCLUDED.taxable_income, tds_deducted=EXCLUDED.tds_deducted, pt_deducted=EXCLUDED.pt_deducted",
          )
          .run(companyId, person.id, year, income, tds, pt);
        await audit("payroll_opening_set", {
          employeeId: person.id,
          tax_year: year,
        });
      });
      return send(200, { ok: true });
    },
  );

  // ---- one-off adjustments --------------------------------------------------------------------------
  router.get(
    "/api/admin/payroll/adjustments",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const month = query.get("month");
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month ?? ""))
        throw new HttpError(400, "Choose a month like 2026-10.");
      return send(
        200,
        await db
          .prepare(
            "SELECT a.*,u.name employee_name,u.employee_code FROM payroll_adjustments a JOIN users u ON u.id=a.user_id WHERE a.company_id=? AND a.month=? ORDER BY u.name,a.id",
          )
          .all(companyId, month),
      );
    },
  );
  const monthLocked = async (companyId, month) => {
    const run = await db
      .prepare("SELECT status FROM payroll_runs WHERE company_id=? AND month=?")
      .get(companyId, month);
    return Boolean(run && run.status !== "draft");
  };
  router.post(
    "/api/admin/payroll/adjustments",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const person = await requireOwned(
        db,
        "users",
        integer(b.user_id),
        companyId,
        "employee",
      );
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(b.month ?? ""))
        throw new HttpError(400, "Choose a month like 2026-10.");
      if (await monthLocked(companyId, b.month))
        throw new HttpError(409, "That month's payroll is already approved.");
      const kind = oneOf(b.kind, "Type", ["earning", "deduction"]);
      const name = string(b.name, "Description", 80);
      const amount = number(b.amount, "Amount", 1, 100000000);
      const taxable =
        b.taxable === undefined ? 1 : Number(bool(b.taxable, "Taxable"));
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO payroll_adjustments(company_id,user_id,month,kind,name,amount,taxable,note,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                person.id,
                b.month,
                kind,
                name,
                round(amount),
                taxable,
                optionalString(b.note, "Note", 300),
                user.id,
                nowIso(app),
              )
          ).lastInsertRowid,
        );
        await audit("payroll_adjustment_added", {
          id,
          employeeId: person.id,
          month: b.month,
          kind,
        });
        return id;
      });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/payroll/adjustments/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const row = await requireOwned(
        db,
        "payroll_adjustments",
        integer(Number(params.id)),
        companyId,
        "adjustment",
      );
      if (await monthLocked(companyId, row.month))
        throw new HttpError(409, "That month's payroll is already approved.");
      await db
        .prepare("DELETE FROM payroll_adjustments WHERE id=?")
        .run(row.id);
      await audit("payroll_adjustment_deleted", {
        id: row.id,
        month: row.month,
      });
      return send(200, { ok: true });
    },
  );

  // ---- bank, PAN, UAN, ESI numbers (encrypted) ---------------------------------------------------------
  router.get(
    "/api/admin/employees/:id/private",
    { perm: "payroll.read" },
    async ({ params, companyId, query, send, audit }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const configured = Boolean(encryptionKey());
      const data = await readPrivate(app, person.id);
      const reveal = query.get("reveal") === "1";
      if (reveal && configured)
        await audit("sensitive_data_viewed", {
          employeeId: person.id,
          fields: Object.keys(data),
        });
      return send(200, {
        encryption_configured: configured,
        data: reveal ? data : maskPrivate(data),
      });
    },
  );
  router.put(
    "/api/admin/employees/:id/private",
    { perm: "payroll.manage" },
    async ({ params, companyId, user, body, send, audit }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const key = encryptionKey();
      if (!key)
        throw new HttpError(
          503,
          "Personal data cannot be stored until the server has DATA_ENCRYPTION_KEY set.",
        );
      const b = await body();
      const data = await readPrivate(app, person.id);
      for (const [field, [pattern, message]] of Object.entries(
        PRIVATE_FIELDS,
      )) {
        if (b[field] === undefined) continue;
        const v =
          typeof b[field] === "string"
            ? b[field].trim().toUpperCase()
            : b[field];
        if (v === "" || v === null) delete data[field];
        else if (
          typeof v !== "string" ||
          !pattern.test(
            field === "bank_name" || field === "account_holder"
              ? b[field].trim()
              : v,
          )
        )
          throw new HttpError(400, `${message}.`);
        else
          data[field] =
            field === "bank_name" || field === "account_holder"
              ? b[field].trim()
              : v;
      }
      await transaction(async () => {
        await db
          .prepare(
            "INSERT INTO employee_private(user_id,company_id,data,updated_by,updated_at) VALUES(?,?,?,?,?) ON CONFLICT (user_id) DO UPDATE SET data=EXCLUDED.data, updated_by=EXCLUDED.updated_by, updated_at=EXCLUDED.updated_at",
          )
          .run(
            person.id,
            companyId,
            encryptJson(data, key),
            user.id,
            nowIso(app),
          );
        await audit("sensitive_data_updated", {
          employeeId: person.id,
          fields: Object.keys(b).filter((k) => k in PRIVATE_FIELDS),
        });
      });
      return send(200, { data: maskPrivate(data) });
    },
  );
  router.get("/api/profile/private", async ({ user, send }) =>
    send(200, {
      encryption_configured: Boolean(encryptionKey()),
      data: maskPrivate(await readPrivate(app, user.id)),
    }),
  );
}
