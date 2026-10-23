import { passwordHash, passwordHashAsync } from "../db.js";
import { cleanCustom } from "./people-plus.js";
import {
  HttpError,
  string,
  optionalString,
  password,
  email,
  integer,
  optionalId,
  isoDate,
  oneOf,
} from "../http.js";
import { ROLES, assignableRoles, can } from "../rbac.js";
import { branchScope, inBranchScope, requireOwned } from "../scope.js";

const GENDERS = ["male", "female", "other"];
const EMPLOYMENT = [
  "full_time",
  "part_time",
  "contract",
  "intern",
  "consultant",
];
const phone = (v, label) => {
  const s = optionalString(v, label, 20);
  if (s !== null && !/^[0-9+()\-\s]{7,20}$/.test(s))
    throw new HttpError(400, `${label} must be a valid phone number.`);
  return s;
};
const choice = (allowed) => (v, label) =>
  v === undefined || v === null || v === "" ? null : oneOf(v, label, allowed);

// Plain profile columns: name -> [label, parser].
const PROFILE = {
  employee_code: ["Employee code", (v, l) => optionalString(v, l, 30)],
  phone: ["Phone", phone],
  date_of_birth: ["Date of birth", isoDate],
  gender: ["Gender", choice(GENDERS)],
  date_of_joining: ["Date of joining", isoDate],
  employment_type: ["Employment type", choice(EMPLOYMENT)],
  address: ["Address", (v, l) => optionalString(v, l, 300)],
  division: ["Division", (v, l) => optionalString(v, l, 80)],
  section: ["Section", (v, l) => optionalString(v, l, 80)],
  employee_level: ["Employee level", (v, l) => optionalString(v, l, 40)],
  job_title_code: ["Job title code", (v, l) => optionalString(v, l, 30)],
  emergency_name: [
    "Emergency contact name",
    (v, l) => optionalString(v, l, 100),
  ],
  emergency_phone: ["Emergency contact phone", phone],
  emergency_relation: [
    "Emergency contact relation",
    (v, l) => optionalString(v, l, 50),
  ],
};
const SELF_EDITABLE = [
  "phone",
  "address",
  "emergency_name",
  "emergency_phone",
  "emergency_relation",
];

const SELECT = `u.id,u.name,u.email,u.role,u.employee_code,u.phone,u.active,u.must_change_password,
  u.workplace_id,w.name workplace_name,u.branch_id,b.name branch_name,u.department_id,d.name department_name,
  u.designation_id,g.name designation_name,u.manager_id,m.name manager_name,u.date_of_joining,u.employment_type,
  u.grade_id,gr.name grade_name,u.cost_centre_id,cc.name cost_centre_name,u.business_unit_id,bu.name business_unit_name,u.custom,
  u.custom_role_id,cr.name custom_role_name,u.division,u.section,u.employee_level,u.job_title_code`;
const FULL = `${SELECT},u.date_of_birth,u.gender,u.address,u.emergency_name,u.emergency_phone,u.emergency_relation,u.company_id`;
const JOINS = `FROM users u LEFT JOIN workplaces w ON w.id=u.workplace_id LEFT JOIN branches b ON b.id=u.branch_id
  LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN designations g ON g.id=u.designation_id LEFT JOIN users m ON m.id=u.manager_id
  LEFT JOIN grades gr ON gr.id=u.grade_id LEFT JOIN cost_centres cc ON cc.id=u.cost_centre_id LEFT JOIN business_units bu ON bu.id=u.business_unit_id
  LEFT JOIN custom_roles cr ON cr.id=u.custom_role_id`;

function canManage(caller, target) {
  if (caller.role === "super_admin") return true;
  if (caller.role === "admin") return target.role !== "super_admin";
  return target.role === "employee";
}

export function registerEmployees(router, app) {
  const { db, transaction } = app;

  // A custom role must be one of this company's; any other role clears it.
  const customRoleId = async (role, b, companyId) => {
    if (role !== "custom") return null;
    const id = optionalId(b.custom_role_id, "Custom role");
    if (
      !id ||
      !(await db
        .prepare("SELECT id FROM custom_roles WHERE id=? AND company_id=?")
        .get(id, companyId))
    )
      throw new HttpError(400, "Choose one of your company's custom roles.");
    return id;
  };

  const profileValues = (b, only = Object.keys(PROFILE)) => {
    const out = {};
    for (const key of only)
      if (b[key] !== undefined) {
        const [label, parse] = PROFILE[key];
        out[key] = parse(b[key], label);
      }
    return out;
  };
  // Organisation references must belong to the same company.
  async function references(b, companyId) {
    const out = {};
    const tables = {
      workplace_id: ["workplaces", "workplace"],
      branch_id: ["branches", "branch"],
      department_id: ["departments", "department"],
      designation_id: ["designations", "designation"],
      grade_id: ["grades", "grade"],
      cost_centre_id: ["cost_centres", "cost centre"],
      business_unit_id: ["business_units", "business unit"],
    };
    for (const [key, [table, label]] of Object.entries(tables))
      if (b[key] !== undefined) {
        out[key] = optionalId(b[key], label);
        await requireOwned(db, table, out[key], companyId, label);
      }
    return out;
  }
  async function checkManager(managerId, selfId, companyId) {
    if (managerId === null) return;
    const manager = await requireOwned(
      db,
      "users",
      managerId,
      companyId,
      "reporting manager",
    );
    if (!manager.active || manager.role === "super_admin")
      throw new HttpError(400, "Select an active reporting manager.");
    // Walk up the chain: the new manager must not report (directly or not) to this person.
    let cursor = manager;
    for (let i = 0; cursor && i < 100; i++) {
      if (cursor.id === selfId)
        throw new HttpError(
          400,
          "That would make the reporting line circular.",
        );
      cursor = cursor.manager_id
        ? await db
            .prepare("SELECT id,manager_id FROM users WHERE id=?")
            .get(cursor.manager_id)
        : null;
    }
  }
  async function nextCode(companyId) {
    const { n } = await db
      .prepare(
        "SELECT MAX(CAST(SUBSTRING(employee_code FROM 2) AS INTEGER)) n FROM users WHERE company_id=? AND employee_code ~ '^E[0-9]{1,9}$'",
      )
      .get(companyId);
    return `E${String((n ?? 0) + 1).padStart(4, "0")}`;
  }
  const visible = (user) =>
    user.role === "super_admin" ? "" : " AND u.role<>'super_admin'";

  router.get(
    "/api/admin/employees",
    { perm: "employees.read" },
    async ({ user, companyId, query, send }) => {
      const where = ["u.company_id=?"],
        params = [companyId];
      const q = query.get("q")?.trim().toLowerCase();
      if (q) {
        where.push(
          "(lower(u.name) LIKE ? OR lower(u.email) LIKE ? OR lower(u.employee_code) LIKE ?)",
        );
        params.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      for (const key of ["department_id", "branch_id", "manager_id"]) {
        const v = query.get(key);
        if (v) {
          where.push(`u.${key}=?`);
          params.push(integer(Number(v)));
        }
      }
      if (query.get("active") === "1" || query.get("active") === "0") {
        where.push("u.active=?");
        params.push(Number(query.get("active")));
      }
      const scope = branchScope(user);
      const clause = where.join(" AND ") + visible(user) + scope.sql;
      params.push(...scope.params);
      const limit = Math.min(
        Math.max(Number(query.get("limit")) || 50, 1),
        200,
      );
      const offset = Math.max(Number(query.get("offset")) || 0, 0);
      const total = (
        await db
          .prepare(`SELECT COUNT(*) n FROM users u WHERE ${clause}`)
          .get(...params)
      ).n;
      const items = await db
        .prepare(
          `SELECT ${SELECT} ${JOINS} WHERE ${clause} ORDER BY u.name, u.id LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);
      return send(200, { items, total, limit, offset });
    },
  );

  router.get(
    "/api/admin/employees/:id",
    { perm: "employees.read" },
    async ({ user, params, companyId, send }) => {
      const row = await db
        .prepare(
          `SELECT ${FULL} ${JOINS} WHERE u.id=? AND u.company_id=?${visible(user)}`,
        )
        .get(integer(Number(params.id)), companyId);
      if (!row || !inBranchScope(user, row.branch_id))
        throw new HttpError(404, "Employee not found.");
      return send(200, row);
    },
  );

  // Shared with hiring: creates an employee from a request-shaped body.
  async function createEmployee(user, companyId, b, audit) {
    const name = string(b.name, "Name");
    const mail = email(b.email);
    const pw = password(b.password);
    const role = b.role === undefined ? "employee" : b.role;
    if (!ROLES.includes(role) || !assignableRoles(user).includes(role))
      throw new HttpError(403, "You cannot assign that role.");
    const roleId = await customRoleId(role, b, companyId);
    const profile = profileValues(b);
    const refs = await references(b, companyId);
    if (user.branch_scope?.length && !inBranchScope(user, refs.branch_id ?? null))
      throw new HttpError(403, "Choose one of the branches you look after.");
    const custom =
      b.custom === undefined
        ? null
        : await cleanCustom(db, companyId, b.custom);
    const managerId = optionalId(b.manager_id, "Reporting manager");
    await checkManager(managerId, null, companyId);
    if (await db.prepare("SELECT id FROM users WHERE email=?").get(mail))
      throw new HttpError(409, "That email is already registered.");
    const hash = await passwordHashAsync(pw);
    return transaction(async () => {
      const code = profile.employee_code ?? (await nextCode(companyId));
      if (
        await db
          .prepare(
            "SELECT id FROM users WHERE company_id=? AND employee_code=?",
          )
          .get(companyId, code)
      )
        throw new HttpError(409, "That employee code is already in use.");
      const cols = {
        ...profile,
        employee_code: code,
        ...refs,
        manager_id: managerId,
        ...(roleId ? { custom_role_id: roleId } : {}),
        ...(custom ? { custom: JSON.stringify(custom) } : {}),
      };
      const keys = Object.keys(cols);
      const id = Number(
        (
          await db
            .prepare(
              `INSERT INTO users(name,email,password_hash,role,company_id,must_change_password,created_at${keys.map((k) => `,${k}`).join("")}) VALUES(?,?,?,?,?,1,?${keys.map(() => ",?").join("")})`,
            )
            .run(
              name,
              mail,
              hash,
              role,
              companyId,
              new Date().toISOString(),
              ...keys.map((k) => cols[k]),
            )
        ).lastInsertRowid,
      );
      await audit("employee_created", {
        id,
        name,
        role,
        workplaceId: refs.workplace_id ?? null,
      });
      return id;
    });
  }
  app.createEmployee = createEmployee;

  router.post(
    "/api/admin/employees",
    { perm: "employees.write" },
    async ({ user, companyId, body, send, audit }) =>
      send(201, {
        id: await createEmployee(user, companyId, await body(), audit),
      }),
  );

  router.patch(
    "/api/admin/employees/:id",
    { perm: "employees.write" },
    async ({ user, params, companyId, body, send, audit }) => {
      const id = integer(Number(params.id));
      const b = await body();
      const target = await db
        .prepare("SELECT * FROM users WHERE id=? AND company_id=?")
        .get(id, companyId);
      if (
        !target ||
        (target.role === "super_admin" && user.role !== "super_admin") ||
        !inBranchScope(user, target.branch_id)
      )
        throw new HttpError(404, "Employee not found.");
      if (!canManage(user, target))
        throw new HttpError(403, "You cannot edit this person.");
      const set = {};
      if (b.name !== undefined) set.name = string(b.name, "Name");
      if (b.active !== undefined) {
        if (typeof b.active !== "boolean")
          throw new HttpError(400, "Active must be true or false.");
        set.active = Number(b.active);
      }
      if (b.role !== undefined) {
        if (
          !can(user, "roles.assign") ||
          !ROLES.includes(b.role) ||
          !assignableRoles(user).includes(b.role)
        )
          throw new HttpError(403, "You cannot assign that role.");
        set.role = b.role;
        set.custom_role_id = await customRoleId(b.role, b, companyId);
      }
      if (
        id === user.id &&
        (set.active === 0 ||
          (set.role &&
            (set.role !== user.role ||
              (set.custom_role_id ?? null) !== (user.custom_role_id ?? null))))
      )
        throw new HttpError(
          409,
          "You cannot change your own role or deactivate yourself.",
        );
      Object.assign(set, profileValues(b), await references(b, companyId));
      if (set.branch_id !== undefined && !inBranchScope(user, set.branch_id))
        throw new HttpError(403, "Choose one of the branches you look after.");
      if (b.custom !== undefined)
        set.custom = JSON.stringify(
          await cleanCustom(
            db,
            companyId,
            b.custom,
            JSON.parse(target.custom || "{}"),
          ),
        );
      if (set.employee_code && set.employee_code !== target.employee_code) {
        if (
          await db
            .prepare(
              "SELECT id FROM users WHERE company_id=? AND employee_code=? AND id<>?",
            )
            .get(companyId, set.employee_code, id)
        )
          throw new HttpError(409, "That employee code is already in use.");
      }
      if (b.manager_id !== undefined) {
        set.manager_id = optionalId(b.manager_id, "Reporting manager");
        await checkManager(set.manager_id, id, companyId);
      }
      if (b.password !== undefined) password(b.password);
      const leaving = set.active === 0 && target.active;
      const moving =
        "workplace_id" in set && set.workplace_id !== target.workplace_id;
      if (
        (leaving || moving) &&
        (await db
          .prepare("SELECT id FROM shifts WHERE user_id=? AND out_at IS NULL")
          .get(id))
      )
        throw new HttpError(
          409,
          "Employee must punch out before deactivation or reassignment.",
        );
      if (
        leaving &&
        (await db
          .prepare(
            "SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1",
          )
          .get(id))
      )
        throw new HttpError(
          409,
          "Reassign this person's direct reports before deactivating them.",
        );
      const keys = Object.keys(set);
      await transaction(async () => {
        if (keys.length)
          await db
            .prepare(
              `UPDATE users SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
            )
            .run(...keys.map((k) => set[k]), id);
        if (b.password !== undefined)
          await db
            .prepare(
              "UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?",
            )
            .run(passwordHash(b.password), id);
        if (set.active === 0 || b.password !== undefined || set.role)
          await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
        await audit("employee_updated", {
          id,
          fields: keys,
          passwordReset: b.password !== undefined,
        });
      });
      return send(200, { ok: true });
    },
  );

  // ---- own profile ---------------------------------------------------------
  router.get("/api/profile", async ({ user, send }) =>
    send(
      200,
      await db.prepare(`SELECT ${FULL} ${JOINS} WHERE u.id=?`).get(user.id),
    ),
  );
  router.patch("/api/profile", async ({ user, body, send, audit }) => {
    const set = profileValues(await body(), SELF_EDITABLE);
    const keys = Object.keys(set);
    if (!keys.length) throw new HttpError(400, "Nothing to update.");
    await db
      .prepare(
        `UPDATE users SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
      )
      .run(...keys.map((k) => set[k]), user.id);
    await audit("profile_updated", { fields: keys });
    return send(200, { ok: true });
  });
}
