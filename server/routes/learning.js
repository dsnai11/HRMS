import {
  HttpError,
  integer,
  isoDate,
  number,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";

const LESSON_KINDS = ["text", "link", "video"];
const longDate = (d) =>
  new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${d}T00:00:00Z`));
const plusDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
const url = (v, label) => {
  const s = string(v, label, 500);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, `${label} must be a web address.`);
  }
  if (!["http:", "https:"].includes(u.protocol))
    throw new HttpError(400, `${label} must start with http:// or https://.`);
  return s;
};

/** Checks a course's lessons and quiz questions; returns clean copies. */
export function cleanContent(b) {
  const lessons = Array.isArray(b.lessons) ? b.lessons : [];
  const questions = Array.isArray(b.questions) ? b.questions : [];
  if (lessons.length > 30) throw new HttpError(400, "A course can have up to 30 lessons.");
  if (questions.length > 50) throw new HttpError(400, "A quiz can have up to 50 questions.");
  return {
    lessons: lessons.map((l, i) => {
      const kind = LESSON_KINDS.includes(l?.kind) ? l.kind : "text";
      return {
        title: string(l?.title, `Lesson ${i + 1} title`, 120),
        kind,
        body:
          kind === "text"
            ? string(l?.body, `Lesson ${i + 1} text`, 20000)
            : url(l?.body, `Lesson ${i + 1} link`),
      };
    }),
    questions: questions.map((q, i) => {
      const options = Array.isArray(q?.options) ? q.options : [];
      if (options.length < 2 || options.length > 5)
        throw new HttpError(400, `Question ${i + 1} needs 2 to 5 answer choices.`);
      const correct = Number(q.correct);
      if (!Number.isInteger(correct) || correct < 0 || correct >= options.length)
        throw new HttpError(400, `Question ${i + 1}: mark which answer is correct.`);
      return {
        question: string(q?.question, `Question ${i + 1}`, 300),
        options: options.map((o) => string(o, `Question ${i + 1} choice`, 150)),
        correct,
        explanation: optionalString(q?.explanation, "Explanation", 300) || null,
      };
    }),
  };
}

export function registerLearning(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);

  async function myRecord(user, id) {
    const r = await db
      .prepare(
        "SELECT r.*,t.company_id,t.title,t.kind,t.pass_mark,t.max_attempts,t.hours,t.description,t.due_date training_due FROM training_records r JOIN trainings t ON t.id=r.training_id WHERE r.id=?",
      )
      .get(integer(Number(id)));
    if (!r || r.company_id !== user.company_id || r.user_id !== user.id)
      throw new HttpError(404, "Course not found.");
    return r;
  }
  const lessonsOf = (tid) =>
    db
      .prepare(
        "SELECT id,position,title,kind,body FROM training_lessons WHERE training_id=? ORDER BY position,id",
      )
      .all(tid);
  const questionsOf = (tid) =>
    db
      .prepare(
        "SELECT * FROM training_questions WHERE training_id=? ORDER BY position,id",
      )
      .all(tid);

  async function complete(r, score) {
    const no = `LIFC-${r.training_id}-${r.id}`;
    await db
      .prepare(
        "UPDATE training_records SET status='completed',completed_on=?,score=?,certificate_no=? WHERE id=?",
      )
      .run(today(), score, no, r.id);
  }

  // ---- learner ------------------------------------------------------------------------------
  router.get("/api/learning/:id", async ({ user, params, send }) => {
    const r = await myRecord(user, params.id);
    if (r.kind !== "course")
      throw new HttpError(409, "This is a tracked training, not a course.");
    const done = new Set(
      (
        await db
          .prepare("SELECT lesson_id FROM training_progress WHERE record_id=?")
          .all(r.id)
      ).map((x) => x.lesson_id),
    );
    const lessons = (await lessonsOf(r.training_id)).map((l) => ({
      ...l,
      done: done.has(l.id),
    }));
    const questions = (await questionsOf(r.training_id)).map((q) => ({
      id: q.id,
      question: q.question,
      options: JSON.parse(q.options),
    }));
    const best = await db
      .prepare("SELECT MAX(score) s FROM training_attempts WHERE record_id=?")
      .get(r.id);
    return send(200, {
      id: r.id,
      title: r.title,
      description: r.description,
      hours: r.hours,
      status: r.status,
      due_date: r.due_date ?? r.training_due,
      pass_mark: r.pass_mark,
      attempts: r.attempts,
      attempts_left: r.max_attempts > 0 ? Math.max(r.max_attempts - r.attempts, 0) : null,
      best_score: best.s,
      score: r.score,
      completed_on: r.completed_on,
      certificate: Boolean(r.certificate_no),
      lessons,
      questions,
    });
  });
  router.post(
    "/api/learning/:id/lessons/:lessonId/done",
    async ({ user, params, send }) => {
      const r = await myRecord(user, params.id);
      if (r.status === "completed") return send(200, { ok: true });
      const lesson = await db
        .prepare("SELECT id FROM training_lessons WHERE id=? AND training_id=?")
        .get(integer(Number(params.lessonId)), r.training_id);
      if (!lesson) throw new HttpError(404, "Lesson not found.");
      await db
        .prepare(
          "INSERT INTO training_progress(record_id,lesson_id,done_at) VALUES(?,?,?) ON CONFLICT DO NOTHING",
        )
        .run(r.id, lesson.id, nowIso());
      if (!r.started_at)
        await db
          .prepare("UPDATE training_records SET started_at=? WHERE id=?")
          .run(nowIso(), r.id);
      // A course with no quiz is complete once every lesson has been read.
      const total = (await lessonsOf(r.training_id)).length;
      const doneN = (
        await db
          .prepare("SELECT COUNT(*) n FROM training_progress WHERE record_id=?")
          .get(r.id)
      ).n;
      const hasQuiz = (await questionsOf(r.training_id)).length > 0;
      if (!hasQuiz && doneN >= total && total > 0) {
        await complete(r, 100);
        await app.notify([user.id], {
          companyId: user.company_id,
          kind: "training",
          title: `You completed ${r.title}`,
          link: "learning",
        });
        return send(200, { ok: true, completed: true });
      }
      return send(200, { ok: true, completed: false });
    },
  );
  router.post(
    "/api/learning/:id/quiz",
    async ({ user, params, body, send, audit }) => {
      const r = await myRecord(user, params.id);
      if (r.status === "completed")
        throw new HttpError(409, "You have already completed this course.");
      const questions = await questionsOf(r.training_id);
      if (!questions.length) throw new HttpError(409, "This course has no quiz.");
      const lessons = await lessonsOf(r.training_id);
      const doneN = (
        await db
          .prepare("SELECT COUNT(*) n FROM training_progress WHERE record_id=?")
          .get(r.id)
      ).n;
      if (doneN < lessons.length)
        throw new HttpError(409, "Finish all the lessons before the quiz.");
      if (r.max_attempts > 0 && r.attempts >= r.max_attempts)
        throw new HttpError(409, "No attempts left. Ask HR to reset your attempts.");
      const answers = (await body()).answers;
      if (!Array.isArray(answers) || answers.length !== questions.length)
        throw new HttpError(400, "Answer every question.");
      const flags = questions.map((q, i) => Number(answers[i]) === q.correct);
      const score = Math.round((flags.filter(Boolean).length / questions.length) * 100);
      const passed = score >= r.pass_mark;
      await transaction(async () => {
        await db
          .prepare(
            "INSERT INTO training_attempts(record_id,score,passed,created_at) VALUES(?,?,?,?)",
          )
          .run(r.id, score, passed ? 1 : 0, nowIso());
        await db
          .prepare("UPDATE training_records SET attempts=attempts+1 WHERE id=?")
          .run(r.id);
        if (passed) await complete(r, score);
        await audit("training_attempt", { id: r.id, score, passed });
      });
      if (passed)
        await app.notify([user.id], {
          companyId: user.company_id,
          kind: "training",
          title: `You passed ${r.title} (${score}%)`,
          link: "learning",
        });
      const used = r.attempts + 1;
      return send(200, {
        score,
        passed,
        pass_mark: r.pass_mark,
        correct: flags,
        explanations: passed ? questions.map((q) => q.explanation) : undefined,
        attempts_left: r.max_attempts > 0 ? Math.max(r.max_attempts - used, 0) : null,
      });
    },
  );
  router.get(
    "/api/trainings/records/:id/certificate",
    async ({ user, params, send }) => {
      const r = await db
        .prepare(
          "SELECT r.*,t.company_id,t.title,t.hours,u.name person FROM training_records r JOIN trainings t ON t.id=r.training_id JOIN users u ON u.id=r.user_id WHERE r.id=?",
        )
        .get(integer(Number(params.id)));
      if (
        !r ||
        r.company_id !== user.company_id ||
        (r.user_id !== user.id && !can(user, "performance.manage"))
      )
        throw new HttpError(404, "Certificate not found.");
      if (r.status !== "completed" || !r.certificate_no)
        throw new HttpError(409, "No certificate: the course is not completed.");
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(r.company_id);
      return send(200, {
        company: company.name,
        title: "Certificate of completion",
        date: longDate(r.completed_on),
        to: r.person,
        paragraphs: [
          `This certifies that ${r.person} successfully completed the course "${r.title}" (${r.hours} hours) on ${longDate(r.completed_on)}${r.score != null ? ` with a score of ${r.score}%` : ""}.`,
          `Certificate number: ${r.certificate_no}`,
        ],
        signoff: `For ${company.name}`,
      });
    },
  );

  // ---- HR: build and manage courses -----------------------------------------------------------
  router.get(
    "/api/admin/learning/:id",
    { perm: "performance.manage" },
    async ({ params, companyId, send }) => {
      const t = await owned("trainings", params.id, companyId, "course");
      return send(200, {
        ...t,
        lessons: await lessonsOf(t.id),
        questions: (await questionsOf(t.id)).map((q) => ({
          ...q,
          options: JSON.parse(q.options),
        })),
        locked: await contentLocked(t.id),
      });
    },
  );
  const contentLocked = async (tid) =>
    (
      await db
        .prepare(
          "SELECT (SELECT COUNT(*) FROM training_progress p JOIN training_records r ON r.id=p.record_id WHERE r.training_id=?)+(SELECT COUNT(*) FROM training_attempts a JOIN training_records r ON r.id=a.record_id WHERE r.training_id=?) n",
        )
        .get(tid, tid)
    ).n > 0;
  router.put(
    "/api/admin/learning/:id/content",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const t = await owned("trainings", params.id, companyId, "course");
      if (t.kind !== "course")
        throw new HttpError(409, "Only courses have lessons and a quiz.");
      if (await contentLocked(t.id))
        throw new HttpError(
          409,
          "People have already started this course, so its content is locked. Create a new course instead.",
        );
      const c = cleanContent(await body(300_000));
      await transaction(async () => {
        await db.prepare("DELETE FROM training_lessons WHERE training_id=?").run(t.id);
        await db.prepare("DELETE FROM training_questions WHERE training_id=?").run(t.id);
        for (const [i, l] of c.lessons.entries())
          await db
            .prepare(
              "INSERT INTO training_lessons(training_id,position,title,kind,body) VALUES(?,?,?,?,?)",
            )
            .run(t.id, i + 1, l.title, l.kind, l.body);
        for (const [i, q] of c.questions.entries())
          await db
            .prepare(
              "INSERT INTO training_questions(training_id,position,question,options,correct,explanation) VALUES(?,?,?,?,?,?)",
            )
            .run(t.id, i + 1, q.question, JSON.stringify(q.options), q.correct, q.explanation);
        await audit("course_content_saved", {
          id: t.id,
          lessons: c.lessons.length,
          questions: c.questions.length,
        });
      });
      return send(200, { lessons: c.lessons.length, questions: c.questions.length });
    },
  );
  router.patch(
    "/api/admin/learning/:id",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const t = await owned("trainings", params.id, companyId, "course");
      const b = await body();
      const set = {};
      if (b.description !== undefined)
        set.description = optionalString(b.description, "Description", 1000) || null;
      if (b.pass_mark !== undefined)
        set.pass_mark = Math.round(number(b.pass_mark, "Pass mark", 1, 100));
      if (b.max_attempts !== undefined)
        set.max_attempts = Math.round(number(b.max_attempts, "Attempts", 0, 20));
      if (b.auto_assign !== undefined) set.auto_assign = b.auto_assign ? 1 : 0;
      if (b.due_days !== undefined)
        set.due_days = Math.round(number(b.due_days, "Days to complete", 1, 365));
      if (b.mandatory !== undefined) set.mandatory = b.mandatory ? 1 : 0;
      if (b.active !== undefined) set.active = b.active ? 1 : 0;
      if (b.due_date !== undefined) set.due_date = isoDate(b.due_date, "Due date");
      const keys = Object.keys(set);
      if (!keys.length) throw new HttpError(400, "Nothing to change.");
      await db
        .prepare(`UPDATE trainings SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`)
        .run(...keys.map((k) => set[k]), t.id);
      await audit("course_updated", { id: t.id, fields: keys });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/learning/:id/assign",
    { perm: "performance.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const t = await owned("trainings", params.id, companyId, "course");
      if (!t.active) throw new HttpError(409, "This course is switched off.");
      if (t.kind === "course") {
        const n = (
          await db
            .prepare("SELECT COUNT(*) n FROM training_lessons WHERE training_id=?")
            .get(t.id)
        ).n;
        if (!n) throw new HttpError(409, "Add at least one lesson before assigning the course.");
      }
      const b = await body();
      const ids =
        Array.isArray(b.user_ids) && b.user_ids.length
          ? [...new Set(b.user_ids.map(integer))]
          : (
              await db
                .prepare(
                  "SELECT id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin'",
                )
                .all(companyId)
            ).map((r) => r.id);
      for (const id of ids) await owned("users", id, companyId, "employee");
      let added = 0;
      await transaction(async () => {
        for (const uid of ids) {
          const r = await db
            .prepare(
              "INSERT INTO training_records(training_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING",
            )
            .run(t.id, uid);
          added += r.changes ?? 0;
        }
        await audit("course_assigned", { id: t.id, people: added });
      });
      if (added)
        await app.notify(ids, {
          companyId,
          kind: "training",
          title: `Course assigned: ${t.title}`,
          link: "learning",
        });
      return send(200, { assigned: added });
    },
  );
  router.post(
    "/api/admin/trainings/records/:id/reset",
    { perm: "performance.manage" },
    async ({ params, companyId, send, audit }) => {
      const r = await db
        .prepare(
          "SELECT r.id,t.company_id FROM training_records r JOIN trainings t ON t.id=r.training_id WHERE r.id=?",
        )
        .get(integer(Number(params.id)));
      if (!r || r.company_id !== companyId)
        throw new HttpError(404, "Training record not found.");
      await db.prepare("UPDATE training_records SET attempts=0 WHERE id=?").run(r.id);
      await audit("training_attempts_reset", { id: r.id });
      return send(200, { ok: true });
    },
  );
}

/** Gives a new joiner every course marked "assign to new joiners". Call inside the hire transaction. */
export async function assignJoinerCourses(app, userId, companyId, joiningDate) {
  const courses = await app.db
    .prepare(
      "SELECT id,due_days FROM trainings WHERE company_id=? AND auto_assign=1 AND active=1",
    )
    .all(companyId);
  for (const c of courses)
    await app.db
      .prepare(
        "INSERT INTO training_records(training_id,user_id,due_date) VALUES(?,?,?) ON CONFLICT DO NOTHING",
      )
      .run(c.id, userId, plusDays(joiningDate, c.due_days));
  return courses.length;
}

/** Nudges people with training due within 3 days or overdue, at most once a week each. */
export async function sendTrainingReminders(app) {
  const now = app.dayOf(new Date(app.clock()).toISOString());
  const rows = await app.db
    .prepare(
      `SELECT r.id,r.user_id,t.company_id,t.title,COALESCE(r.due_date,t.due_date) due
       FROM training_records r JOIN trainings t ON t.id=r.training_id JOIN users u ON u.id=r.user_id
       WHERE r.status='assigned' AND t.active=1 AND u.active=1 AND COALESCE(r.due_date,t.due_date) IS NOT NULL
         AND COALESCE(r.due_date,t.due_date)<=? AND (r.reminded_on IS NULL OR r.reminded_on<=?)`,
    )
    .all(plusDays(now, 3), plusDays(now, -7));
  for (const r of rows) {
    await app.notify([r.user_id], {
      companyId: r.company_id,
      kind: "training",
      title: r.due < now ? `Overdue: ${r.title}` : `Due ${r.due}: ${r.title}`,
      link: "learning",
      email: true,
    });
    await app.db
      .prepare("UPDATE training_records SET reminded_on=? WHERE id=?")
      .run(now, r.id);
  }
  return rows.length;
}
export function scheduleLearningReminders(app) {
  const run = () =>
    sendTrainingReminders(app).catch((e) =>
      console.error("Training reminders failed:", e.message),
    );
  void run();
  setInterval(run, 6 * 3600000).unref();
}
