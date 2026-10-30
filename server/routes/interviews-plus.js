import { randomBytes } from "node:crypto";
import {
  HttpError,
  integer,
  number,
  oneOf,
  optionalId,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { candidateMail } from "./recruitment-plus.js";
import { googleCalendarLink, interviewIcs } from "../ics.js";

const CATEGORIES = ["technical", "behavioural", "situational", "domain"];
const DIFFICULTIES = ["easy", "medium", "hard"];
const MODES = ["in_person", "phone", "video"];
const OPEN = ["applied", "screening", "interview", "offer"];
const REC_SCORE = { strong_yes: 2, yes: 1, no: -1, strong_no: -2 };

export function registerInterviewsPlus(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  // Postgres returns ROUND(...::numeric) as text; the API gives numbers.
  const num = (r) => ({
    ...r,
    ...(r.avg_rating == null ? {} : { avg_rating: Number(r.avg_rating) }),
  });
  const avg = (xs) =>
    xs.length
      ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 100) / 100
      : null;

  // ---- question bank --------------------------------------------------------------------------
  router.get(
    "/api/admin/question-bank",
    { perm: "recruitment.manage" },
    async ({ companyId, query, send }) => {
      const where = ["q.company_id=?"];
      const params = [companyId];
      if (query.get("department_id") === "none")
        where.push("q.department_id IS NULL");
      else if (query.get("department_id")) {
        where.push("q.department_id=?");
        params.push(integer(Number(query.get("department_id"))));
      }
      if (query.get("category")) {
        where.push("q.category=?");
        params.push(oneOf(query.get("category"), "Category", CATEGORIES));
      }
      if (query.get("active") !== "all") where.push("q.active=1");
      const text = query.get("q")?.trim().toLowerCase();
      if (text) {
        where.push("lower(q.question) LIKE ?");
        params.push(`%${text}%`);
      }
      const rows = await db
        .prepare(
          `SELECT q.*,d.name department_name,
               (SELECT COUNT(*) FROM interview_questions i WHERE i.question_id=q.id) used,
               (SELECT ROUND(AVG(i.rating)::numeric,2) FROM interview_questions i WHERE i.question_id=q.id AND i.rating IS NOT NULL) avg_rating
             FROM question_bank q LEFT JOIN departments d ON d.id=q.department_id
             WHERE ${where.join(" AND ")} ORDER BY q.id DESC LIMIT 500`,
        )
        .all(...params);
      return send(200, rows.map(num));
    },
  );
  const bankFields = async (b, companyId, existing = {}) => {
    const dept =
      b.department_id === undefined
        ? (existing.department_id ?? null)
        : optionalId(b.department_id, "Department");
    if (dept) await owned("departments", dept, companyId, "department");
    return {
      department_id: dept,
      category:
        b.category === undefined
          ? (existing.category ?? "technical")
          : oneOf(b.category, "Category", CATEGORIES),
      difficulty:
        b.difficulty === undefined
          ? (existing.difficulty ?? "medium")
          : oneOf(b.difficulty, "Difficulty", DIFFICULTIES),
      question:
        b.question === undefined
          ? existing.question
          : string(b.question, "Question", 500),
    };
  };
  router.post(
    "/api/admin/question-bank",
    { perm: "recruitment.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const f = await bankFields(await body(), companyId);
      if (!f.question) throw new HttpError(400, "Write the question.");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO question_bank(company_id,department_id,category,difficulty,question,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              f.department_id,
              f.category,
              f.difficulty,
              f.question,
              user.id,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("question_added", { id });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/question-bank/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const q = await owned("question_bank", params.id, companyId, "question");
      const b = await body();
      const f = await bankFields(b, companyId, q);
      const active = b.active === undefined ? q.active : b.active ? 1 : 0;
      await db
        .prepare(
          "UPDATE question_bank SET department_id=?,category=?,difficulty=?,question=?,active=? WHERE id=?",
        )
        .run(
          f.department_id,
          f.category,
          f.difficulty,
          f.question,
          active,
          q.id,
        );
      await audit("question_updated", { id: q.id, active });
      return send(200, { ok: true });
    },
  );
  // Paste one question per line to fill the bank quickly.
  router.post(
    "/api/admin/question-bank/import",
    { perm: "recruitment.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(200_000);
      const f = await bankFields({ ...b, question: "x" }, companyId);
      const lines = string(b.text, "Questions", 100_000)
        .split(/\r?\n/)
        .map((l) => l.replace(/^\s*(?:\d+[.)]|[-*•])\s*/, "").trim())
        .filter(Boolean);
      if (!lines.length)
        throw new HttpError(400, "Paste at least one question.");
      if (lines.length > 200)
        throw new HttpError(400, "Import up to 200 questions at a time.");
      const have = new Set(
        (
          await db
            .prepare("SELECT question FROM question_bank WHERE company_id=?")
            .all(companyId)
        ).map((r) => r.question.toLowerCase()),
      );
      let added = 0;
      await transaction(async () => {
        for (const q of lines) {
          if (q.length > 500 || have.has(q.toLowerCase())) continue;
          have.add(q.toLowerCase());
          await db
            .prepare(
              "INSERT INTO question_bank(company_id,department_id,category,difficulty,question,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              f.department_id,
              f.category,
              f.difficulty,
              q,
              user.id,
              nowIso(),
            );
          added++;
        }
        await audit("questions_imported", { added });
      });
      return send(200, { added, skipped: lines.length - added });
    },
  );

  /** 4–5 questions for a department: spread across categories, least-used first. */
  async function pickQuestions(companyId, departmentId, n = 5) {
    const rows = await db
      .prepare(
        `SELECT q.id,q.question,q.category,
           (SELECT COUNT(*) FROM interview_questions i WHERE i.question_id=q.id) used
         FROM question_bank q WHERE q.company_id=? AND q.active=1 AND (q.department_id IS NULL OR q.department_id=?)`,
      )
      .all(companyId, departmentId ?? -1);
    const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, []]));
    for (const r of rows) byCat[r.category].push({ ...r, tie: Math.random() });
    for (const list of Object.values(byCat))
      list.sort((a, b) => a.used - b.used || a.tie - b.tie);
    const out = [];
    for (let round = 0; out.length < n && round < n; round++)
      for (const c of CATEGORIES) {
        const next = byCat[c][round];
        if (next && out.length < n) out.push(next);
      }
    return out;
  }

  // ---- scheduling a panel interview -----------------------------------------------------------
  router.post(
    "/api/admin/candidates/:id/interviews",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      if (!OPEN.includes(c.stage))
        throw new HttpError(
          409,
          "This candidate is no longer in the pipeline.",
        );
      const b = await body();
      const ids = [
        ...new Set(
          (Array.isArray(b.interviewer_ids) && b.interviewer_ids.length
            ? b.interviewer_ids
            : [b.interviewer_id]
          ).map((x) => integer(Number(x))),
        ),
      ];
      if (ids.length > 6)
        throw new HttpError(400, "A panel can have up to 6 people.");
      const panel = [];
      for (const id of ids) {
        const u = await owned("users", id, companyId, "interviewer");
        if (!u.active) throw new HttpError(400, "Choose active interviewers.");
        panel.push(u);
      }
      const at = string(b.scheduled_at, "Date and time", 30);
      if (Number.isNaN(Date.parse(at)))
        throw new HttpError(400, "Date and time is invalid.");
      const start = new Date(at).toISOString();
      const round = string(b.round_name ?? "Interview", "Round", 60);
      const mode = oneOf(b.mode ?? "in_person", "Mode", MODES);
      const location = optionalString(b.location, "Location or link", 300);
      const minutes = Math.round(
        number(b.duration_minutes ?? 60, "Duration", 10, 480),
      );
      const opening = c.opening_id
        ? await db
            .prepare("SELECT * FROM job_openings WHERE id=?")
            .get(c.opening_id)
        : null;
      const questions = await pickQuestions(
        companyId,
        opening?.department_id ?? null,
      );
      const panelKey = randomBytes(8).toString("hex");
      const rows = await transaction(async () => {
        const out = [];
        for (const u of panel) {
          const id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO interviews(company_id,candidate_id,round_name,interviewer_id,scheduled_at,mode,location,created_at,panel_key,duration_minutes) VALUES(?,?,?,?,?,?,?,?,?,?)",
                )
                .run(
                  companyId,
                  c.id,
                  round,
                  u.id,
                  start,
                  mode,
                  location,
                  nowIso(),
                  panelKey,
                  minutes,
                )
            ).lastInsertRowid,
          );
          for (const [i, q] of questions.entries())
            await db
              .prepare(
                "INSERT INTO interview_questions(interview_id,question_id,question,category,position) VALUES(?,?,?,?,?)",
              )
              .run(id, q.id, q.question, q.category, i + 1);
          out.push({ id, user: u });
        }
        if (c.stage !== "interview" && c.stage !== "offer")
          await db
            .prepare("UPDATE candidates SET stage='interview' WHERE id=?")
            .run(c.id);
        await db
          .prepare("UPDATE candidates SET updated_at=? WHERE id=?")
          .run(nowIso(), c.id);
        await db
          .prepare(
            "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
          )
          .run(
            c.id,
            "interview_scheduled",
            `${round} with ${panel.map((p) => p.name).join(", ")}`,
            user.id,
            nowIso(),
          );
        await audit("interview_panel_scheduled", {
          candidateId: c.id,
          ids: out.map((o) => o.id),
        });
        return out;
      });
      // Invitations: calendar file to each panelist and to the candidate.
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      const when = new Date(start).toLocaleString("en-IN", {
        timeZone: app.timezone,
        dateStyle: "full",
        timeStyle: "short",
      });
      const summary = `Interview: ${c.name}${opening ? ` (${opening.title})` : ""}`;
      const ics = (uid, who) => [
        {
          filename: "interview.ics",
          content: Buffer.from(
            interviewIcs({
              uid: `${uid}@hrms`,
              start,
              minutes,
              summary:
                who === "candidate" ? `Interview at ${company.name}` : summary,
              description: `${round} · ${mode.replace("_", " ")}`,
              location: location ?? "",
              organizer: company.name,
              now: clock(),
            }),
          ).toString("base64"),
        },
      ];
      for (const r of rows) {
        await app.notify([r.user.id], {
          companyId,
          kind: "interview",
          title: `Interview scheduled: ${c.name}`,
          body: `${round} · ${when}`,
          link: "approvals",
        });
        if (r.user.email)
          await app.notify.mail(
            companyId,
            r.user.email,
            `Interview scheduled: ${c.name}`,
            `${summary}\n\nRound: ${round}\nWhen: ${when} (${minutes} minutes)\nMode: ${mode.replace("_", " ")}${location ? `\nWhere / link: ${location}` : ""}\n\nOpen Approvals in the HR portal for the candidate's CV and suggested questions. A calendar file is attached.`,
            ics(`${r.id}`, "panel"),
          );
      }
      await candidateMail(
        app,
        c,
        "interview_call",
        {
          details: `Round: ${round}\nWhen: ${when}\nMode: ${mode.replace("_", " ")}${location ? `\nWhere / link: ${location}` : ""}`,
        },
        ics(`${rows[0].id}-c`, "candidate"),
      );
      return send(201, {
        id: rows[0].id,
        ids: rows.map((r) => r.id),
        questions: questions.length,
      });
    },
  );

  // ---- interviewer's view of an interview ----------------------------------------------------
  async function accessible(user, id) {
    const i = await owned("interviews", id, user.company_id, "interview");
    if (i.interviewer_id !== user.id && !can(user, "recruitment.manage"))
      throw new HttpError(404, "Interview not found.");
    return i;
  }
  router.get("/api/interviews/:id", async ({ user, params, send }) => {
    const i = await accessible(user, params.id);
    const c = await db
      .prepare("SELECT * FROM candidates WHERE id=?")
      .get(i.candidate_id);
    const opening = c.opening_id
      ? await db
          .prepare(
            "SELECT title,description,qualifications,skills FROM job_openings WHERE id=?",
          )
          .get(c.opening_id)
      : null;
    const company = await db
      .prepare("SELECT name FROM companies WHERE id=?")
      .get(i.company_id);
    const summary = `Interview: ${c.name}${opening ? ` (${opening.title})` : ""}`;
    return send(200, {
      ...i,
      candidate: {
        id: c.id,
        name: c.name,
        qualification: c.qualification,
        experience_years: c.experience_years,
        skills: JSON.parse(c.skills || "[]"),
        notes: c.notes,
        match_score: c.match_score,
        resume_url: c.resume_url,
      },
      opening: opening && {
        ...opening,
        skills: JSON.parse(opening.skills || "[]"),
      },
      files: await db
        .prepare(
          "SELECT id,name,mime,size FROM candidate_files WHERE candidate_id=?",
        )
        .all(c.id),
      questions: await db
        .prepare(
          "SELECT id,question,category,position,rating FROM interview_questions WHERE interview_id=? ORDER BY position",
        )
        .all(i.id),
      panel: i.panel_key
        ? await db
            .prepare(
              "SELECT u.name,x.status FROM interviews x JOIN users u ON u.id=x.interviewer_id WHERE x.panel_key=? ORDER BY u.name",
            )
            .all(i.panel_key)
        : [],
      calendar_link: googleCalendarLink({
        start: i.scheduled_at,
        minutes: i.duration_minutes,
        summary,
        description: `${i.round_name} at ${company.name}`,
        location: i.location,
      }),
    });
  });
  router.get(
    "/api/interviews/:id/files/:fileId",
    async ({ user, params, res, headers }) => {
      const i = await accessible(user, params.id);
      const f = await db
        .prepare("SELECT * FROM candidate_files WHERE id=? AND candidate_id=?")
        .get(integer(Number(params.fileId)), i.candidate_id);
      if (!f) throw new HttpError(404, "File not found.");
      const ext = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
      }[f.mime];
      res.writeHead(200, {
        ...headers,
        "Content-Type": f.mime,
        "Content-Disposition": `inline; filename="${f.name}.${ext}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(await app.blobs.bytes(f.data));
    },
  );
  router.get(
    "/api/interviews/:id/calendar.ics",
    async ({ user, params, res, headers }) => {
      const i = await accessible(user, params.id);
      const c = await db
        .prepare("SELECT name FROM candidates WHERE id=?")
        .get(i.candidate_id);
      res.writeHead(200, {
        ...headers,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'attachment; filename="interview.ics"',
      });
      res.end(
        interviewIcs({
          uid: `${i.id}@hrms`,
          start: i.scheduled_at,
          minutes: i.duration_minutes,
          summary: `Interview: ${c.name}`,
          description: i.round_name,
          location: i.location ?? "",
          now: clock(),
        }),
      );
    },
  );

  // ---- HR: timeline, consolidated scorecard, analytics ------------------------------------------
  const roundsOf = async (candidateId) => {
    const rows = await db
      .prepare(
        "SELECT i.*,u.name interviewer_name FROM interviews i JOIN users u ON u.id=i.interviewer_id WHERE i.candidate_id=? ORDER BY i.scheduled_at,i.id",
      )
      .all(candidateId);
    const groups = new Map();
    for (const r of rows) {
      const k = r.panel_key ?? `single-${r.id}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    return [...groups.values()];
  };
  router.get(
    "/api/admin/candidates/:id/interview-timeline",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const rounds = await roundsOf(c.id);
      return send(
        200,
        rounds.map((g) => {
          const live = g.filter((x) => x.status !== "cancelled");
          return {
            round_name: g[0].round_name,
            scheduled_at: g[0].scheduled_at,
            mode: g[0].mode,
            location: g[0].location,
            state: !live.length
              ? "cancelled"
              : live.every((x) => x.status === "completed")
                ? "complete"
                : live.some((x) => x.status === "completed")
                  ? "partial"
                  : g[0].scheduled_at < nowIso()
                    ? "feedback_overdue"
                    : "upcoming",
            panel: g.map((x) => ({
              interview_id: x.id,
              name: x.interviewer_name,
              status: x.status,
              rating: x.rating,
              recommendation: x.recommendation,
            })),
          };
        }),
      );
    },
  );
  router.get(
    "/api/admin/candidates/:id/scorecard",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const rounds = await roundsOf(c.id);
      const all = [];
      const out = rounds.map((g) => {
        const done = g.filter(
          (x) => x.status === "completed" && x.rating != null,
        );
        all.push(...done);
        return {
          round_name: g[0].round_name,
          scheduled_at: g[0].scheduled_at,
          avg_rating: avg(done.map((x) => x.rating)),
          panel: g.map((x) => ({
            name: x.interviewer_name,
            status: x.status,
            rating: x.rating,
            recommendation: x.recommendation,
            feedback: x.feedback,
          })),
        };
      });
      const qs = await db
        .prepare(
          `SELECT q.question,q.category,COUNT(q.rating) n,ROUND(AVG(q.rating)::numeric,2) avg_rating
           FROM interview_questions q JOIN interviews i ON i.id=q.interview_id
           WHERE i.candidate_id=? AND q.rating IS NOT NULL GROUP BY q.question,q.category ORDER BY q.question`,
        )
        .all(c.id);
      const overall = avg(all.map((x) => x.rating));
      const tally = {};
      for (const x of all)
        tally[x.recommendation] = (tally[x.recommendation] ?? 0) + 1;
      const net = all.reduce(
        (a, x) => a + (REC_SCORE[x.recommendation] ?? 0),
        0,
      );
      return send(200, {
        candidate: { id: c.id, name: c.name, match_score: c.match_score },
        rounds: out,
        question_scores: qs.map(num),
        overall_rating: overall,
        feedback_given: all.length,
        feedback_expected: rounds.flat().filter((x) => x.status !== "cancelled")
          .length,
        recommendations: tally,
        summary:
          overall == null
            ? "No feedback yet"
            : overall >= 4 && net > 0
              ? "Panel leans towards hiring"
              : overall < 2.5 || net < 0
                ? "Panel leans against hiring"
                : "Mixed — discuss before deciding",
      });
    },
  );
  router.get(
    "/api/admin/interviews/analytics",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const rows = await db
        .prepare(
          `SELECT i.id,i.candidate_id,i.panel_key,i.round_name,i.interviewer_id,i.status,i.rating,i.recommendation,u.name interviewer_name,
             COALESCE(d.name,'Unassigned') department
           FROM interviews i JOIN users u ON u.id=i.interviewer_id JOIN candidates c ON c.id=i.candidate_id
           LEFT JOIN job_openings o ON o.id=c.opening_id LEFT JOIN departments d ON d.id=o.department_id
           WHERE i.company_id=? AND i.status<>'cancelled'`,
        )
        .all(companyId);
      const done = rows.filter(
        (r) => r.status === "completed" && r.rating != null,
      );
      const dept = {};
      for (const r of rows) {
        const d = (dept[r.department] ??= {
          department: r.department,
          interviews: 0,
          completed: 0,
          ratings: [],
        });
        d.interviews++;
        if (r.status === "completed") d.completed++;
        if (r.rating != null) d.ratings.push(r.rating);
      }
      // Consistency: how far each panelist's rating sits from the rest of the same panel's mean.
      const groups = new Map();
      for (const r of done) {
        const k = `${r.candidate_id}:${r.panel_key ?? r.id}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(r);
      }
      const pan = {};
      for (const r of rows) {
        const p = (pan[r.interviewer_id] ??= {
          name: r.interviewer_name,
          scheduled: 0,
          completed: 0,
          ratings: [],
          dev: [],
        });
        p.scheduled++;
        if (r.status === "completed") p.completed++;
        if (r.rating != null) p.ratings.push(r.rating);
      }
      for (const g of groups.values())
        if (g.length > 1)
          for (const r of g) {
            const others = g.filter((x) => x !== r).map((x) => x.rating);
            pan[r.interviewer_id].dev.push(Math.abs(r.rating - avg(others)));
          }
      const questions = await db
        .prepare(
          `SELECT b.id,b.question,b.category,COALESCE(d.name,'All departments') department,COUNT(iq.id) used,COUNT(iq.rating) scored,ROUND(AVG(iq.rating)::numeric,2) avg_rating
           FROM question_bank b LEFT JOIN departments d ON d.id=b.department_id
           JOIN interview_questions iq ON iq.question_id=b.id JOIN interviews i ON i.id=iq.interview_id AND i.company_id=b.company_id
           WHERE b.company_id=? GROUP BY b.id,b.question,b.category,d.name ORDER BY used DESC LIMIT 25`,
        )
        .all(companyId);
      return send(200, {
        interviews: rows.length,
        feedback_rate: rows.length
          ? Math.round(
              (rows.filter((r) => r.status === "completed").length /
                rows.length) *
                100,
            )
          : null,
        avg_rating: avg(done.map((r) => r.rating)),
        departments: Object.values(dept).map((d) => ({
          department: d.department,
          interviews: d.interviews,
          completed: d.completed,
          avg_rating: avg(d.ratings),
        })),
        panelists: Object.values(pan).map((p) => ({
          name: p.name,
          scheduled: p.scheduled,
          completed: p.completed,
          avg_rating: avg(p.ratings),
          avg_deviation: avg(p.dev),
        })),
        questions: questions.map(num),
      });
    },
  );
}
