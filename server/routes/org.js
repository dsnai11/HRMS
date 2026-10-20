import {
  HttpError,
  string,
  optionalString,
  number,
  integer,
  optionalId,
} from "../http.js";
import { requireOwned } from "../scope.js";

const now = () => new Date().toISOString();
const KINDS = {
  branches: {
    label: "branch",
    userColumn: "branch_id",
    fields: ["code", "city", "state", "address"],
    max: { code: 20, city: 80, state: 80, address: 300 },
  },
  departments: {
    label: "department",
    userColumn: "department_id",
    fields: ["code"],
    max: { code: 20 },
  },
  designations: {
    label: "designation",
    userColumn: "designation_id",
    fields: [],
    max: {},
  },
  grades: {
    label: "grade",
    userColumn: "grade_id",
    fields: ["level", "salary_min", "salary_max"],
    max: {},
    numeric: ["level", "salary_min", "salary_max"],
  },
  cost_centres: {
    label: "cost centre",
    userColumn: "cost_centre_id",
    fields: ["code"],
    max: { code: 20 },
  },
  business_units: {
    label: "business unit",
    userColumn: "business_unit_id",
    fields: ["code"],
    max: { code: 20 },
  },
};
const fieldValue = (spec, f, v) =>
  spec.numeric?.includes(f)
    ? v === undefined || v === null || v === ""
      ? null
      : number(v, f, 0, 1e9)
    : optionalString(v, f, spec.max[f]);

export function registerOrg(router, app) {
  const { db, transaction } = app;

  // ---- branches, departments, designations ---------------------------------
  for (const [kind, spec] of Object.entries(KINDS)) {
    router.get(
      `/api/admin/${kind}`,
      { perm: "org.read" },
      async ({ companyId, send }) =>
        send(
          200,
          await db
            .prepare(
              `SELECT t.*,(SELECT COUNT(*) FROM users u WHERE u.${spec.userColumn}=t.id AND u.active=1) employees FROM ${kind} t WHERE t.company_id=? ORDER BY t.name`,
            )
            .all(companyId),
        ),
    );
    router.post(
      `/api/admin/${kind}`,
      { perm: "org.manage" },
      async ({ companyId, body, send, audit }) => {
        const b = await body();
        const name = string(b.name, `${spec.label} name`);
        const extra = spec.fields.map((f) => fieldValue(spec, f, b[f]));
        const id = await transaction(async () => {
          const id = Number(
            (
              await db
                .prepare(
                  `INSERT INTO ${kind}(company_id,name,${spec.fields.map((f) => `${f},`).join("")}created_at) VALUES(?,?,${spec.fields.map(() => "?,").join("")}?)`,
                )
                .run(companyId, name, ...extra, now())
            ).lastInsertRowid,
          );
          await audit(`${spec.label}_created`, { id, name });
          return id;
        });
        return send(201, { id });
      },
    );
    router.patch(
      `/api/admin/${kind}/:id`,
      { perm: "org.manage" },
      async ({ params, companyId, body, send, audit }) => {
        const id = integer(Number(params.id));
        const row = await requireOwned(db, kind, id, companyId, spec.label);
        const b = await body();
        const name = b.name === undefined ? row.name : string(b.name, "Name");
        const active =
          b.active === undefined
            ? row.active
            : typeof b.active === "boolean"
              ? Number(b.active)
              : (() => {
                  throw new HttpError(400, "Active must be true or false.");
                })();
        const values = spec.fields.map((f) =>
          b[f] === undefined ? row[f] : fieldValue(spec, f, b[f]),
        );
        const hi = spec.fields.includes("salary_max") ? "salary_max" : null;
        if (hi) {
          const lo = values[spec.fields.indexOf("salary_min")];
          const up = values[spec.fields.indexOf(hi)];
          if (lo != null && up != null && lo > up)
            throw new HttpError(
              400,
              "The band minimum cannot be above its maximum.",
            );
        }
        await transaction(async () => {
          await db
            .prepare(
              `UPDATE ${kind} SET name=?,active=?${spec.fields.map((f) => `,${f}=?`).join("")} WHERE id=?`,
            )
            .run(name, active, ...values, id);
          await audit(`${spec.label}_updated`, { id, name, active });
        });
        return send(200, { ok: true });
      },
    );
  }

  // Everything an employee form needs, in one call.
  router.get(
    "/api/admin/org",
    { perm: "org.read" },
    async ({ companyId, send }) => {
      const active = (table) =>
        db
          .prepare(
            `SELECT id,name FROM ${table} WHERE company_id=? AND active=1 ORDER BY name`,
          )
          .all(companyId);
      return send(200, {
        branches: await active("branches"),
        departments: await active("departments"),
        designations: await active("designations"),
        grades: await active("grades"),
        cost_centres: await active("cost_centres"),
        business_units: await active("business_units"),
        workplaces: await db
          .prepare(
            "SELECT id,name,branch_id FROM workplaces WHERE company_id=? ORDER BY name",
          )
          .all(companyId),
        managers: await db
          .prepare(
            "SELECT id,name,employee_code FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' ORDER BY name LIMIT 1000",
          )
          .all(companyId),
      });
    },
  );

  // ---- workplaces (geofences) ----------------------------------------------
  router.get(
    "/api/admin/workplaces",
    { perm: "org.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT w.*,b.name branch_name FROM workplaces w LEFT JOIN branches b ON b.id=w.branch_id WHERE w.company_id=? ORDER BY w.name",
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/workplaces",
    { perm: "workplaces.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const name = string(b.name, "Workplace name");
      const lat = number(b.latitude, "Latitude", -90, 90);
      const lon = number(b.longitude, "Longitude", -180, 180);
      const radius = number(b.radius, "Radius", 25, 2000);
      const accuracy = number(
        b.max_accuracy,
        "Maximum GPS uncertainty",
        5,
        Math.min(radius, 100),
      );
      const branchId = optionalId(b.branch_id, "Branch");
      await requireOwned(db, "branches", branchId, companyId, "branch");
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO workplaces(name,latitude,longitude,radius,max_accuracy,company_id,branch_id) VALUES(?,?,?,?,?,?,?)",
              )
              .run(name, lat, lon, radius, accuracy, companyId, branchId)
          ).lastInsertRowid,
        );
        await audit("workplace_created", { id, name });
        return id;
      });
      return send(201, { id });
    },
  );

  // ---- companies (platform owner only) -------------------------------------
  router.get(
    "/api/admin/companies",
    { perm: "companies.manage" },
    async ({ send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT c.*,(SELECT COUNT(*) FROM users u WHERE u.company_id=c.id AND u.active=1) employees FROM companies c ORDER BY c.name",
          )
          .all(),
      ),
  );
  router.post(
    "/api/admin/companies",
    { perm: "companies.manage" },
    async ({ user, body, send }) => {
      const b = await body();
      const name = string(b.name, "Company name");
      const code = string(b.code, "Company code", 10).toUpperCase();
      if (!/^[A-Z0-9]{2,10}$/.test(code))
        throw new HttpError(
          400,
          "Company code must be 2–10 letters or digits.",
        );
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO companies(name,code,created_at) VALUES(?,?,?)",
              )
              .run(name, code, now())
          ).lastInsertRowid,
        );
        await app.audit(user, "company_created", { id, name, code }, id);
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/companies/:id",
    { perm: "companies.manage" },
    async ({ user, params, body, send }) => {
      const id = integer(Number(params.id));
      const row = await db
        .prepare("SELECT * FROM companies WHERE id=?")
        .get(id);
      if (!row) throw new HttpError(404, "Company not found.");
      const b = await body();
      const name =
        b.name === undefined ? row.name : string(b.name, "Company name");
      if (b.active !== undefined && typeof b.active !== "boolean")
        throw new HttpError(400, "Active must be true or false.");
      const active = b.active === undefined ? row.active : Number(b.active);
      if (!active && id === user.company_id)
        throw new HttpError(409, "You cannot deactivate your own company.");
      await transaction(async () => {
        await db
          .prepare("UPDATE companies SET name=?,active=? WHERE id=?")
          .run(name, active, id);
        if (!active)
          await db
            .prepare(
              "DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE company_id=?)",
            )
            .run(id);
        await app.audit(user, "company_updated", { id, name, active }, id);
      });
      return send(200, { ok: true });
    },
  );
}
