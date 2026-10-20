import { HttpError, integer, number, oneOf, string } from "../http.js";
import { requireOwned } from "../scope.js";

const hhmm = (v, label) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ""));
  if (!m) throw new HttpError(400, `${label} must look like 09:30.`);
  return v;
};
export const SHIFT_KINDS = ["fixed", "flexible", "rotational", "night"];
const minutes = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

// The rules that apply to a person: their own, else their branch's, else the
// company's, else the server default (SHIFT_START and friends).
export async function policyFor(app, person, date = null) {
  // A roster entry for that day beats everything else.
  const day = date ?? app.dayOf(new Date(app.clock()).toISOString());
  const row = await app.db
    .prepare(
      `SELECT p.* FROM shift_policies p WHERE p.id=COALESCE(
         (SELECT shift_policy_id FROM roster_entries WHERE user_id=? AND date=? AND off=0),
         (SELECT shift_policy_id FROM users WHERE id=?),
         (SELECT shift_policy_id FROM departments WHERE id=?),
         (SELECT shift_policy_id FROM branches WHERE id=?),
         (SELECT shift_policy_id FROM companies WHERE id=?))`,
    )
    .get(
      person.id,
      day,
      person.id,
      person.department_id ?? -1,
      person.branch_id ?? -1,
      person.company_id,
    );
  if (!row) return app.policy;
  return {
    startMinutes: minutes(row.start_time),
    graceMinutes: row.grace_minutes,
    hours: row.hours,
    earliestOutMinutes: minutes(row.earliest_out),
  };
}

export function registerShiftPolicies(router, app) {
  const { db, transaction, clock } = app;
  app.policyFor = (person, date) => policyFor(app, person, date);
  const fields = (b, existing = {}) => {
    const start =
      b.start_time === undefined
        ? existing.start_time
        : hhmm(b.start_time, "Start time");
    const out =
      b.earliest_out === undefined
        ? existing.earliest_out
        : hhmm(b.earliest_out, "Earliest punch-out");
    return {
      kind:
        b.kind === undefined
          ? (existing.kind ?? "fixed")
          : oneOf(b.kind, "Type", SHIFT_KINDS),
      name: b.name === undefined ? existing.name : string(b.name, "Name", 60),
      start_time: start,
      earliest_out: out,
      grace_minutes:
        b.grace_minutes === undefined
          ? (existing.grace_minutes ?? 15)
          : Math.round(number(b.grace_minutes, "Grace minutes", 0, 240)),
      hours:
        b.hours === undefined
          ? (existing.hours ?? 9)
          : number(b.hours, "Shift hours", 1, 16),
    };
  };
  router.get(
    "/api/admin/shift-policies",
    { perm: "org.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT p.*,
             (SELECT COUNT(*) FROM users u WHERE u.shift_policy_id=p.id) employees,
             (SELECT COUNT(*) FROM branches b WHERE b.shift_policy_id=p.id) branches,
             (SELECT COUNT(*) FROM departments d WHERE d.shift_policy_id=p.id) departments,
             (SELECT COUNT(*) FROM companies c WHERE c.shift_policy_id=p.id) is_default
           FROM shift_policies p WHERE p.company_id=? ORDER BY p.name`,
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/shift-policies",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const f = fields(await body());
      if (!f.name || !f.start_time || !f.earliest_out)
        throw new HttpError(
          400,
          "Name, start time and earliest punch-out are required.",
        );
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO shift_policies(company_id,name,start_time,grace_minutes,hours,earliest_out,created_at,kind) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                f.name,
                f.start_time,
                f.grace_minutes,
                f.hours,
                f.earliest_out,
                new Date(clock()).toISOString(),
                f.kind,
              )
          ).lastInsertRowid,
        );
        await audit("shift_policy_created", { id, name: f.name });
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/shift-policies/:id",
    { perm: "org.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const p = await requireOwned(
        db,
        "shift_policies",
        integer(Number(params.id)),
        companyId,
        "shift policy",
      );
      const f = fields(await body(), p);
      await db
        .prepare(
          "UPDATE shift_policies SET name=?,start_time=?,grace_minutes=?,hours=?,earliest_out=?,kind=? WHERE id=?",
        )
        .run(
          f.name,
          f.start_time,
          f.grace_minutes,
          f.hours,
          f.earliest_out,
          f.kind,
          p.id,
        );
      await audit("shift_policy_updated", { id: p.id });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/admin/shift-policies/:id",
    { perm: "org.manage" },
    async ({ params, companyId, send, audit }) => {
      const p = await requireOwned(
        db,
        "shift_policies",
        integer(Number(params.id)),
        companyId,
        "shift policy",
      );
      await db.prepare("DELETE FROM shift_policies WHERE id=?").run(p.id);
      await audit("shift_policy_deleted", { id: p.id });
      return send(200, { ok: true });
    },
  );
  // The usual patterns: a fixed day, a flexible day, rotating shifts and a night shift.
  const TEMPLATES = [
    ["Fixed day shift", "fixed", "09:30", 15, 9, "18:30"],
    ["Flexible hours", "flexible", "10:00", 120, 8, "17:00"],
    ["Rotational morning", "rotational", "06:00", 15, 8, "14:00"],
    ["Rotational afternoon", "rotational", "14:00", 15, 8, "22:00"],
    ["Night shift", "night", "22:00", 15, 9, "06:00"],
  ];
  router.post(
    "/api/admin/shift-policies/seed-templates",
    { perm: "org.manage" },
    async ({ companyId, send, audit }) => {
      let added = 0;
      for (const [name, kind, start, grace, hours, out] of TEMPLATES) {
        if (
          await db
            .prepare(
              "SELECT id FROM shift_policies WHERE company_id=? AND lower(name)=lower(?)",
            )
            .get(companyId, name)
        )
          continue;
        await db
          .prepare(
            "INSERT INTO shift_policies(company_id,name,start_time,grace_minutes,hours,earliest_out,created_at,kind) VALUES(?,?,?,?,?,?,?,?)",
          )
          .run(
            companyId,
            name,
            start,
            grace,
            hours,
            out,
            new Date(clock()).toISOString(),
            kind,
          );
        added++;
      }
      await audit("shift_templates_added", { added });
      return send(200, { added });
    },
  );
  // Attach a policy to the whole company, a branch, a department or one employee; policy_id null removes it.
  router.post(
    "/api/admin/shift-policies/assign",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const target = oneOf(b.target, "Target", [
        "company",
        "branch",
        "department",
        "employee",
      ]);
      const policyId =
        b.policy_id === null || b.policy_id === undefined
          ? null
          : (
              await requireOwned(
                db,
                "shift_policies",
                integer(b.policy_id),
                companyId,
                "shift policy",
              )
            ).id;
      if (target === "company")
        await db
          .prepare("UPDATE companies SET shift_policy_id=? WHERE id=?")
          .run(policyId, companyId);
      else {
        const table =
          { branch: "branches", department: "departments" }[target] ?? "users";
        const row = await requireOwned(
          db,
          table,
          integer(b.id),
          companyId,
          target,
        );
        await db
          .prepare(`UPDATE ${table} SET shift_policy_id=? WHERE id=?`)
          .run(policyId, row.id);
      }
      await audit("shift_policy_assigned", {
        target,
        id: b.id ?? null,
        policyId,
      });
      return send(200, { ok: true });
    },
  );
  // ---- roster ----------------------------------------------------------------------------------------
  const isDate = (v) =>
    /^\d{4}-\d{2}-\d{2}$/.test(v ?? "") && !Number.isNaN(Date.parse(v));
  router.get(
    "/api/admin/roster",
    { perm: "org.read" },
    async ({ companyId, query, send }) => {
      const from = query.get("from"),
        to = query.get("to");
      if (!isDate(from) || !isDate(to) || to < from)
        throw new HttpError(400, "Choose a from and to date.");
      if (Date.parse(to) - Date.parse(from) > 62 * 86400000)
        throw new HttpError(400, "Show at most two months at a time.");
      const where = ["r.company_id=?", "r.date>=?", "r.date<=?"],
        params = [companyId, from, to];
      if (query.get("branch_id"))
        (where.push("u.branch_id=?"),
          params.push(integer(Number(query.get("branch_id")))));
      return send(
        200,
        await db
          .prepare(
            `SELECT r.user_id,r.date,r.off,r.shift_policy_id,p.name policy_name,u.name employee_name FROM roster_entries r JOIN users u ON u.id=r.user_id LEFT JOIN shift_policies p ON p.id=r.shift_policy_id WHERE ${where.join(" AND ")} ORDER BY u.name,r.date`,
          )
          .all(...params),
      );
    },
  );
  // Set the same thing for several people over a date range (optionally only some weekdays).
  router.post(
    "/api/admin/roster",
    { perm: "org.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const from = b.from,
        to = b.to;
      if (!isDate(from) || !isDate(to) || to < from)
        throw new HttpError(400, "Choose a from and to date.");
      if (Date.parse(to) - Date.parse(from) > 92 * 86400000)
        throw new HttpError(400, "Set at most three months at a time.");
      if (
        !Array.isArray(b.user_ids) ||
        !b.user_ids.length ||
        b.user_ids.length > 500
      )
        throw new HttpError(400, "Choose 1 to 500 employees.");
      const off = b.off === true;
      const policy =
        off || b.policy_id === null || b.policy_id === undefined
          ? null
          : (
              await requireOwned(
                db,
                "shift_policies",
                integer(b.policy_id),
                companyId,
                "shift rule",
              )
            ).id;
      const clear = !off && policy === null; // neither off nor a rule: remove the entries
      const weekdays =
        Array.isArray(b.weekdays) && b.weekdays.length
          ? b.weekdays.map(Number)
          : null;
      if (weekdays?.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
        throw new HttpError(400, "Weekdays are 0 (Sunday) to 6.");
      const ids = [...new Set(b.user_ids.map(integer))];
      for (const id of ids)
        await requireOwned(db, "users", id, companyId, "employee");
      const days = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += 86400000) {
        const d = new Date(t);
        if (!weekdays || weekdays.includes(d.getUTCDay()))
          days.push(d.toISOString().slice(0, 10));
      }
      await transaction(async () => {
        for (const id of ids)
          for (const day of days) {
            if (clear)
              await db
                .prepare(
                  "DELETE FROM roster_entries WHERE user_id=? AND date=?",
                )
                .run(id, day);
            else
              await db
                .prepare(
                  "INSERT INTO roster_entries(company_id,user_id,date,shift_policy_id,off,created_by,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT (user_id,date) DO UPDATE SET shift_policy_id=EXCLUDED.shift_policy_id,off=EXCLUDED.off,created_by=EXCLUDED.created_by,created_at=EXCLUDED.created_at",
                )
                .run(
                  companyId,
                  id,
                  day,
                  policy,
                  off ? 1 : 0,
                  user.id,
                  new Date(clock()).toISOString(),
                );
          }
        await audit("roster_set", {
          people: ids.length,
          days: days.length,
          off,
          policyId: policy,
          cleared: clear,
        });
      });
      return send(200, { people: ids.length, days: days.length });
    },
  );
  router.get("/api/my-roster", async ({ user, query, send }) => {
    const from =
      query.get("from") ?? app.dayOf(new Date(clock()).toISOString());
    if (!isDate(from)) throw new HttpError(400, "Choose a date.");
    const to = new Date(Date.parse(from) + 13 * 86400000)
      .toISOString()
      .slice(0, 10);
    return send(
      200,
      await db
        .prepare(
          "SELECT r.date,r.off,p.name policy_name,p.start_time,p.earliest_out FROM roster_entries r LEFT JOIN shift_policies p ON p.id=r.shift_policy_id WHERE r.user_id=? AND r.date>=? AND r.date<=? ORDER BY r.date",
        )
        .all(user.id, from, to),
    );
  });
  // What applies to the signed-in person, for the phone app.
  router.get("/api/my-shift", async ({ user, send }) => {
    const p = await policyFor(app, user);
    const hh = (m) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return send(200, {
      start: hh(p.startMinutes),
      grace_minutes: p.graceMinutes,
      hours: p.hours,
      earliest_out: hh(p.earliestOutMinutes),
    });
  });
}
