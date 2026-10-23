import { HttpError, integer, isoDate, string } from "../http.js";

// Anonymous 360-degree feedback. HR opens a round for chosen people; each is rated by
// themselves, their manager, their direct reports and a few peers (same manager).
// Nobody, including HR, sees who gave which answer: results are averages per group,
// and the peer and report groups only show once at least MIN_GROUP people answered.
const MIN_GROUP = 3;
const DEFAULT_QUESTIONS = [
  "Delivers work on time and to a good standard",
  "Communicates clearly and keeps others informed",
  "Works well with colleagues and helps the team",
  "Takes ownership and solves problems",
  "Treats customers and colleagues with respect",
];
const GROUPS = { self: "Self", manager: "Manager", others: "Peers and team" };

export function registerFeedbackRounds(router, app) {
  const { db, transaction } = app;
  const nowIso = () => new Date(app.clock()).toISOString();
  const today = () => app.dayOf(nowIso());

  const round = async (id, companyId) => {
    const r = await db
      .prepare("SELECT * FROM feedback_rounds WHERE id=? AND company_id=?")
      .get(integer(Number(id)), companyId);
    if (!r) throw new HttpError(404, "Feedback round not found.");
    return { ...r, questions: JSON.parse(r.questions) };
  };

  // Group averages for one person in one round; never who said what.
  async function resultsFor(r, subjectId) {
    const rows = await db
      .prepare(
        "SELECT relation,ratings,comment FROM feedback_requests WHERE round_id=? AND subject_id=? AND submitted_at IS NOT NULL",
      )
      .all(r.id, subjectId);
    const by = { self: [], manager: [], others: [] };
    for (const x of rows)
      by[x.relation === "self" || x.relation === "manager" ? x.relation : "others"].push(x);
    const hidden = by.others.length > 0 && by.others.length < MIN_GROUP;
    const average = (list, q) => {
      const vals = list.map((x) => JSON.parse(x.ratings)[q]).filter((v) => v);
      return vals.length
        ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10
        : null;
    };
    return {
      responses: rows.length,
      groups: Object.entries(GROUPS).map(([key, label]) => ({
        key,
        label,
        answered: by[key].length,
        hidden: key === "others" && hidden,
      })),
      questions: r.questions.map((text, q) => ({
        text,
        ...Object.fromEntries(
          Object.keys(GROUPS).map((key) => [
            key,
            key === "others" && hidden ? null : average(by[key], q),
          ]),
        ),
      })),
      // Comments are shuffled and unsigned; the small-group rule applies to them too.
      comments: rows
        .filter((x) => x.comment && !(hidden && !["self", "manager"].includes(x.relation)))
        .map((x) => x.comment)
        .sort(() => Math.random() - 0.5),
      min_group: MIN_GROUP,
    };
  }

  router.get(
    "/api/admin/feedback-rounds",
    { perm: "performance.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        (
          await db
            .prepare(
              `SELECT r.*,(SELECT COUNT(*) FROM feedback_requests q WHERE q.round_id=r.id) requests,
               (SELECT COUNT(*) FROM feedback_requests q WHERE q.round_id=r.id AND q.submitted_at IS NOT NULL) submitted,
               (SELECT COUNT(DISTINCT subject_id) FROM feedback_requests q WHERE q.round_id=r.id) subjects
               FROM feedback_rounds r WHERE r.company_id=? ORDER BY r.id DESC`,
            )
            .all(companyId)
        ).map((r) => ({ ...r, questions: JSON.parse(r.questions) })),
      ),
  );
  router.get(
    "/api/feedback/default-questions",
    { perm: "performance.manage" },
    async ({ send }) => send(200, DEFAULT_QUESTIONS),
  );
  router.post(
    "/api/admin/feedback-rounds",
    { perm: "performance.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const name = string(b.name, "Round name", 100);
      const closes = isoDate(b.closes_on, "Closes on");
      if (!closes || closes < today())
        throw new HttpError(400, "Choose a closing date from today on.");
      const questions = (Array.isArray(b.questions) && b.questions.length ? b.questions : DEFAULT_QUESTIONS).map((q) =>
        string(q, "Question", 200),
      );
      if (questions.length > 15) throw new HttpError(400, "Use up to 15 questions.");
      const peers = Math.min(Math.max(integer(Number(b.peers ?? 3)), 0), 8);
      const subjects = [...new Set((Array.isArray(b.subject_ids) ? b.subject_ids : []).map((x) => integer(Number(x))))];
      if (!subjects.length) throw new HttpError(400, "Choose the people to get feedback.");
      const active = "company_id=? AND active=1 AND role<>'super_admin'";
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO feedback_rounds(company_id,name,questions,closes_on,created_by,created_at) VALUES(?,?,?,?,?,?)",
              )
              .run(companyId, name, JSON.stringify(questions), closes, user.id, nowIso())
          ).lastInsertRowid,
        );
        for (const sid of subjects) {
          const s = await db
            .prepare(`SELECT id,manager_id FROM users WHERE id=? AND ${active}`)
            .get(sid, companyId);
          if (!s) throw new HttpError(400, "Choose people from your company.");
          const raters = [[s.id, "self"]];
          if (s.manager_id) raters.push([s.manager_id, "manager"]);
          for (const r of await db
            .prepare(`SELECT id FROM users WHERE manager_id=? AND ${active}`)
            .all(s.id, companyId))
            raters.push([r.id, "report"]);
          if (s.manager_id && peers)
            for (const r of await db
              .prepare(`SELECT id FROM users WHERE manager_id=? AND id<>? AND ${active} ORDER BY id LIMIT ?`)
              .all(s.manager_id, s.id, companyId, peers))
              raters.push([r.id, "peer"]);
          for (const [rid, relation] of raters)
            await db
              .prepare(
                "INSERT INTO feedback_requests(round_id,subject_id,rater_id,relation) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
              )
              .run(id, s.id, rid, relation);
        }
        await audit("feedback_round_opened", { id, name, people: subjects.length });
        return id;
      });
      const raters = await db
        .prepare("SELECT DISTINCT rater_id FROM feedback_requests WHERE round_id=?")
        .all(id);
      await app.notify(
        raters.map((r) => r.rater_id),
        {
          companyId,
          kind: "feedback",
          title: `Feedback requested: ${name}`,
          body: `Please answer by ${closes}. Your answers are anonymous.`,
          link: "performance",
          email: true,
        },
      );
      return send(201, { id });
    },
  );
  router.post(
    "/api/admin/feedback-rounds/:id/close",
    { perm: "performance.manage" },
    async ({ params, companyId, send, audit }) => {
      const r = await round(params.id, companyId);
      await db.prepare("UPDATE feedback_rounds SET status='closed' WHERE id=?").run(r.id);
      await audit("feedback_round_closed", { id: r.id });
      const subjects = await db
        .prepare("SELECT DISTINCT subject_id FROM feedback_requests WHERE round_id=?")
        .all(r.id);
      await app.notify(
        subjects.map((s) => s.subject_id),
        { companyId, kind: "feedback", title: `Your feedback from ${r.name} is ready`, link: "performance" },
      );
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/feedback-rounds/:id/results",
    { perm: "performance.manage" },
    async ({ params, companyId, send }) => {
      const r = await round(params.id, companyId);
      const people = await db
        .prepare(
          `SELECT DISTINCT u.id,u.name,u.employee_code FROM feedback_requests q JOIN users u ON u.id=q.subject_id WHERE q.round_id=? ORDER BY u.name`,
        )
        .all(r.id);
      const out = [];
      for (const p of people) out.push({ ...p, ...(await resultsFor(r, p.id)) });
      return send(200, { round: r, people: out });
    },
  );

  // ---- raters and the person reviewed ------------------------------------------
  router.get("/api/feedback/tasks", async ({ user, send }) =>
    send(
      200,
      (
        await db
          .prepare(
            `SELECT q.id,q.relation,q.submitted_at,r.name round_name,r.closes_on,r.questions,r.status,u.name subject_name
             FROM feedback_requests q JOIN feedback_rounds r ON r.id=q.round_id JOIN users u ON u.id=q.subject_id
             WHERE q.rater_id=? AND r.company_id=? ORDER BY q.submitted_at IS NOT NULL,r.closes_on,q.id`,
          )
          .all(user.id, user.company_id)
      ).map((t) => ({ ...t, questions: JSON.parse(t.questions) })),
    ),
  );
  router.post("/api/feedback/tasks/:id", async ({ user, params, body, send }) => {
    const t = await db
      .prepare(
        "SELECT q.*,r.questions,r.status,r.closes_on FROM feedback_requests q JOIN feedback_rounds r ON r.id=q.round_id WHERE q.id=? AND q.rater_id=? AND r.company_id=?",
      )
      .get(integer(Number(params.id)), user.id, user.company_id);
    if (!t) throw new HttpError(404, "Feedback request not found.");
    if (t.status !== "open" || t.closes_on < today())
      throw new HttpError(409, "This feedback round has closed.");
    if (t.submitted_at) throw new HttpError(409, "You have already answered.");
    const b = await body();
    const n = JSON.parse(t.questions).length;
    const ratings = Array.isArray(b.ratings) ? b.ratings.map(Number) : [];
    if (ratings.length !== n || ratings.some((v) => !Number.isInteger(v) || v < 1 || v > 5))
      throw new HttpError(400, "Rate every statement from 1 to 5.");
    const comment =
      typeof b.comment === "string" && b.comment.trim() ? b.comment.trim().slice(0, 1000) : null;
    await db
      .prepare("UPDATE feedback_requests SET ratings=?,comment=?,submitted_at=? WHERE id=? AND submitted_at IS NULL")
      .run(JSON.stringify(ratings), comment, nowIso(), t.id);
    return send(200, { ok: true });
  });
  router.get("/api/feedback/results", async ({ user, send }) => {
    const rounds = await db
      .prepare(
        `SELECT DISTINCT r.* FROM feedback_rounds r JOIN feedback_requests q ON q.round_id=r.id
         WHERE q.subject_id=? AND r.company_id=? AND r.status='closed' ORDER BY r.id DESC`,
      )
      .all(user.id, user.company_id);
    const out = [];
    for (const r of rounds) {
      const parsed = { ...r, questions: JSON.parse(r.questions) };
      out.push({ id: r.id, name: r.name, closes_on: r.closes_on, ...(await resultsFor(parsed, user.id)) });
    }
    return send(200, out);
  });
}
