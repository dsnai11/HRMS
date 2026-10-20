import {
  HttpError,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

const FIELD_TYPES = ["text", "number", "date", "select"];
const LEVELS = ["beginner", "intermediate", "expert"];

/** Validates custom field values against the company's definitions. */
export async function cleanCustom(
  db,
  companyId,
  input,
  existing = {},
  enforceRequired = true,
) {
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new HttpError(400, "Custom fields are not valid.");
  const defs = await db
    .prepare(
      "SELECT * FROM custom_fields WHERE company_id=? AND active=1 ORDER BY position,id",
    )
    .all(companyId);
  const out = { ...existing };
  for (const d of defs) {
    if (!(d.key in input)) continue;
    const v = input[d.key];
    if (v === "" || v === null) {
      delete out[d.key];
      continue;
    }
    if (d.type === "number") {
      const n = Number(v);
      if (!Number.isFinite(n))
        throw new HttpError(400, `${d.label} must be a number.`);
      out[d.key] = n;
    } else if (d.type === "date") out[d.key] = isoDate(v, d.label);
    else if (d.type === "select") {
      if (!JSON.parse(d.options).includes(v))
        throw new HttpError(
          400,
          `${d.label}: choose one of the listed options.`,
        );
      out[d.key] = v;
    } else out[d.key] = string(v, d.label, 300);
  }
  if (enforceRequired)
    for (const d of defs)
      if (d.required && (out[d.key] === undefined || out[d.key] === ""))
        throw new HttpError(400, `${d.label} is required.`);
  return out;
}

const SECTIONS = {
  education: {
    table: "employee_education",
    verifiable: true,
    parse: (b) => ({
      degree: string(b.degree, "Degree", 120),
      institute: optionalString(b.institute, "Institute", 150) || null,
      year: optionalString(b.year, "Year", 4) || null,
      score: optionalString(b.score, "Score", 30) || null,
    }),
  },
  experience: {
    table: "employee_experience",
    verifiable: true,
    parse: (b) => ({
      employer: string(b.employer, "Employer", 150),
      role: optionalString(b.role, "Role", 120) || null,
      from_date: optionalString(b.from_date, "From", 10) || null,
      to_date: optionalString(b.to_date, "To", 10) || null,
      reason: optionalString(b.reason, "Reason for leaving", 200) || null,
    }),
  },
  skills: {
    table: "employee_skills",
    verifiable: false,
    parse: (b) => ({
      skill: string(b.skill, "Skill", 60),
      level: oneOf(b.level ?? "intermediate", "Level", LEVELS),
    }),
  },
  certifications: {
    table: "employee_certifications",
    verifiable: true,
    parse: (b) => ({
      name: string(b.name, "Certification", 150),
      issuer: optionalString(b.issuer, "Issued by", 150) || null,
      issued_on: isoDate(b.issued_on, "Issued on"),
      expires_on: isoDate(b.expires_on, "Expires on"),
    }),
  },
};

export function registerPeoplePlus(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);

  // ---- custom fields --------------------------------------------------------------------------
  router.get("/api/custom-fields", async ({ user, send }) =>
    send(
      200,
      (
        await db
          .prepare(
            "SELECT * FROM custom_fields WHERE company_id=? AND active=1 ORDER BY position,id",
          )
          .all(user.company_id)
      ).map((d) => ({
        ...d,
        options: JSON.parse(d.options),
        required: Boolean(d.required),
      })),
    ),
  );
  router.get(
    "/api/admin/custom-fields",
    { perm: "org.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        (
          await db
            .prepare(
              "SELECT * FROM custom_fields WHERE company_id=? ORDER BY active DESC,position,id",
            )
            .all(companyId)
        ).map((d) => ({ ...d, options: JSON.parse(d.options) })),
      ),
  );
  const fieldValues = (b, cur = {}) => {
    const type =
      b.type === undefined
        ? (cur.type ?? "text")
        : oneOf(b.type, "Type", FIELD_TYPES);
    let options = cur.options ? JSON.parse(cur.options) : [];
    if (b.options !== undefined) {
      options = (
        Array.isArray(b.options) ? b.options : String(b.options).split(",")
      )
        .map((o) => String(o).trim())
        .filter(Boolean);
      if (options.length > 30)
        throw new HttpError(400, "Add up to 30 options.");
    }
    if (type === "select" && options.length < 2)
      throw new HttpError(400, "A choice field needs at least two options.");
    return {
      label: b.label === undefined ? cur.label : string(b.label, "Label", 80),
      type,
      options: JSON.stringify(options),
      required:
        b.required === undefined ? (cur.required ?? 0) : b.required ? 1 : 0,
      active: b.active === undefined ? (cur.active ?? 1) : b.active ? 1 : 0,
      position:
        b.position === undefined
          ? (cur.position ?? 0)
          : Math.round(number(b.position, "Order", 0, 1000)),
    };
  };
  router.post(
    "/api/admin/custom-fields",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const v = fieldValues(b);
      if (!v.label) throw new HttpError(400, "Give the field a label.");
      const key = v.label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_|_$/g, "")
        .slice(0, 40);
      if (!key) throw new HttpError(400, "The label needs letters or numbers.");
      if (
        await db
          .prepare("SELECT id FROM custom_fields WHERE company_id=? AND key=?")
          .get(companyId, key)
      )
        throw new HttpError(409, "A field with that name already exists.");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO custom_fields(company_id,key,label,type,options,required,active,position,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              key,
              v.label,
              v.type,
              v.options,
              v.required,
              v.active,
              v.position,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("custom_field_added", { id, key });
      return send(201, { id, key });
    },
  );
  router.patch(
    "/api/admin/custom-fields/:id",
    { perm: "org.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const d = await owned("custom_fields", params.id, companyId, "field");
      const v = fieldValues(await body(), d);
      await db
        .prepare(
          "UPDATE custom_fields SET label=?,type=?,options=?,required=?,active=?,position=? WHERE id=?",
        )
        .run(
          v.label,
          v.type,
          v.options,
          v.required,
          v.active,
          v.position,
          d.id,
        );
      await audit("custom_field_updated", { id: d.id });
      return send(200, { ok: true });
    },
  );

  // ---- renaming terms ---------------------------------------------------------------------------
  router.put(
    "/api/admin/labels",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const map = {};
      for (const [k, v] of Object.entries(b.labels ?? {})) {
        if (!/^[A-Za-z][A-Za-z ]{1,30}$/.test(k)) continue;
        const to = optionalString(v, "Name", 40);
        if (to && to !== k) map[k] = to;
      }
      if (Object.keys(map).length > 40)
        throw new HttpError(400, "Rename up to 40 terms.");
      await db
        .prepare("UPDATE companies SET labels=? WHERE id=?")
        .run(JSON.stringify(map), companyId);
      await audit("labels_saved", { count: Object.keys(map).length });
      return send(200, { labels: map });
    },
  );

  // ---- organisation chart ----------------------------------------------------------------------
  router.get("/api/org-chart", async ({ user, send }) => {
    const rows = await db
      .prepare(
        `SELECT u.id,u.name,u.manager_id,u.employee_code,g.name designation,d.name department
         FROM users u LEFT JOIN designations g ON g.id=u.designation_id LEFT JOIN departments d ON d.id=u.department_id
         WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin' ORDER BY u.name LIMIT 5000`,
      )
      .all(user.company_id);
    const ids = new Set(rows.map((r) => r.id));
    return send(200, {
      me: user.id,
      people: rows.map((r) => ({
        ...r,
        manager_id: ids.has(r.manager_id) ? r.manager_id : null,
      })),
    });
  });

  // ---- 360 profile -------------------------------------------------------------------------------
  async function target(user, userId) {
    const id =
      userId === undefined || userId === null
        ? user.id
        : integer(Number(userId));
    const person = await owned("users", id, user.company_id, "employee");
    const self = id === user.id;
    const hr = can(user, "employees.write");
    if (
      !self &&
      !hr &&
      !can(user, "employees.read") &&
      !(await mayDecide(app, user, id))
    )
      throw new HttpError(403, "You cannot see this profile.");
    return { person, self, hr };
  }
  router.get("/api/profile360", async ({ user, query, send }) => {
    const { person } = await target(user, query.get("user_id") ?? undefined);
    const out = { employee: { id: person.id, name: person.name } };
    for (const [key, s] of Object.entries(SECTIONS))
      out[key] = await db
        .prepare(`SELECT * FROM ${s.table} WHERE user_id=? ORDER BY id`)
        .all(person.id);
    const defs = await db
      .prepare(
        "SELECT * FROM custom_fields WHERE company_id=? AND active=1 ORDER BY position,id",
      )
      .all(person.company_id);
    const values = JSON.parse(person.custom || "{}");
    out.custom = defs.map((d) => ({
      key: d.key,
      label: d.label,
      type: d.type,
      value: values[d.key] ?? null,
    }));
    return send(200, out);
  });
  router.post(
    "/api/profile360/:section",
    async ({ user, params, body, send, audit }) => {
      const s = SECTIONS[params.section];
      if (!s) throw new HttpError(404, "Unknown section.");
      const b = await body();
      const { person, hr } = await target(user, b.user_id);
      if (person.id !== user.id && !hr)
        throw new HttpError(403, "Only HR can add to someone else's profile.");
      const v = s.parse(b);
      const cols = Object.keys(v);
      const verified = s.verifiable && hr ? [user.id, nowIso()] : [null, null];
      if (params.section === "skills") {
        if (
          await db
            .prepare(
              "SELECT id FROM employee_skills WHERE user_id=? AND lower(skill)=lower(?)",
            )
            .get(person.id, v.skill)
        )
          throw new HttpError(409, "That skill is already listed.");
      }
      const id = Number(
        (
          await db
            .prepare(
              `INSERT INTO ${s.table}(company_id,user_id,${cols.join(",")},added_by,${s.verifiable ? "verified_by,verified_at," : ""}created_at) VALUES(?,?,${cols.map(() => "?").join(",")},?,${s.verifiable ? "?,?," : ""}?)`,
            )
            .run(
              person.company_id,
              person.id,
              ...cols.map((c) => v[c]),
              user.id,
              ...(s.verifiable ? verified : []),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("profile360_added", {
        section: params.section,
        employeeId: person.id,
        id,
      });
      return send(201, { id });
    },
  );
  async function entry(user, params) {
    const s = SECTIONS[params.section];
    if (!s) throw new HttpError(404, "Unknown section.");
    const row = await owned(s.table, params.id, user.company_id, "entry");
    return { s, row };
  }
  router.delete(
    "/api/profile360/:section/:id",
    async ({ user, params, send, audit }) => {
      const { s, row } = await entry(user, params);
      const hr = can(user, "employees.write");
      // People can remove what they added until HR has verified it.
      if (!hr && !(row.user_id === user.id && !row.verified_at))
        throw new HttpError(403, "Verified entries can only be changed by HR.");
      await db.prepare(`DELETE FROM ${s.table} WHERE id=?`).run(row.id);
      await audit("profile360_removed", {
        section: params.section,
        employeeId: row.user_id,
        id: row.id,
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/profile360/:section/:id/verify",
    { perm: "employees.write" },
    async ({ user, params, send, audit }) => {
      const { s, row } = await entry(user, params);
      if (!s.verifiable)
        throw new HttpError(409, "This section is not verified.");
      await db
        .prepare(`UPDATE ${s.table} SET verified_by=?,verified_at=? WHERE id=?`)
        .run(user.id, nowIso(), row.id);
      await audit("profile360_verified", {
        section: params.section,
        employeeId: row.user_id,
        id: row.id,
      });
      return send(200, { ok: true });
    },
  );
}
