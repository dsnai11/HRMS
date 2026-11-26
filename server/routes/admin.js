import { HttpError, integer } from "../http.js";

export function registerAdmin(router, app) {
  const { db, transaction } = app;

  router.get(
    "/api/admin/devices",
    { perm: "devices.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT d.id,d.user_id,u.name employee_name,u.email,u.employee_code,d.platform,d.model,d.status,d.registered_at,d.last_seen_at FROM devices d JOIN users u ON u.id=d.user_id WHERE u.company_id=? ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.id DESC",
          )
          .all(companyId),
      ),
  );

  router.patch(
    "/api/admin/devices/:id",
    { perm: "devices.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const id = integer(Number(params.id));
      const b = await body();
      if (!["approved", "revoked"].includes(b.status))
        throw new HttpError(400, "Status must be approved or revoked.");
      const row = await db
        .prepare(
          "SELECT d.* FROM devices d JOIN users u ON u.id=d.user_id WHERE d.id=? AND u.company_id=?",
        )
        .get(id, companyId);
      if (!row) throw new HttpError(404, "Device not found.");
      await transaction(async () => {
        const now = new Date().toISOString();
        if (b.status === "approved")
          await db
            .prepare(
              "UPDATE devices SET status='revoked',decided_by=?,decided_at=? WHERE user_id=? AND status='approved' AND id<>?",
            )
            .run(user.id, now, row.user_id, id);
        await db
          .prepare(
            "UPDATE devices SET status=?,decided_by=?,decided_at=? WHERE id=?",
          )
          .run(b.status, user.id, now, id);
        await audit(`device_${b.status}`, {
          deviceId: id,
          employeeId: row.user_id,
        });
      });
      return send(200, { ok: true });
    },
  );

  router.get(
    "/api/admin/security-events",
    { perm: "security.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT e.id,e.action,e.outcome,e.reason,e.flags,e.latitude,e.longitude,e.accuracy,e.created_at,u.name employee_name FROM punch_events e JOIN users u ON u.id=e.user_id WHERE u.company_id=? AND (e.outcome='rejected' OR e.flags<>'[]') ORDER BY e.id DESC LIMIT 100",
          )
          .all(companyId),
      ),
  );

  // The activity log. ?employee=<code or id> narrows it to one employee: what they did and what
  // was done to their record. ?before=<id> pages back through older entries.
  router.get("/api/admin/audit", { perm: "audit.read" }, async ({ companyId, query, send }) => {
    const pick = (query.get("employee") || "").trim();
    const before = Number(query.get("before")) || null;
    let person = null;
    if (pick) {
      person = await db
        .prepare(
          "SELECT id,name,employee_code FROM users WHERE company_id=? AND (LOWER(employee_code)=LOWER(?) OR CAST(id AS TEXT)=?) ORDER BY (LOWER(employee_code)=LOWER(?)) DESC LIMIT 1",
        )
        .get(companyId, pick, pick, pick);
      if (!person) return send(404, { error: `No employee with code ${pick}.` });
    }
    const where = ["a.company_id=?"];
    const args = [companyId];
    if (person) {
      where.push("(a.actor_id=? OR a.subject_id=?)");
      args.push(person.id, person.id);
    }
    if (before) {
      where.push("a.id<?");
      args.push(before);
    }
    const rows = await db
      .prepare(
        `SELECT a.*,u.name actor_name,u.employee_code actor_code,s.name subject_name,s.employee_code subject_code
         FROM audit a LEFT JOIN users u ON u.id=a.actor_id LEFT JOIN users s ON s.id=a.subject_id
         WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT 100`,
      )
      .all(...args);
    return send(200, person ? { employee: person, entries: rows } : rows);
  });
}
