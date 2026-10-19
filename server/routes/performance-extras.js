import {
  HttpError,
  integer,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

export function registerPerformanceExtras(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);

  // ---- labour welfare fund rules ----------------------------------------------------------------------
  router.get(
    "/api/admin/payroll/lwf-rules",
    { perm: "payroll.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare("SELECT * FROM lwf_rules WHERE company_id=? ORDER BY state")
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/payroll/lwf-rules",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const months = [
        ...new Set(
          String(b.months ?? "")
            .split(",")
            .map((m) => Number(m.trim()))
            .filter((m) => m),
        ),
      ].sort((a, c) => a - c);
      if (
        !months.length ||
        months.some((m) => !Number.isInteger(m) || m < 1 || m > 12)
      )
        throw new HttpError(
          400,
          "Months must be numbers from 1 to 12, like 6,12.",
        );
      const employee = number(
        b.employee_amount ?? 0,
        "Employee amount",
        0,
        100000,
      );
      const employer = number(
        b.employer_amount ?? 0,
        "Employer amount",
        0,
        100000,
      );
      if (!employee && !employer)
        throw new HttpError(400, "Enter an employee or employer amount.");
      const maxWage =
        b.max_wage === undefined || b.max_wage === null || b.max_wage === ""
          ? null
          : number(b.max_wage, "Wage limit", 1, 100000000);
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO lwf_rules(company_id,state,employee_amount,employer_amount,months,max_wage,created_at) VALUES(?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                string(b.state, "State", 60),
                employee,
                employer,
                months.join(","),
                maxWage,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await audit("lwf_rule_added", { id });
        return id;
      });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/payroll/lwf-rules/:id",
    { perm: "payroll.manage" },
    async ({ params, companyId, send, audit }) => {
      const r = await owned("lwf_rules", params.id, companyId, "rule");
      await db.prepare("DELETE FROM lwf_rules WHERE id=?").run(r.id);
      await audit("lwf_rule_removed", { id: r.id });
      return send(200, { ok: true });
    },
  );

  // ---- KRAs by designation ---------------------------------------------------------------------------------
  router.get(
    "/api/admin/kras",
    { perm: "performance.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT k.*,g.name designation_name FROM kra_templates k JOIN designations g ON g.id=k.designation_id WHERE k.company_id=? ORDER BY g.name,k.id",
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/kras",
    { perm: "performance.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const g = await owned(
        "designations",
        b.designation_id,
        companyId,
        "designation",
      );
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO kra_templates(company_id,designation_id,title,description,weight,created_at) VALUES(?,?,?,?,?,?)",
            )
            .run(
              companyId,
              g.id,
              string(b.title, "Title", 150),
              optionalString(b.description, "Description", 1000),
              Math.round(number(b.weight ?? 0, "Weight", 0, 100)),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("kra_added", { id });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/kras/:id",
    { perm: "performance.manage" },
    async ({ params, companyId, send, audit }) => {
      const k = await owned("kra_templates", params.id, companyId, "KRA");
      await db.prepare("DELETE FROM kra_templates WHERE id=?").run(k.id);
      await audit("kra_removed", { id: k.id });
      return send(200, { ok: true });
    },
  );
  // Turns the KRAs of someone's designation into goals, skipping any they already have.
  router.post(
    "/api/admin/employees/:id/apply-kras",
    { perm: "performance.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const p = await owned("users", params.id, companyId, "employee");
      if (!p.designation_id)
        throw new HttpError(409, "This employee has no designation.");
      const b = await body();
      const cycle = b.cycle_id
        ? (await owned("review_cycles", b.cycle_id, companyId, "cycle")).id
        : null;
      const kras = await db
        .prepare(
          "SELECT * FROM kra_templates WHERE designation_id=? ORDER BY id",
        )
        .all(p.designation_id);
      const have = new Set(
        (
          await db
            .prepare("SELECT lower(title) t FROM goals WHERE user_id=?")
            .all(p.id)
        ).map((g) => g.t),
      );
      let added = 0;
      await transaction(async () => {
        for (const k of kras)
          if (!have.has(k.title.toLowerCase())) {
            await db
              .prepare(
                "INSERT INTO goals(company_id,user_id,cycle_id,title,description,weight,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                p.id,
                cycle,
                k.title,
                k.description,
                k.weight,
                user.id,
                nowIso(),
              );
            added++;
          }
        await audit("kras_applied", { employeeId: p.id, added });
      });
      return send(200, { added, skipped: kras.length - added });
    },
  );

  // ---- continuous feedback ---------------------------------------------------------------------------------------
  // Anyone can give feedback to a colleague. The person, their managers and HR can read it;
  // "shared: false" keeps it between the giver and the managers/HR.
  router.post("/api/feedback", async ({ user, body, send, audit }) => {
    const b = await body();
    const to = await owned("users", b.to_user, user.company_id, "colleague");
    if (to.id === user.id) throw new HttpError(400, "Choose someone else.");
    if (to.role === "super_admin" || !to.active)
      throw new HttpError(400, "Choose an active colleague.");
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO feedback(company_id,from_user,to_user,kind,body,shared,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              to.id,
              oneOf(b.kind ?? "note", "Type", ["praise", "improve", "note"]),
              string(b.body, "Feedback", 1500),
              b.shared === false ? 0 : 1,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("feedback_given", { id, to: to.id });
      return id;
    });
    if (b.shared !== false)
      await app.notify([to.id], {
        companyId: user.company_id,
        kind: "feedback",
        title: `${user.name} shared feedback with you`,
        link: "performance",
      });
    return send(201, { id });
  });
  const FB =
    "SELECT f.id,f.kind,f.body,f.shared,f.created_at,a.name from_name,t.name to_name,f.to_user,f.from_user FROM feedback f JOIN users a ON a.id=f.from_user JOIN users t ON t.id=f.to_user";
  router.get("/api/feedback/received", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${FB} WHERE f.to_user=? AND f.shared=1 ORDER BY f.id DESC LIMIT 100`,
        )
        .all(user.id),
    ),
  );
  router.get("/api/feedback/given", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(`${FB} WHERE f.from_user=? ORDER BY f.id DESC LIMIT 100`)
        .all(user.id),
    ),
  );
  router.get("/api/feedback/about/:id", async ({ user, params, send }) => {
    const target = await owned("users", params.id, user.company_id, "employee");
    if (
      target.id !== user.id &&
      !(await mayDecide(app, user, target.id)) &&
      !can(user, "performance.manage")
    )
      throw new HttpError(403, "You cannot see this feedback.");
    const own = target.id === user.id;
    return send(
      200,
      await db
        .prepare(
          `${FB} WHERE f.to_user=? ${own ? "AND f.shared=1" : ""} ORDER BY f.id DESC LIMIT 100`,
        )
        .all(target.id),
    );
  });
}
