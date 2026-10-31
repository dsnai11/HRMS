import { HttpError, integer, number, optionalString, string } from "../http.js";
import { answer } from "../bot.js";
import { GUIDE, isHrTeam } from "../hr-guide.js";

export function registerBot(router, app) {
  const { db, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();

  // One question to Laxmi. Runs alongside other requests: the Claude fallback can
  // take seconds and must not hold up everyone else's writes.
  router.post(
    "/api/bot/ask",
    { concurrent: true },
    async ({ user, body, send }) => {
      if (user.role === "super_admin")
        throw new HttpError(
          403,
          "The assistant answers from an employee's own records. Use an employee login.",
        );
      rateLimit(`bot:${user.id}`, 120);
      const question = string((await body()).question, "Question", 500);
      const a = await answer(app, user, question);
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO bot_log(company_id,user_id,question,answer,intent,source,answered,created_at) VALUES(?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              question,
              a.text,
              a.intent,
              a.source,
              a.answered ? 1 : 0,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      return send(200, {
        id,
        text: a.text,
        intent: a.intent,
        source: a.source,
        answered: a.answered,
        action: a.action ?? null,
        links: a.links ?? [],
      });
    },
  );
  // The person's own recent conversation with Laxmi, oldest first.
  router.get("/api/bot/history", async ({ user, send }) =>
    send(
      200,
      (
        await db
          .prepare(
            "SELECT id,question,answer,intent,helpful,created_at FROM bot_log WHERE user_id=? AND company_id=? ORDER BY id DESC LIMIT 20",
          )
          .all(user.id, user.company_id)
      ).reverse(),
    ),
  );
  router.post(
    "/api/bot/log/:id/feedback",
    async ({ user, params, body, send }) => {
      const helpful = (await body()).helpful;
      if (typeof helpful !== "boolean")
        throw new HttpError(400, "Helpful must be true or false.");
      const r = await db
        .prepare("UPDATE bot_log SET helpful=? WHERE id=? AND user_id=?")
        .run(helpful ? 1 : 0, integer(Number(params.id)), user.id);
      if (!r.changes) throw new HttpError(404, "Answer not found.");
      return send(200, { ok: true });
    },
  );

  // The HR guide, for the HR team only.
  router.get("/api/hr-guide", async ({ user, send }) => {
    if (!isHrTeam(user))
      throw new HttpError(403, "The HR guide is for the HR team.");
    return send(200, GUIDE);
  });

  // ---- HR: knowledge base, question log, settings ----------------------------------------------------
  const entry = (b) => ({
    title: string(b.title, "Question or title", 150),
    body: string(b.body, "Answer", 5000),
    keywords: optionalString(b.keywords, "Keywords", 300) ?? "",
  });
  const owned = async (id, companyId) => {
    const row = await db
      .prepare("SELECT * FROM bot_knowledge WHERE id=? AND company_id=?")
      .get(integer(Number(id)), companyId);
    if (!row) throw new HttpError(404, "Answer not found.");
    return row;
  };
  router.get(
    "/api/admin/bot/knowledge",
    { perm: "bot.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT k.*,u.name created_by_name FROM bot_knowledge k LEFT JOIN users u ON u.id=k.created_by WHERE k.company_id=? ORDER BY k.active DESC,k.title",
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/bot/knowledge",
    { perm: "bot.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const e = entry(await body());
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO bot_knowledge(company_id,title,body,keywords,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              e.title,
              e.body,
              e.keywords,
              user.id,
              nowIso(),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("bot_answer_added", { id, title: e.title });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/bot/knowledge/:id",
    { perm: "bot.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const row = await owned(params.id, companyId);
      const b = await body();
      const e = entry({ ...row, ...b });
      const active =
        b.active === undefined ? row.active : b.active === true ? 1 : 0;
      await db
        .prepare(
          "UPDATE bot_knowledge SET title=?,body=?,keywords=?,active=?,updated_at=? WHERE id=?",
        )
        .run(e.title, e.body, e.keywords, active, nowIso(), row.id);
      await audit("bot_answer_updated", { id: row.id, title: e.title, active });
      return send(200, { ok: true });
    },
  );
  router.delete(
    "/api/admin/bot/knowledge/:id",
    { perm: "bot.manage" },
    async ({ params, companyId, send, audit }) => {
      const row = await owned(params.id, companyId);
      await db.prepare("DELETE FROM bot_knowledge WHERE id=?").run(row.id);
      await audit("bot_answer_deleted", { id: row.id, title: row.title });
      return send(200, { ok: true });
    },
  );
  // Every question and answer, newest first, so HR can see what people ask and
  // add answers for the ones Laxmi could not handle.
  router.get(
    "/api/admin/bot/log",
    { perm: "bot.manage" },
    async ({ companyId, query, send }) => {
      const unanswered = query.get("unanswered") === "1";
      const rows = await db
        .prepare(
          `SELECT l.id,l.question,l.answer,l.intent,l.source,l.answered,l.helpful,l.created_at,u.name employee_name,u.employee_code
           FROM bot_log l JOIN users u ON u.id=l.user_id WHERE l.company_id=? ${unanswered ? "AND (l.answered=0 OR l.helpful=0)" : ""}
           ORDER BY l.id DESC LIMIT 200`,
        )
        .all(companyId);
      const stats = await db
        .prepare(
          "SELECT COUNT(*) n,SUM(CASE WHEN answered=0 THEN 1 ELSE 0 END) unanswered,SUM(CASE WHEN helpful=1 THEN 1 ELSE 0 END) helpful,SUM(CASE WHEN helpful=0 THEN 1 ELSE 0 END) unhelpful FROM bot_log WHERE company_id=? AND created_at>=?",
        )
        .get(companyId, new Date(clock() - 30 * 86400000).toISOString());
      return send(200, {
        items: rows,
        last_30_days: {
          questions: Number(stats.n ?? 0),
          unanswered: Number(stats.unanswered ?? 0),
          helpful: Number(stats.helpful ?? 0),
          unhelpful: Number(stats.unhelpful ?? 0),
        },
      });
    },
  );
  router.get(
    "/api/admin/bot/settings",
    { perm: "bot.manage" },
    async ({ companyId, send }) => {
      const c = await db
        .prepare("SELECT pay_day FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        pay_day: c?.pay_day ?? null,
        ai_fallback: Boolean(app.botLlm),
      });
    },
  );
  router.put(
    "/api/admin/bot/settings",
    { perm: "bot.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const payDay =
        b.pay_day === null || b.pay_day === ""
          ? null
          : number(b.pay_day, "Pay day", 1, 31);
      if (payDay !== null && !Number.isInteger(payDay))
        throw new HttpError(400, "Pay day must be a whole day of the month.");
      await db
        .prepare("UPDATE companies SET pay_day=? WHERE id=?")
        .run(payDay, companyId);
      await audit("bot_settings_updated", { payDay });
      return send(200, { ok: true });
    },
  );
}
