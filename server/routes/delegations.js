import { HttpError, integer, isoDate, optionalString } from "../http.js";
import { can } from "../rbac.js";
import { daysBetween } from "../calendar.js";

// Hand my approvals to someone while I am away (see delegation.js for what it covers).
// HR with leave.manage can set one up for a manager who could not.
const MAX_DAYS = 90;
const SELECT = `SELECT d.*,u.name delegator_name,x.name delegate_name FROM approval_delegations d
  JOIN users u ON u.id=d.user_id JOIN users x ON x.id=d.delegate_id`;

export function registerDelegations(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const state = (d) =>
    d.cancelled_at ? "cancelled" : d.ends_on < today() ? "ended" : d.starts_on > today() ? "upcoming" : "active";

  router.get("/api/delegations", async ({ user, send }) => {
    const rows = await db
      .prepare(`${SELECT} WHERE (d.user_id=? OR d.delegate_id=?) AND d.ends_on>=? ORDER BY d.starts_on LIMIT 50`)
      .all(user.id, user.id, app.dayOf(new Date(clock() - 30 * 86400000).toISOString()));
    const shaped = rows.map((d) => ({ ...d, state: state(d) }));
    return send(200, {
      given: shaped.filter((d) => d.user_id === user.id),
      received: shaped.filter((d) => d.delegate_id === user.id && !d.cancelled_at),
    });
  });

  router.post("/api/delegations", async ({ user, body, send, audit }) => {
    const b = await body();
    // Your own approvals, or (HR) a manager's.
    const ownerId = b.user_id ? integer(Number(b.user_id)) : user.id;
    if (ownerId !== user.id && !can(user, "leave.manage"))
      throw new HttpError(403, "You can hand over only your own approvals.");
    const owner = await db.prepare("SELECT id,name,company_id FROM users WHERE id=? AND company_id=? AND active=1").get(ownerId, user.company_id);
    if (!owner) throw new HttpError(404, "Employee not found.");
    if (!(await db.prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1").get(ownerId)))
      throw new HttpError(409, "Only someone with people reporting to them has approvals to hand over.");
    const delegateId = integer(Number(b.delegate_id));
    if (delegateId === ownerId) throw new HttpError(400, "Choose someone else.");
    const delegate = await db
      .prepare("SELECT id,name FROM users WHERE id=? AND company_id=? AND active=1 AND role<>'super_admin'")
      .get(delegateId, user.company_id);
    if (!delegate) throw new HttpError(404, "That person was not found.");
    const starts = isoDate(b.starts_on, "From"),
      ends = isoDate(b.ends_on, "To");
    if (!starts || !ends || ends < starts) throw new HttpError(400, "Choose a start date and an end date on or after it.");
    if (starts < today()) throw new HttpError(400, "A hand-over starts today or later.");
    if (daysBetween(starts, ends) + 1 > MAX_DAYS) throw new HttpError(400, `A hand-over can be up to ${MAX_DAYS} days.`);
    const overlap = await db
      .prepare("SELECT id FROM approval_delegations WHERE user_id=? AND cancelled_at IS NULL AND starts_on<=? AND ends_on>=?")
      .get(ownerId, ends, starts);
    if (overlap) throw new HttpError(409, "There is already a hand-over for some of those days. Cancel it first.");
    // No chains: someone standing in for others cannot hand that on, and the delegate
    // cannot have handed their own approvals to this person for the same days.
    const loop = await db
      .prepare("SELECT id FROM approval_delegations WHERE user_id=? AND delegate_id=? AND cancelled_at IS NULL AND starts_on<=? AND ends_on>=?")
      .get(delegateId, ownerId, ends, starts);
    if (loop) throw new HttpError(409, "That person has handed their approvals to you for those days.");
    const id = Number(
      (
        await db
          .prepare("INSERT INTO approval_delegations(company_id,user_id,delegate_id,starts_on,ends_on,reason,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(user.company_id, ownerId, delegateId, starts, ends, optionalString(b.reason, "Reason", 200), user.id, nowIso())
      ).lastInsertRowid,
    );
    await audit("approvals_delegated", { id, from: ownerId, to: delegateId, starts, ends });
    await app.notify([delegateId], {
      companyId: user.company_id,
      kind: "approval",
      title: `${owner.name} handed you their approvals from ${starts} to ${ends}`,
      body: "Their team's leave, corrections and OD trips will reach you under Approvals.",
      link: "approvals",
    });
    return send(201, { id });
  });

  router.post("/api/delegations/:id/cancel", async ({ user, params, send, audit }) => {
    const d = await db
      .prepare("SELECT * FROM approval_delegations WHERE id=? AND company_id=?")
      .get(integer(Number(params.id)), user.company_id);
    if (!d || (d.user_id !== user.id && d.created_by !== user.id && !can(user, "leave.manage")))
      throw new HttpError(404, "Hand-over not found.");
    if (d.cancelled_at) throw new HttpError(409, "This hand-over is already cancelled.");
    if (d.ends_on < today()) throw new HttpError(409, "This hand-over has already ended.");
    // Cancelling one in progress ends it today; nothing already decided changes.
    await db.prepare("UPDATE approval_delegations SET cancelled_at=? WHERE id=?").run(nowIso(), d.id);
    await audit("approvals_delegation_cancelled", { id: d.id });
    await app.notify([d.delegate_id], {
      companyId: d.company_id,
      kind: "approval",
      title: "A hand-over of approvals to you was cancelled",
      link: "approvals",
    });
    return send(200, { ok: true });
  });

  router.get("/api/admin/delegations", { perm: "leave.manage" }, async ({ companyId, send }) => {
    const rows = await db
      .prepare(`${SELECT} WHERE d.company_id=? AND d.cancelled_at IS NULL AND d.ends_on>=? ORDER BY d.starts_on LIMIT 300`)
      .all(companyId, today());
    return send(200, rows.map((d) => ({ ...d, state: state(d) })));
  });
}
