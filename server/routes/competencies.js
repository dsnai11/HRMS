import { HttpError, integer, number, optionalString, string } from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

// Core competencies rated in each review, and the change history of goals (migration 058).
// The employee rates competencies with their self-review; the manager rates them with theirs.
// As with the overall rating, the employee sees the manager's ratings only once released.
export function registerCompetencies(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const rating = (v, label) => {
    const n = number(v, label, 1, 5);
    if (!Number.isInteger(n)) throw new HttpError(400, `${label} must be 1 to 5.`);
    return n;
  };

  // ---- HR: the company's competencies -----------------------------------------------------------
  router.get("/api/competencies", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare("SELECT * FROM competencies WHERE company_id=? ORDER BY active DESC,sort_order,id")
        .all(user.company_id),
    ),
  );
  router.post(
    "/api/admin/competencies",
    { perm: "performance.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const name = string(b.name, "Name", 80);
      if (await db.prepare("SELECT id FROM competencies WHERE company_id=? AND lower(name)=lower(?)").get(companyId, name))
        throw new HttpError(409, "A competency with this name exists.");
      const id = Number(
        (
          await db
            .prepare("INSERT INTO competencies(company_id,name,description,sort_order,created_at) VALUES(?,?,?,?,?)")
            .run(companyId, name, optionalString(b.description, "Description", 500), Math.round(number(b.sort_order ?? 0, "Order", 0, 1000)), nowIso())
        ).lastInsertRowid,
      );
      await audit("competency_added", { id, name });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/competencies/:id",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const c = await owned("competencies", params.id, companyId, "competency");
      const b = await body();
      await db
        .prepare("UPDATE competencies SET name=?,description=?,sort_order=?,active=? WHERE id=?")
        .run(
          b.name === undefined ? c.name : string(b.name, "Name", 80),
          b.description === undefined ? c.description : optionalString(b.description, "Description", 500),
          b.sort_order === undefined ? c.sort_order : Math.round(number(b.sort_order, "Order", 0, 1000)),
          b.active === undefined ? c.active : b.active ? 1 : 0,
          c.id,
        );
      await audit("competency_updated", { id: c.id });
      return send(200, { ok: true });
    },
  );

  // ---- ratings in a review ---------------------------------------------------------------------
  async function reviewFor(user, id) {
    const r = await owned("reviews", id, user.company_id, "review");
    const role =
      r.user_id === user.id
        ? "self"
        : r.manager_id === user.id
          ? "manager"
          : can(user, "performance.manage")
            ? "hr"
            : null;
    if (!role) throw new HttpError(403, "You cannot see this review.");
    const cycle = await db.prepare("SELECT status FROM review_cycles WHERE id=?").get(r.cycle_id);
    return { r, role, open: cycle.status === "open" };
  }
  router.get("/api/reviews/:id/competencies", async ({ user, params, send }) => {
    const { r, role } = await reviewFor(user, params.id);
    // Active competencies, plus any retired one that was already rated in this review.
    const rows = await db
      .prepare(
        `SELECT c.id competency_id,c.name,c.description,rc.self_rating,rc.manager_rating,rc.manager_comment
         FROM competencies c LEFT JOIN review_competencies rc ON rc.competency_id=c.id AND rc.review_id=?
         WHERE c.company_id=? AND (c.active=1 OR rc.id IS NOT NULL) ORDER BY c.sort_order,c.id`,
      )
      .all(r.id, user.company_id);
    const hide = role === "self" && !r.released;
    return send(
      200,
      rows.map((x) => (hide ? { ...x, manager_rating: null, manager_comment: null } : x)),
    );
  });
  router.put(
    "/api/reviews/:id/competencies",
    async ({ user, params, body, send, audit }) => {
      const { r, role, open } = await reviewFor(user, params.id);
      if (!open) throw new HttpError(409, "This cycle is closed.");
      const side =
        role === "self" && r.status === "pending_self"
          ? "self"
          : (role === "manager" || role === "hr") && r.user_id !== user.id && r.status === "pending_manager"
            ? "manager"
            : null;
      if (!side)
        throw new HttpError(
          409,
          role === "self"
            ? "Competencies are rated with your self-review, before you submit it."
            : "Competencies are rated after the self-review and before the review is complete.",
        );
      const b = await body();
      if (!Array.isArray(b.ratings) || b.ratings.length > 50)
        throw new HttpError(400, "Send a list of ratings.");
      const active = new Set(
        (await db.prepare("SELECT id FROM competencies WHERE company_id=? AND active=1").all(user.company_id)).map((c) => c.id),
      );
      await transaction(async () => {
        for (const it of b.ratings) {
          const cid = integer(Number(it?.competency_id));
          if (!active.has(cid)) throw new HttpError(400, "Rate only the company's current competencies.");
          const value = rating(it.rating, "Rating");
          const existing = await db
            .prepare("SELECT id FROM review_competencies WHERE review_id=? AND competency_id=?")
            .get(r.id, cid);
          if (side === "self") {
            if (existing)
              await db.prepare("UPDATE review_competencies SET self_rating=? WHERE id=?").run(value, existing.id);
            else
              await db
                .prepare("INSERT INTO review_competencies(review_id,competency_id,self_rating) VALUES(?,?,?)")
                .run(r.id, cid, value);
          } else {
            const comment = optionalString(it.comment, "Comment", 500);
            if (existing)
              await db
                .prepare("UPDATE review_competencies SET manager_rating=?,manager_comment=? WHERE id=?")
                .run(value, comment, existing.id);
            else
              await db
                .prepare("INSERT INTO review_competencies(review_id,competency_id,manager_rating,manager_comment) VALUES(?,?,?,?)")
                .run(r.id, cid, value, comment);
          }
        }
      });
      await audit("competencies_rated", { id: r.id, side, count: b.ratings.length });
      return send(200, { ok: true });
    },
  );

  // ---- goal change history ---------------------------------------------------------------------
  router.get("/api/goals/:id/history", async ({ user, params, send }) => {
    const g = await owned("goals", params.id, user.company_id, "goal");
    if (g.user_id !== user.id && !(await mayDecide(app, user, g.user_id)) && !can(user, "performance.manage"))
      throw new HttpError(403, "You cannot see this goal.");
    return send(200, {
      goal: { id: g.id, title: g.title, created_at: g.created_at },
      changes: await db
        .prepare(
          "SELECT h.field,h.old_value,h.new_value,h.changed_at,u.name changed_by_name FROM goal_changes h JOIN users u ON u.id=h.changed_by WHERE h.goal_id=? ORDER BY h.id DESC",
        )
        .all(g.id),
    });
  });
}
