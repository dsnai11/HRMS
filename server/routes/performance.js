import { insertMany } from "../db.js";
import {
  HttpError,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { branchScope, inBranchScope, requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

export function registerPerformance(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const rating = (v, label) => {
    const n = number(v, label, 1, 5);
    if (!Number.isInteger(n))
      throw new HttpError(400, `${label} must be 1 to 5.`);
    return n;
  };

  // ---- goals ------------------------------------------------------------------------------------
  router.get("/api/goals", async ({ user, query, send }) => {
    const target = query.get("user_id")
      ? integer(Number(query.get("user_id")))
      : user.id;
    if (
      target !== user.id &&
      !(await mayDecide(app, user, target)) &&
      !can(user, "performance.manage")
    )
      throw new HttpError(403, "You cannot see these goals.");
    return send(
      200,
      await db
        .prepare(
          "SELECT * FROM goals WHERE user_id=? AND company_id=? ORDER BY (status='active') DESC,due_date,id",
        )
        .all(target, user.company_id),
    );
  });
  router.post("/api/goals", async ({ user, body, send, audit }) => {
    const b = await body();
    const target = b.user_id ? integer(b.user_id) : user.id;
    if (target !== user.id) {
      await owned("users", target, user.company_id, "employee");
      if (
        !(await mayDecide(app, user, target)) &&
        !can(user, "performance.manage")
      )
        throw new HttpError(403, "You cannot set goals for this person.");
    }
    const cycle = b.cycle_id
      ? (await owned("review_cycles", b.cycle_id, user.company_id, "cycle")).id
      : null;
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO goals(company_id,user_id,cycle_id,title,description,weight,due_date,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            user.company_id,
            target,
            cycle,
            string(b.title, "Title", 150),
            optionalString(b.description, "Description", 1000),
            Math.round(number(b.weight ?? 0, "Weight", 0, 100)),
            isoDate(b.due_date, "Due date"),
            user.id,
            nowIso(),
          )
      ).lastInsertRowid,
    );
    await audit("goal_added", { id, employeeId: target });
    return send(201, { id });
  });
  router.patch(
    "/api/goals/:id",
    async ({ user, params, body, send, audit }) => {
      const g = await owned("goals", params.id, user.company_id, "goal");
      if (
        g.user_id !== user.id &&
        !(await mayDecide(app, user, g.user_id)) &&
        !can(user, "performance.manage")
      )
        throw new HttpError(403, "You cannot change this goal.");
      const b = await body();
      const progress =
        b.progress === undefined
          ? g.progress
          : Math.round(number(b.progress, "Progress", 0, 100));
      const status =
        b.status === undefined
          ? progress === 100
            ? "done"
            : g.status
          : oneOf(b.status, "Status", ["active", "done", "dropped"]);
      await db
        .prepare(
          "UPDATE goals SET title=?,description=?,weight=?,due_date=?,progress=?,status=? WHERE id=?",
        )
        .run(
          b.title === undefined ? g.title : string(b.title, "Title", 150),
          b.description === undefined
            ? g.description
            : optionalString(b.description, "Description", 1000),
          b.weight === undefined
            ? g.weight
            : Math.round(number(b.weight, "Weight", 0, 100)),
          b.due_date === undefined
            ? g.due_date
            : isoDate(b.due_date, "Due date"),
          progress,
          status,
          g.id,
        );
      await audit("goal_updated", { id: g.id, progress, status });
      return send(200, { ok: true });
    },
  );
  router.delete("/api/goals/:id", async ({ user, params, send, audit }) => {
    const g = await owned("goals", params.id, user.company_id, "goal");
    if (g.created_by !== user.id && !can(user, "performance.manage"))
      throw new HttpError(403, "You cannot remove this goal.");
    await db.prepare("DELETE FROM goals WHERE id=?").run(g.id);
    await audit("goal_removed", { id: g.id });
    return send(200, { ok: true });
  });

  // ---- review cycles -------------------------------------------------------------------------------
  router.get(
    "/api/admin/review-cycles",
    { perm: "performance.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT c.*,(SELECT COUNT(*) FROM reviews r WHERE r.cycle_id=c.id) reviews,
         (SELECT COUNT(*) FROM reviews r WHERE r.cycle_id=c.id AND r.status='completed') completed
       FROM review_cycles c WHERE c.company_id=? ORDER BY c.id DESC`,
          )
          .all(companyId),
      ),
  );
  // Starting a cycle creates a review for every active employee with their current manager.
  router.post(
    "/api/admin/review-cycles",
    { perm: "performance.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const start = isoDate(b.start_date, "Start date"),
        end = isoDate(b.end_date, "End date");
      if (!start || !end || end < start)
        throw new HttpError(400, "Choose a start date and a later end date.");
      const name = string(b.name, "Name", 80);
      const out = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO review_cycles(company_id,name,start_date,end_date,created_by,created_at) VALUES(?,?,?,?,?,?)",
              )
              .run(companyId, name, start, end, user.id, nowIso())
          ).lastInsertRowid,
        );
        const people = await db
          .prepare(
            "SELECT id,manager_id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' AND (date_of_joining IS NULL OR date_of_joining<=?)",
          )
          .all(companyId, end);
        await insertMany(
          db,
          "reviews",
          ["company_id", "cycle_id", "user_id", "manager_id"],
          people.map((p) => [companyId, id, p.id, p.manager_id]),
        );
        await audit("review_cycle_started", { id, people: people.length });
        return { id, reviews: people.length };
      });
      await app.notify(
        (
          await db
            .prepare("SELECT user_id FROM reviews WHERE cycle_id=?")
            .all(out.id)
        ).map((r) => r.user_id),
        {
          companyId,
          kind: "review",
          title: `Your self-review for ${name} is open`,
          link: "performance",
        },
      );
      return send(201, out);
    },
  );
  router.post(
    "/api/admin/review-cycles/:id/close",
    { perm: "performance.manage" },
    async ({ params, companyId, send, audit }) => {
      const c = await owned("review_cycles", params.id, companyId, "cycle");
      await db
        .prepare("UPDATE review_cycles SET status='closed' WHERE id=?")
        .run(c.id);
      await audit("review_cycle_closed", { id: c.id });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/review-cycles/:id/reviews",
    { perm: "performance.manage" },
    async ({ user, params, companyId, send }) => {
      const c = await owned("review_cycles", params.id, companyId, "cycle");
      // Branch HR sees only their branches. Running the cycle does not show anyone
      // their own manager's rating early: it stays hidden until someone else releases it.
      const scope = branchScope(user, "r.user_id");
      const rows = await db
        .prepare(
          `SELECT r.*,u.name employee_name,u.employee_code,m.name manager_name FROM reviews r JOIN users u ON u.id=r.user_id LEFT JOIN users m ON m.id=r.manager_id WHERE r.cycle_id=?${scope.sql} ORDER BY u.name`,
        )
        .all(c.id, ...scope.params);
      return send(
        200,
        rows.map((r) =>
          r.user_id === user.id
            ? { ...shape(r, user.id), own: true }
            : r,
        ),
      );
    },
  );
  router.post(
    "/api/admin/reviews/:id/release",
    { perm: "performance.manage" },
    async ({ user, params, companyId, send, audit }) => {
      const r = await owned("reviews", params.id, companyId, "review");
      const person = await db.prepare("SELECT branch_id FROM users WHERE id=?").get(r.user_id);
      if (!inBranchScope(user, person?.branch_id))
        throw new HttpError(404, "Review not found.");
      if (r.user_id === user.id)
        throw new HttpError(
          403,
          "You cannot release your own review. Another HR person or an administrator must release it.",
        );
      if (r.status !== "completed")
        throw new HttpError(409, "The review is not complete yet.");
      await db.prepare("UPDATE reviews SET released=1 WHERE id=?").run(r.id);
      await audit("review_released", { id: r.id });
      await app.notify([r.user_id], {
        companyId,
        kind: "review",
        title: "Your performance review result is available",
        link: "performance",
      });
      return send(200, { ok: true });
    },
  );

  // ---- reviews: employee and manager sides -------------------------------------------------------------
  const MINE = `SELECT r.*,c.name cycle_name,c.end_date,c.status cycle_status,u.name employee_name,m.name manager_name FROM reviews r JOIN review_cycles c ON c.id=r.cycle_id JOIN users u ON u.id=r.user_id LEFT JOIN users m ON m.id=r.manager_id`;
  // Hide the manager's view from the employee until it is released.
  const shape = (r, viewerId) =>
    r.user_id === viewerId && !r.released
      ? { ...r, manager_rating: null, manager_comment: null }
      : r;
  router.get("/api/reviews/mine", async ({ user, send }) =>
    send(
      200,
      (
        await db
          .prepare(`${MINE} WHERE r.user_id=? ORDER BY r.id DESC`)
          .all(user.id)
      ).map((r) => shape(r, user.id)),
    ),
  );
  router.get("/api/reviews/team", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${MINE} WHERE r.manager_id=? AND c.status='open' AND r.status<>'pending_self' AND r.status<>'completed' ORDER BY u.name`,
        )
        .all(user.id),
    ),
  );
  router.get("/api/reviews/team/all", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(`${MINE} WHERE r.manager_id=? ORDER BY r.id DESC LIMIT 100`)
        .all(user.id),
    ),
  );
  router.post(
    "/api/reviews/:id/self",
    async ({ user, params, body, send, audit }) => {
      const r = await owned("reviews", params.id, user.company_id, "review");
      if (r.user_id !== user.id)
        throw new HttpError(403, "This is not your review.");
      if (
        (
          await db
            .prepare("SELECT status FROM review_cycles WHERE id=?")
            .get(r.cycle_id)
        ).status !== "open"
      )
        throw new HttpError(409, "This cycle is closed.");
      if (r.status !== "pending_self")
        throw new HttpError(
          409,
          "You have already submitted your self-review.",
        );
      const b = await body();
      await db
        .prepare(
          "UPDATE reviews SET self_rating=?,self_comment=?,status='pending_manager' WHERE id=?",
        )
        .run(
          rating(b.rating, "Rating"),
          string(b.comment, "Comment", 2000),
          r.id,
        );
      await audit("self_review_submitted", { id: r.id });
      if (r.manager_id)
        await app.notify([r.manager_id], {
          companyId: user.company_id,
          kind: "review",
          title: `${user.name} submitted a self-review`,
          link: "performance",
        });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/reviews/:id/manager",
    async ({ user, params, body, send, audit }) => {
      const r = await owned("reviews", params.id, user.company_id, "review");
      if (r.manager_id !== user.id && !can(user, "performance.manage"))
        throw new HttpError(403, "You are not this person's reviewer.");
      if (r.user_id === user.id)
        throw new HttpError(403, "You cannot review yourself.");
      if (r.status !== "pending_manager")
        throw new HttpError(
          409,
          r.status === "completed"
            ? "This review is complete."
            : "The employee has not submitted a self-review yet.",
        );
      if (
        (
          await db
            .prepare("SELECT status FROM review_cycles WHERE id=?")
            .get(r.cycle_id)
        ).status !== "open"
      )
        throw new HttpError(409, "This cycle is closed.");
      const b = await body();
      await db
        .prepare(
          "UPDATE reviews SET manager_rating=?,manager_comment=?,status='completed',completed_at=? WHERE id=?",
        )
        .run(
          rating(b.rating, "Rating"),
          string(b.comment, "Comment", 2000),
          nowIso(),
          r.id,
        );
      await audit("manager_review_submitted", { id: r.id });
      return send(200, { ok: true });
    },
  );

  // ---- training ---------------------------------------------------------------------------------------
  router.get("/api/trainings/mine", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT r.id,r.status,r.completed_on,r.score,r.attempts,r.certificate_no,t.title,t.kind,t.hours,t.mandatory,COALESCE(r.due_date,t.due_date) due_date FROM training_records r JOIN trainings t ON t.id=r.training_id WHERE r.user_id=? AND t.active=1 ORDER BY (r.status='assigned') DESC,COALESCE(r.due_date,t.due_date),r.id",
        )
        .all(user.id),
    ),
  );
  router.get(
    "/api/admin/trainings",
    { perm: "performance.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT t.*,(SELECT COUNT(*) FROM training_records r WHERE r.training_id=t.id) assigned,
         (SELECT COUNT(*) FROM training_records r WHERE r.training_id=t.id AND r.status='completed') completed
       FROM trainings t WHERE t.company_id=? ORDER BY t.id DESC`,
          )
          .all(companyId),
      ),
  );
  router.get(
    "/api/admin/trainings/:id/records",
    { perm: "performance.manage" },
    async ({ params, companyId, send }) => {
      const t = await owned("trainings", params.id, companyId, "training");
      return send(
        200,
        await db
          .prepare(
            "SELECT r.*,u.name employee_name,u.employee_code FROM training_records r JOIN users u ON u.id=r.user_id WHERE r.training_id=? ORDER BY u.name",
          )
          .all(t.id),
      );
    },
  );
  // Assign to named people, or to everyone when no list is given.
  router.post(
    "/api/admin/trainings",
    { perm: "performance.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const title = string(b.title, "Title", 150);
      const kind = b.kind === "course" ? "course" : "tracked";
      const ids =
        kind === "course" && !(Array.isArray(b.user_ids) && b.user_ids.length)
          ? []
          : Array.isArray(b.user_ids) && b.user_ids.length
            ? [...new Set(b.user_ids.map(integer))]
            : (
                await db
                  .prepare(
                    "SELECT id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin'",
                  )
                  .all(companyId)
              ).map((r) => r.id);
      // Every chosen person must belong to this company: one query, not one each.
      for (let i = 0; i < ids.length; i += 1000) {
        const part = ids.slice(i, i + 1000);
        const found = await db
          .prepare(`SELECT COUNT(*) n FROM users WHERE company_id=? AND id IN (${part.map(() => "?").join(",")})`)
          .get(companyId, ...part);
        if (Number(found.n) !== part.length) throw new HttpError(404, "Employee not found.");
      }
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO trainings(company_id,title,hours,mandatory,due_date,created_by,created_at,kind,description) VALUES(?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                title,
                number(b.hours ?? 1, "Hours", 0.25, 500),
                b.mandatory ? 1 : 0,
                isoDate(b.due_date, "Due date"),
                user.id,
                nowIso(),
                kind,
                optionalString(b.description, "Description", 1000) || null,
              )
          ).lastInsertRowid,
        );
        await insertMany(db, "training_records", ["training_id", "user_id"], ids.map((uid) => [id, uid]));
        await audit("training_created", { id, people: ids.length });
        return id;
      });
      await app.notify(
        ids.filter((x) => x !== user.id),
        {
          companyId,
          kind: "training",
          title: `Training assigned: ${title}`,
          link: "performance",
        },
      );
      return send(201, { id, assigned: ids.length });
    },
  );
  // Marked complete by HR or the employee's manager (self-completion is not trusted for mandatory training).
  router.post(
    "/api/trainings/records/:id/complete",
    async ({ user, params, body, send, audit }) => {
      const r = await db
        .prepare(
          "SELECT r.*,t.company_id,t.mandatory,t.kind FROM training_records r JOIN trainings t ON t.id=r.training_id WHERE r.id=?",
        )
        .get(integer(Number(params.id)));
      if (!r || r.company_id !== user.company_id)
        throw new HttpError(404, "Training record not found.");
      const self = r.user_id === user.id;
      if (r.kind === "course" && !can(user, "performance.manage"))
        throw new HttpError(
          403,
          "A course is completed by finishing its lessons and passing the quiz.",
        );
      if (
        !(
          can(user, "performance.manage") ||
          (!self && (await mayDecide(app, user, r.user_id))) ||
          (self && !r.mandatory)
        )
      )
        throw new HttpError(
          403,
          "A manager or HR confirms completion of this training.",
        );
      const b = await body();
      await db
        .prepare(
          "UPDATE training_records SET status='completed',completed_on=?,score=? WHERE id=?",
        )
        .run(
          isoDate(b.completed_on, "Completed on") ?? today(),
          b.score === undefined ? null : number(b.score, "Score", 0, 100),
          r.id,
        );
      await audit("training_completed", { id: r.id, employeeId: r.user_id });
      return send(200, { ok: true });
    },
  );
}
