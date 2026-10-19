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

  router.get(
    "/api/admin/audit",
    { perm: "audit.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.company_id=? ORDER BY a.id DESC LIMIT 100",
          )
          .all(companyId),
      ),
  );
}
