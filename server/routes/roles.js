import { HttpError, integer, string } from "../http.js";
import { GRANTABLE, permissionsFor } from "../rbac.js";

const BUILT_IN = ["admin", "hr", "payroll", "employee"];
// Rights that need another to be usable. Every staff page reads the organisation
// lists (departments, branches, workplaces), so every custom role can see them.
const IMPLIES = {
  "employees.write": ["employees.read"],
  "changes.manage": ["employees.read"],
  "org.manage": ["org.read"],
  "leave.manage": ["leave.read"],
  "leave.approve": ["leave.read"],
  "payroll.manage": ["payroll.read"],
  "payroll.approve": ["payroll.read"],
};
// Standard roles for an HR department. An administrator adds them in one step and
// can then change their rights or limit them to branches like any custom role.
export const HR_TEMPLATES = [
  {
    name: "HR Manager",
    description: "Runs HR: people, leave, hiring, exits, performance and policies. No payroll.",
    permissions: [
      "employees.read", "employees.write", "changes.manage", "org.read", "org.manage",
      "attendance.read", "attendance.import", "devices.manage", "leave.read",
      "leave.approve", "leave.manage", "recruitment.manage", "credit.manage",
      "exit.manage", "assets.manage", "performance.manage", "announcements.manage",
      "policies.manage", "helpdesk.manage", "bot.manage", "insights.read", "security.read",
    ],
  },
  {
    name: "HR Executive",
    description: "Day-to-day HR: employee records, attendance, leave approvals and the helpdesk.",
    permissions: [
      "employees.read", "employees.write", "attendance.read", "devices.manage",
      "leave.read", "leave.approve", "helpdesk.manage", "announcements.manage",
    ],
  },
  {
    name: "Branch HR",
    description: "HR for one or more branches. Limit it to branches after adding it.",
    permissions: [
      "employees.read", "employees.write", "attendance.read", "devices.manage",
      "leave.read", "leave.approve", "helpdesk.manage",
    ],
  },
  {
    name: "Recruiter",
    description: "Openings, candidates, interviews, offers and credit checks.",
    permissions: ["employees.read", "recruitment.manage", "credit.manage"],
  },
  {
    name: "Onboarding & Exits",
    description: "Joining tasks, assets, probation, resignations and settlements.",
    permissions: ["employees.read", "employees.write", "changes.manage", "assets.manage", "exit.manage"],
  },
  {
    name: "Attendance Officer",
    description: "Attendance records and imports, phone approvals, the muster and leave balances.",
    permissions: ["employees.read", "attendance.read", "attendance.import", "devices.manage", "leave.read"],
  },
  {
    name: "Payroll Executive",
    description: "Prepares payroll. Cannot approve a payroll run.",
    permissions: ["employees.read", "attendance.read", "leave.read", "payroll.read", "payroll.manage"],
  },
  {
    name: "Payroll Approver",
    description: "Reviews and approves payroll runs prepared by others.",
    permissions: ["employees.read", "payroll.read", "payroll.approve"],
  },
  {
    name: "HR Helpdesk",
    description: "Answers employee questions, posts announcements and policies, runs Ask Laxmi.",
    permissions: ["employees.read", "helpdesk.manage", "announcements.manage", "policies.manage", "bot.manage"],
  },
  {
    name: "Performance Lead",
    description: "Review cycles, goals, KRAs and 360° feedback rounds.",
    permissions: ["employees.read", "performance.manage", "insights.read"],
  },
  {
    name: "HR Viewer",
    description: "Read-only: employee records, attendance, leave and dashboards.",
    permissions: ["employees.read", "attendance.read", "leave.read", "insights.read"],
  },
];
const withImplied = (list) => [
  ...new Set(["org.read", ...list, ...list.flatMap((p) => IMPLIES[p] ?? [])]),
];

// Roles and rights: the fixed roles for reference, and roles an administrator
// defines by picking permissions.
export function registerRoles(router, app) {
  const { db } = app;
  const nowIso = () => new Date(app.clock()).toISOString();

  const clean = (b) => {
    const name = string(b.name, "Role name", 60);
    if (BUILT_IN.includes(name.toLowerCase()))
      throw new HttpError(409, "That name belongs to a built-in role.");
    const list = Array.isArray(b.permissions) ? b.permissions : [];
    const permissions = [...new Set(list)];
    const unknown = permissions.filter((p) => !GRANTABLE[p]);
    if (unknown.length)
      throw new HttpError(400, `Unknown permission: ${unknown.join(", ")}.`);
    if (!permissions.length)
      throw new HttpError(400, "Choose at least one permission.");
    const description =
      typeof b.description === "string" ? b.description.trim().slice(0, 300) : "";
    return {
      name,
      description,
      permissions: JSON.stringify(withImplied(permissions)),
    };
  };
  // Branches the role is limited to; none means the whole company.
  const branches = async (b, companyId) => {
    const ids = [
      ...new Set(
        (Array.isArray(b.branch_ids) ? b.branch_ids : []).map((x) =>
          integer(Number(x)),
        ),
      ),
    ];
    for (const id of ids)
      if (
        !(await db
          .prepare("SELECT id FROM branches WHERE id=? AND company_id=?")
          .get(id, companyId))
      )
        throw new HttpError(400, "Choose your company's branches.");
    return JSON.stringify(ids);
  };
  const owned = async (id, companyId) => {
    const r = await db
      .prepare("SELECT * FROM custom_roles WHERE id=? AND company_id=?")
      .get(integer(Number(id)), companyId);
    if (!r) throw new HttpError(404, "Role not found.");
    return r;
  };
  const nameTaken = async (companyId, name, except = 0) =>
    db
      .prepare(
        "SELECT id FROM custom_roles WHERE company_id=? AND lower(name)=lower(?) AND id<>?",
      )
      .get(companyId, name, except);

  router.get(
    "/api/admin/roles",
    { perm: "roles.assign" },
    async ({ companyId, send }) => {
      const counts = await db
        .prepare(
          "SELECT role,custom_role_id,COUNT(*) n FROM users WHERE company_id=? AND active=1 GROUP BY role,custom_role_id",
        )
        .all(companyId);
      const members = (role, id = null) =>
        counts
          .filter(
            (c) =>
              c.role === role && (id === null || c.custom_role_id === id),
          )
          .reduce((n, c) => n + Number(c.n), 0);
      const custom = await db
        .prepare(
          "SELECT id,name,description,permissions,branch_ids,updated_at FROM custom_roles WHERE company_id=? ORDER BY lower(name)",
        )
        .all(companyId);
      return send(200, {
        permissions: Object.entries(GRANTABLE).map(([key, [group, label]]) => ({
          key,
          group,
          label,
        })),
        built_in: BUILT_IN.map((role) => ({
          role,
          permissions: permissionsFor(role),
          members: members(role),
        })),
        custom: custom.map((r) => ({
          ...r,
          permissions: JSON.parse(r.permissions),
          branch_ids: JSON.parse(r.branch_ids),
          members: members("custom", r.id),
        })),
      });
    },
  );
  router.post(
    "/api/admin/roles",
    { perm: "roles.assign" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const r = clean(b);
      const scope = await branches(b, companyId);
      if (await nameTaken(companyId, r.name))
        throw new HttpError(409, "A role with that name already exists.");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO custom_roles(company_id,name,description,permissions,branch_ids,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              r.name,
              r.description,
              r.permissions,
              scope,
              user.id,
              nowIso(),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("role_created", { id, name: r.name });
      return send(201, { id });
    },
  );
  router.get(
    "/api/admin/roles/templates",
    { perm: "roles.assign" },
    async ({ send }) => send(200, HR_TEMPLATES),
  );
  // Adds the chosen standard HR roles (all when none are named); existing names are kept.
  router.post(
    "/api/admin/roles/templates",
    { perm: "roles.assign" },
    async ({ user, companyId, body, send, audit }) => {
      const wanted = (await body()).names;
      const list = HR_TEMPLATES.filter(
        (t) => !Array.isArray(wanted) || !wanted.length || wanted.includes(t.name),
      );
      let created = 0;
      for (const t of list) {
        if (await nameTaken(companyId, t.name)) continue;
        await db
          .prepare(
            "INSERT INTO custom_roles(company_id,name,description,permissions,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            companyId,
            t.name,
            t.description,
            JSON.stringify(withImplied(t.permissions)),
            user.id,
            nowIso(),
            nowIso(),
          );
        created += 1;
      }
      await audit("roles_templates_added", { created });
      return send(201, { created });
    },
  );
  // A change applies from each member's next request; nobody needs to sign in again.
  router.patch(
    "/api/admin/roles/:id",
    { perm: "roles.assign" },
    async ({ params, companyId, body, send, audit }) => {
      const role = await owned(params.id, companyId);
      const b = await body();
      const r = clean(b);
      const scope = await branches(b, companyId);
      if (await nameTaken(companyId, r.name, role.id))
        throw new HttpError(409, "A role with that name already exists.");
      await db
        .prepare(
          "UPDATE custom_roles SET name=?,description=?,permissions=?,branch_ids=?,updated_at=? WHERE id=?",
        )
        .run(r.name, r.description, r.permissions, scope, nowIso(), role.id);
      await audit("role_updated", { id: role.id, name: r.name });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/admin/roles/:id",
    { perm: "roles.assign" },
    async ({ params, companyId, send, audit }) => {
      const role = await owned(params.id, companyId);
      const used = await db
        .prepare("SELECT COUNT(*) n FROM users WHERE custom_role_id=?")
        .get(role.id);
      if (Number(used.n))
        throw new HttpError(
          409,
          `${used.n} ${Number(used.n) === 1 ? "person has" : "people have"} this role. Give them another role first.`,
        );
      await db.prepare("DELETE FROM custom_roles WHERE id=?").run(role.id);
      await audit("role_deleted", { id: role.id, name: role.name });
      return send(200, { ok: true });
    },
  );
}
