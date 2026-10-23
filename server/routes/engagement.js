import {
  HttpError,
  integer,
  isoDate,
  oneOf,
  optionalId,
  optionalString,
  string,
} from "../http.js";
import { requireOwned, staffWith } from "../scope.js";
import { can } from "../rbac.js";

const CATEGORIES = [
  "payroll",
  "leave",
  "attendance",
  "it",
  "policy",
  "id_card",
  "certificate",
  "other",
];
const STATUSES = ["open", "in_progress", "resolved", "closed"];

export function registerEngagement(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);

  // ---- notifications -------------------------------------------------------------------------
  router.get("/api/notifications", async ({ user, send }) => {
    const items = await db
      .prepare(
        "SELECT id,kind,title,body,link,read_at,created_at FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50",
      )
      .all(user.id);
    const unread = (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read_at IS NULL",
        )
        .get(user.id)
    ).n;
    return send(200, { items, unread });
  });
  router.post("/api/notifications/read", async ({ user, body, send }) => {
    const b = await body();
    if (b.id)
      await db
        .prepare(
          "UPDATE notifications SET read_at=? WHERE id=? AND user_id=? AND read_at IS NULL",
        )
        .run(nowIso(), integer(b.id), user.id);
    else
      await db
        .prepare(
          "UPDATE notifications SET read_at=? WHERE user_id=? AND read_at IS NULL",
        )
        .run(nowIso(), user.id);
    return send(200, { ok: true });
  });

  // ---- phone push tokens ---------------------------------------------------------------------------
  router.post("/api/push/register", async ({ user, body, send }) => {
    const b = await body();
    const token = string(b.token, "Token", 400);
    const platform = oneOf(b.platform, "Platform", ["android", "ios"]);
    // A token belongs to one person: signing in as someone else on the same phone moves it.
    await db
      .prepare(
        "INSERT INTO push_tokens(user_id,token,platform,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT (token) DO UPDATE SET user_id=EXCLUDED.user_id,platform=EXCLUDED.platform,updated_at=EXCLUDED.updated_at",
      )
      .run(user.id, token, platform, nowIso(), nowIso());
    return send(200, { ok: true });
  });
  router.post("/api/push/unregister", async ({ user, body, send }) => {
    const token = string((await body()).token, "Token", 400);
    await db
      .prepare("DELETE FROM push_tokens WHERE token=? AND user_id=?")
      .run(token, user.id);
    return send(200, { ok: true });
  });

  // ---- announcements ---------------------------------------------------------------------------
  // An announcement reaches everyone, or one branch, or one department.
  const audienceSql = `(a.branch_id IS NULL OR a.branch_id=?) AND (a.department_id IS NULL OR a.department_id=?)`;
  router.get("/api/announcements", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `SELECT a.id,a.title,a.body,a.pinned,a.created_at,u.name author FROM announcements a LEFT JOIN users u ON u.id=a.created_by
           WHERE a.company_id=? AND a.deleted_at IS NULL AND (a.expires_on IS NULL OR a.expires_on>=?) AND ${audienceSql}
           ORDER BY a.pinned DESC,a.id DESC LIMIT 30`,
        )
        .all(
          user.company_id,
          today(),
          user.branch_id ?? -1,
          user.department_id ?? -1,
        ),
    ),
  );
  router.get(
    "/api/admin/announcements",
    { perm: "announcements.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT a.*,b.name branch_name,d.name department_name FROM announcements a LEFT JOIN branches b ON b.id=a.branch_id LEFT JOIN departments d ON d.id=a.department_id
           WHERE a.company_id=? AND a.deleted_at IS NULL ORDER BY a.id DESC LIMIT 100`,
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/announcements",
    { perm: "announcements.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const branch = optionalId(b.branch_id, "Branch");
      const dept = optionalId(b.department_id, "Department");
      if (branch) await owned("branches", branch, companyId, "branch");
      if (dept) await owned("departments", dept, companyId, "department");
      const title = string(b.title, "Title", 120);
      const text = string(b.body, "Message", 4000);
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO announcements(company_id,title,body,branch_id,department_id,pinned,expires_on,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                title,
                text,
                branch,
                dept,
                b.pinned ? 1 : 0,
                isoDate(b.expires_on, "Expires on"),
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await audit("announcement_posted", { id });
        return id;
      });
      const where = ["company_id=?", "active=1", "role<>'super_admin'"],
        params = [companyId];
      if (branch) (where.push("branch_id=?"), params.push(branch));
      if (dept) (where.push("department_id=?"), params.push(dept));
      const people = await db
        .prepare(`SELECT id FROM users WHERE ${where.join(" AND ")}`)
        .all(...params);
      await app.notify(
        people.map((p) => p.id).filter((x) => x !== user.id),
        {
          companyId,
          kind: "announcement",
          title,
          body: text.slice(0, 200),
          link: "announcements",
          email: Boolean(b.email),
        },
      );
      return send(201, { id, notified: people.length });
    },
  );
  router.delete(
    "/api/admin/announcements/:id",
    { perm: "announcements.manage" },
    async ({ params, companyId, send, audit }) => {
      const a = await owned(
        "announcements",
        params.id,
        companyId,
        "announcement",
      );
      await db
        .prepare("UPDATE announcements SET deleted_at=? WHERE id=?")
        .run(nowIso(), a.id);
      await audit("announcement_removed", { id: a.id });
      return send(200, { ok: true });
    },
  );

  // ---- helpdesk ----------------------------------------------------------------------------------
  const TICKET = `SELECT t.*,u.name employee_name,u.employee_code,a.name assigned_name FROM tickets t JOIN users u ON u.id=t.user_id LEFT JOIN users a ON a.id=t.assigned_to`;
  // Response-time state: met or missed once resolved; otherwise due or breached.
  const withSla = (t) => {
    const done = ["resolved", "closed"].includes(t.status);
    const at = done ? (t.resolved_at ?? t.updated_at) : nowIso();
    return {
      ...t,
      sla_state: !t.due_at
        ? null
        : done
          ? at <= t.due_at
            ? "met"
            : "missed"
          : at > t.due_at
            ? "breached"
            : "due",
    };
  };
  const canSee = (user, t) =>
    t.user_id === user.id || can(user, "helpdesk.manage");
  router.get("/api/tickets", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${TICKET} WHERE t.user_id=? ORDER BY t.updated_at DESC LIMIT 100`,
        )
        .all(user.id)
        .then((rows) => rows.map(withSla)),
    ),
  );
  router.post("/api/tickets", async ({ user, body, send, audit }) => {
    const b = await body();
    const subject = string(b.subject, "Subject", 150);
    const priority = oneOf(b.priority ?? "normal", "Priority", [
      "low",
      "normal",
      "high",
    ]);
    const sla = JSON.parse(
      (
        await db
          .prepare("SELECT ticket_sla FROM companies WHERE id=?")
          .get(user.company_id)
      ).ticket_sla,
    );
    const id = await transaction(async () => {
      const now = nowIso();
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO tickets(company_id,user_id,category,subject,priority,created_at,updated_at,due_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              oneOf(b.category ?? "other", "Category", CATEGORIES),
              subject,
              priority,
              now,
              now,
              new Date(Date.parse(now) + sla[priority] * 3600000).toISOString(),
            )
        ).lastInsertRowid,
      );
      await db
        .prepare(
          "INSERT INTO ticket_messages(ticket_id,user_id,body,created_at) VALUES(?,?,?,?)",
        )
        .run(id, user.id, string(b.body, "Details", 3000), now);
      await audit("ticket_opened", { id });
      return id;
    });
    const staff = await staffWith(db, user.company_id, ["helpdesk.manage"]);
    await app.notify(
      staff.map((s) => s.id).filter((x) => x !== user.id),
      {
        companyId: user.company_id,
        kind: "ticket",
        title: `New helpdesk ticket: ${subject}`,
        link: "helpdesk",
      },
    );
    return send(201, { id });
  });
  router.get(
    "/api/admin/tickets",
    { perm: "helpdesk.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        (
          await db
            .prepare(
              `${TICKET} WHERE t.company_id=? ${status ? "AND t.status=?" : "AND t.status IN ('open','in_progress')"} ORDER BY (t.priority='high') DESC,t.updated_at DESC LIMIT 200`,
            )
            .all(
              ...(status
                ? [companyId, oneOf(status, "Status", STATUSES)]
                : [companyId]),
            )
        )
          .map(withSla)
          .sort(
            (a, b) =>
              Number(b.sla_state === "breached") -
              Number(a.sla_state === "breached"),
          ),
      );
    },
  );
  router.get("/api/tickets/:id", async ({ user, params, send }) => {
    const t = await owned("tickets", params.id, user.company_id, "ticket");
    if (!canSee(user, t)) throw new HttpError(404, "Ticket not found.");
    const staff = can(user, "helpdesk.manage");
    return send(200, {
      ...withSla(await db.prepare(`${TICKET} WHERE t.id=?`).get(t.id)),
      messages: await db
        .prepare(
          `SELECT m.id,m.body,m.internal,m.created_at,u.name author FROM ticket_messages m JOIN users u ON u.id=m.user_id WHERE m.ticket_id=? ${staff ? "" : "AND m.internal=0"} ORDER BY m.id`,
        )
        .all(t.id),
    });
  });
  router.post(
    "/api/tickets/:id/reply",
    async ({ user, params, body, send, audit }) => {
      const t = await owned("tickets", params.id, user.company_id, "ticket");
      if (!canSee(user, t)) throw new HttpError(404, "Ticket not found.");
      if (t.status === "closed")
        throw new HttpError(409, "This ticket is closed. Open a new one.");
      const b = await body();
      const staff = can(user, "helpdesk.manage");
      const internal = staff && b.internal ? 1 : 0;
      await transaction(async () => {
        await db
          .prepare(
            "INSERT INTO ticket_messages(ticket_id,user_id,body,internal,created_at) VALUES(?,?,?,?,?)",
          )
          .run(
            t.id,
            user.id,
            string(b.body, "Reply", 3000),
            internal,
            nowIso(),
          );
        // A reply from the employee reopens a resolved ticket; staff replies move it along.
        const status = staff
          ? t.status === "open"
            ? "in_progress"
            : t.status
          : t.status === "resolved"
            ? "open"
            : t.status;
        await db
          .prepare(
            "UPDATE tickets SET status=?,updated_at=?,assigned_to=COALESCE(assigned_to,?),first_response_at=COALESCE(first_response_at,?) WHERE id=?",
          )
          .run(
            status,
            nowIso(),
            staff ? user.id : null,
            staff && !internal && t.user_id !== user.id ? nowIso() : null,
            t.id,
          );
        await audit("ticket_reply", { id: t.id, internal: Boolean(internal) });
      });
      if (staff && !internal && t.user_id !== user.id)
        await app.notify([t.user_id], {
          companyId: user.company_id,
          kind: "ticket",
          title: `HR replied to: ${t.subject}`,
          link: "helpdesk",
          email: true,
        });
      return send(200, { ok: true });
    },
  );
  router.patch(
    "/api/admin/tickets/:id",
    { perm: "helpdesk.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const t = await owned("tickets", params.id, companyId, "ticket");
      const b = await body();
      const status =
        b.status === undefined ? t.status : oneOf(b.status, "Status", STATUSES);
      const assigned =
        b.assigned_to === undefined
          ? t.assigned_to
          : optionalId(b.assigned_to, "Assignee");
      if (assigned) await owned("users", assigned, companyId, "assignee");
      await db
        .prepare(
          "UPDATE tickets SET status=?,assigned_to=?,priority=?,updated_at=?,resolved_at=? WHERE id=?",
        )
        .run(
          status,
          assigned,
          b.priority === undefined
            ? t.priority
            : oneOf(b.priority, "Priority", ["low", "normal", "high"]),
          nowIso(),
          ["resolved", "closed"].includes(status)
            ? (t.resolved_at ?? nowIso())
            : null,
          t.id,
        );
      await audit("ticket_updated", { id: t.id, status });
      if (status !== t.status && ["resolved", "closed"].includes(status))
        await app.notify([t.user_id], {
          companyId,
          kind: "ticket",
          title: `Your ticket was ${status}: ${t.subject}`,
          link: "helpdesk",
        });
      return send(200, { ok: true });
    },
  );

  // ---- policies and acknowledgement ----------------------------------------------------------------
  router.get("/api/policies", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `SELECT p.id,p.title,p.body,p.version,p.updated_at,
             (SELECT acknowledged_at FROM policy_acks k WHERE k.policy_id=p.id AND k.user_id=? AND k.version=p.version) acknowledged_at
           FROM policies p WHERE p.company_id=? AND p.active=1 ORDER BY p.title`,
        )
        .all(user.id, user.company_id),
    ),
  );
  router.post(
    "/api/policies/:id/acknowledge",
    async ({ user, params, send, audit }) => {
      const p = await owned("policies", params.id, user.company_id, "policy");
      if (!p.active)
        throw new HttpError(409, "This policy is no longer active.");
      await db
        .prepare(
          "INSERT INTO policy_acks(policy_id,user_id,version,acknowledged_at) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(p.id, user.id, p.version, nowIso());
      await audit("policy_acknowledged", { id: p.id, version: p.version });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/policies",
    { perm: "policies.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT p.*,
             (SELECT COUNT(*) FROM policy_acks k WHERE k.policy_id=p.id AND k.version=p.version) acknowledged,
             (SELECT COUNT(*) FROM users u WHERE u.company_id=p.company_id AND u.active=1 AND u.role<>'super_admin') people
           FROM policies p WHERE p.company_id=? ORDER BY p.active DESC,p.title`,
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/policies",
    { perm: "policies.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const title = string(b.title, "Title", 120);
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO policies(company_id,title,body,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?)",
              )
              .run(
                companyId,
                title,
                string(b.body, "Policy text", 20000),
                user.id,
                nowIso(),
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await audit("policy_published", { id });
        return id;
      });
      await notifyPeople(companyId, user.id, `New policy to read: ${title}`);
      return send(201, { id });
    },
  );
  // Changing the text creates a new version that everyone must acknowledge again.
  router.patch(
    "/api/admin/policies/:id",
    { perm: "policies.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const p = await owned("policies", params.id, companyId, "policy");
      const b = await body();
      const text =
        b.body === undefined ? p.body : string(b.body, "Policy text", 20000);
      const changed = text !== p.body;
      await db
        .prepare(
          "UPDATE policies SET title=?,body=?,version=?,active=?,updated_at=? WHERE id=?",
        )
        .run(
          b.title === undefined ? p.title : string(b.title, "Title", 120),
          text,
          changed ? p.version + 1 : p.version,
          b.active === undefined ? p.active : b.active ? 1 : 0,
          nowIso(),
          p.id,
        );
      await audit("policy_updated", { id: p.id, newVersion: changed });
      if (changed)
        await notifyPeople(
          companyId,
          user.id,
          `Policy updated, please read again: ${p.title}`,
        );
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/policies/:id/pending",
    { perm: "policies.manage" },
    async ({ params, companyId, send }) => {
      const p = await owned("policies", params.id, companyId, "policy");
      return send(
        200,
        await db
          .prepare(
            `SELECT u.id,u.name,u.employee_code FROM users u WHERE u.company_id=? AND u.active=1 AND u.role<>'super_admin'
           AND NOT EXISTS (SELECT 1 FROM policy_acks k WHERE k.policy_id=? AND k.user_id=u.id AND k.version=?) ORDER BY u.name`,
          )
          .all(companyId, p.id, p.version),
      );
    },
  );
  async function notifyPeople(companyId, exceptId, title) {
    const people = await db
      .prepare(
        "SELECT id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' AND id<>?",
      )
      .all(companyId, exceptId);
    await app.notify(
      people.map((x) => x.id),
      { companyId, kind: "policy", title, link: "policies" },
    );
  }
}
