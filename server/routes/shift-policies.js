import { HttpError, integer, number, oneOf, string } from "../http.js";
import { requireOwned } from "../scope.js";

const hhmm = (v, label) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(v ?? ""));
  if (!m) throw new HttpError(400, `${label} must look like 09:30.`);
  return v;
};
const minutes = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));

// The rules that apply to a person: their own, else their branch's, else the
// company's, else the server default (SHIFT_START and friends).
export async function policyFor(app, person) {
  const row = await app.db
    .prepare(
      `SELECT p.* FROM shift_policies p WHERE p.id=COALESCE(
         (SELECT shift_policy_id FROM users WHERE id=?),
         (SELECT shift_policy_id FROM branches WHERE id=?),
         (SELECT shift_policy_id FROM companies WHERE id=?))`,
    )
    .get(person.id, person.branch_id ?? -1, person.company_id);
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
  app.policyFor = (person) => policyFor(app, person);
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
                "INSERT INTO shift_policies(company_id,name,start_time,grace_minutes,hours,earliest_out,created_at) VALUES(?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                f.name,
                f.start_time,
                f.grace_minutes,
                f.hours,
                f.earliest_out,
                new Date(clock()).toISOString(),
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
          "UPDATE shift_policies SET name=?,start_time=?,grace_minutes=?,hours=?,earliest_out=? WHERE id=?",
        )
        .run(
          f.name,
          f.start_time,
          f.grace_minutes,
          f.hours,
          f.earliest_out,
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
  // Attach a policy to the whole company, a branch or one employee; policy_id null removes it.
  router.post(
    "/api/admin/shift-policies/assign",
    { perm: "org.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const target = oneOf(b.target, "Target", [
        "company",
        "branch",
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
        const table = target === "branch" ? "branches" : "users";
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
