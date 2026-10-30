import { HttpError, integer, isoDate, oneOf, optionalString, string } from "../http.js";
import { branchScope } from "../scope.js";

// Engagement surveys and eNPS ("How likely are you to recommend working here?", 0-10).
// Anonymous by design: survey_responders says who answered (to stop answering twice and
// count the response rate) and survey_responses holds answers with no person, only the
// department, branch and date. Results, and each department or branch within them, show
// only once MIN_GROUP people have answered; comments come back in a fixed (sorted) order.
export const MIN_GROUP = 5;
const TYPES = ["enps", "rating", "choice", "text"];
export const ENPS_TEXT = "How likely are you to recommend working here to a friend? (0 = not at all, 10 = definitely)";

export function cleanQuestions(list) {
  if (!Array.isArray(list) || !list.length || list.length > 30) throw new HttpError(400, "Add 1 to 30 questions.");
  return list.map((q, i) => {
    const type = oneOf(q?.type, `Question ${i + 1} type`, TYPES);
    const out = { id: `q${i + 1}`, type, text: type === "enps" && !q.text ? ENPS_TEXT : string(q.text, `Question ${i + 1}`, 300) };
    if (type === "choice") {
      const options = (Array.isArray(q.options) ? q.options : []).map((o) => String(o ?? "").trim()).filter(Boolean);
      if (options.length < 2 || options.length > 10 || options.some((o) => o.length > 100))
        throw new HttpError(400, `Question ${i + 1}: give 2 to 10 choices.`);
      out.options = [...new Set(options)];
    }
    return out;
  });
}

/** Checks one person's answers against the questions; every question but comments is required. */
export function cleanAnswers(questions, given) {
  if (!given || typeof given !== "object") throw new HttpError(400, "Answer the questions.");
  const out = {};
  for (const q of questions) {
    const v = given[q.id];
    if (q.type === "text") {
      const t = typeof v === "string" ? v.trim() : "";
      if (t.length > 1000) throw new HttpError(400, "Keep each comment under 1,000 characters.");
      if (t) out[q.id] = t;
      continue;
    }
    if (v === undefined || v === null || v === "") throw new HttpError(400, `Answer: ${q.text}`);
    if (q.type === "enps" || q.type === "rating") {
      const n = Number(v);
      const max = q.type === "enps" ? 10 : 5;
      const min = q.type === "enps" ? 0 : 1;
      if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, `Answer ${min} to ${max}: ${q.text}`);
      out[q.id] = n;
    } else {
      if (!q.options.includes(v)) throw new HttpError(400, `Choose one of the options: ${q.text}`);
      out[q.id] = v;
    }
  }
  return out;
}

/** Totals for a set of answers: eNPS, averages, choice counts, sorted comments. */
export function summarise(questions, rows) {
  const answers = rows.map((r) => JSON.parse(r.answers));
  return questions.map((q) => {
    const vals = answers.map((a) => a[q.id]).filter((v) => v !== undefined);
    if (q.type === "enps") {
      const promoters = vals.filter((v) => v >= 9).length,
        detractors = vals.filter((v) => v <= 6).length;
      return {
        ...q,
        answers: vals.length,
        promoters,
        passives: vals.length - promoters - detractors,
        detractors,
        score: vals.length ? Math.round(((promoters - detractors) / vals.length) * 100) : null,
      };
    }
    if (q.type === "rating")
      return {
        ...q,
        answers: vals.length,
        average: vals.length ? Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10 : null,
        counts: [1, 2, 3, 4, 5].map((n) => vals.filter((v) => v === n).length),
      };
    if (q.type === "choice") return { ...q, answers: vals.length, counts: q.options.map((o) => vals.filter((v) => v === o).length) };
    return { ...q, answers: vals.length, comments: [...vals].sort((a, b) => a.localeCompare(b)) };
  });
}

export function registerSurveys(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  // Who a survey is for: everyone, or the chosen branches and/or departments.
  const audienceSql = (aud) => {
    const where = ["u.company_id=?", "u.active=1", "u.role<>'super_admin'"];
    const params = [];
    if (aud.branch_ids?.length) where.push(`u.branch_id IN (${aud.branch_ids.map(() => "?").join(",")})`), params.push(...aud.branch_ids);
    if (aud.department_ids?.length) where.push(`u.department_id IN (${aud.department_ids.map(() => "?").join(",")})`), params.push(...aud.department_ids);
    return { where: where.join(" AND "), params };
  };
  const status = (s) => (s.status === "open" && s.closes_on < today() ? "closed" : s.status);
  const owned = async (id, companyId) => {
    const s = await db.prepare("SELECT * FROM surveys WHERE id=? AND company_id=?").get(integer(Number(id)), companyId);
    if (!s) throw new HttpError(404, "Survey not found.");
    return { ...s, questions: JSON.parse(s.questions), audience: JSON.parse(s.audience), status: status(s) };
  };
  const eligible = async (s, companyId) => {
    const a = audienceSql(s.audience);
    return Number((await db.prepare(`SELECT COUNT(*) n FROM users u WHERE ${a.where}`).get(companyId, ...a.params)).n);
  };

  // ---- HR ----------------------------------------------------------------------------------
  router.get("/api/admin/surveys", { perm: "surveys.manage" }, async ({ companyId, send }) => {
    const rows = await db
      .prepare(
        `SELECT s.*,(SELECT COUNT(*) FROM survey_responders r WHERE r.survey_id=s.id) answered FROM surveys s WHERE s.company_id=? ORDER BY s.id DESC LIMIT 100`,
      )
      .all(companyId);
    const out = [];
    for (const s of rows) {
      const x = { ...s, questions: JSON.parse(s.questions), audience: JSON.parse(s.audience), status: status(s), answered: Number(s.answered) };
      out.push({ ...x, eligible: await eligible(x, companyId) });
    }
    return send(200, { surveys: out, min_group: MIN_GROUP, enps_text: ENPS_TEXT });
  });

  router.post("/api/admin/surveys", { perm: "surveys.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const closes = isoDate(b.closes_on, "Closes on");
    if (!closes || closes < today()) throw new HttpError(400, "Choose a closing date from today on.");
    const ids = (list, table, label) => {
      if (!Array.isArray(list)) return [];
      return [...new Set(list.map((v) => integer(Number(v))))].slice(0, 200).map((id) => ({ id, table, label }));
    };
    const aud = { branch_ids: [], department_ids: [] };
    for (const [key, table] of [["branch_ids", "branches"], ["department_ids", "departments"]])
      for (const { id } of ids(b.audience?.[key], table)) {
        if (!(await db.prepare(`SELECT id FROM ${table} WHERE id=? AND company_id=?`).get(id, companyId)))
          throw new HttpError(404, "That branch or department was not found.");
        aud[key].push(id);
      }
    const id = Number(
      (
        await db
          .prepare("INSERT INTO surveys(company_id,title,intro,questions,audience,closes_on,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)")
          .run(companyId, string(b.title, "Title", 120), optionalString(b.intro, "Introduction", 1000), JSON.stringify(cleanQuestions(b.questions)), JSON.stringify(aud), closes, user.id, nowIso())
      ).lastInsertRowid,
    );
    await audit("survey_created", { id });
    return send(201, { id });
  });

  router.post("/api/admin/surveys/:id/open", { perm: "surveys.manage" }, async ({ companyId, params, send, audit }) => {
    const s = await owned(params.id, companyId);
    if (s.status !== "draft") throw new HttpError(409, "Only a draft survey can be opened.");
    await db.prepare("UPDATE surveys SET status='open',opened_at=? WHERE id=? AND status='draft'").run(nowIso(), s.id);
    const a = audienceSql(s.audience);
    const people = await db.prepare(`SELECT u.id FROM users u WHERE ${a.where}`).all(companyId, ...a.params);
    await app.notify(
      people.map((p) => p.id),
      { companyId, kind: "survey", title: `Survey: ${s.title}`, body: `Anonymous. Open until ${s.closes_on}.`, link: "surveys" },
    );
    await audit("survey_opened", { id: s.id, people: people.length });
    return send(200, { ok: true, people: people.length });
  });

  router.post("/api/admin/surveys/:id/close", { perm: "surveys.manage" }, async ({ companyId, params, send, audit }) => {
    const s = await owned(params.id, companyId);
    if (s.status !== "open") throw new HttpError(409, "Only an open survey can be closed.");
    await db.prepare("UPDATE surveys SET status='closed',closes_on=? WHERE id=?").run(today() < s.closes_on ? today() : s.closes_on, s.id);
    await audit("survey_closed", { id: s.id });
    return send(200, { ok: true });
  });

  router.delete("/api/admin/surveys/:id", { perm: "surveys.manage" }, async ({ companyId, params, send, audit }) => {
    const s = await owned(params.id, companyId);
    if (s.status !== "draft") throw new HttpError(409, "Only a draft can be deleted; close an open survey instead.");
    await db.prepare("DELETE FROM surveys WHERE id=?").run(s.id);
    await audit("survey_deleted", { id: s.id });
    return send(200, { ok: true });
  });

  // Results: overall, and per department or branch, each only with enough answers.
  router.get("/api/admin/surveys/:id/results", { perm: "surveys.manage" }, async ({ user, companyId, params, query, send }) => {
    const s = await owned(params.id, companyId);
    const by = query.get("by") ? oneOf(query.get("by"), "Group by", ["department", "branch"]) : null;
    // A branch-limited HR role sees answers from its branches only.
    const scope = user.branch_scope?.length ? user.branch_scope : null;
    const rows = await db
      .prepare(`SELECT department_id,branch_id,answers FROM survey_responses WHERE survey_id=?${scope ? ` AND branch_id IN (${scope.map(() => "?").join(",")})` : ""}`)
      .all(s.id, ...(scope ?? []));
    const answered = Number((await db.prepare("SELECT COUNT(*) n FROM survey_responders WHERE survey_id=?").get(s.id)).n);
    const out = {
      survey: { id: s.id, title: s.title, status: s.status, closes_on: s.closes_on, questions: s.questions },
      answered,
      eligible: await eligible(s, companyId),
      min_group: MIN_GROUP,
      hidden: rows.length < MIN_GROUP,
      results: rows.length < MIN_GROUP ? null : summarise(s.questions, rows),
      groups: [],
    };
    if (by && rows.length >= MIN_GROUP) {
      const key = by === "department" ? "department_id" : "branch_id";
      const names = new Map(
        (await db.prepare(`SELECT id,name FROM ${by === "department" ? "departments" : "branches"} WHERE company_id=?`).all(companyId)).map((r) => [r.id, r.name]),
      );
      const groups = new Map();
      for (const r of rows) groups.set(r[key] ?? 0, [...(groups.get(r[key] ?? 0) ?? []), r]);
      for (const [gid, list] of groups) {
        const enps = summarise(s.questions.filter((q) => q.type !== "text"), list);
        out.groups.push({
          id: gid,
          name: names.get(gid) ?? "Not set",
          answers: list.length,
          hidden: list.length < MIN_GROUP,
          // Comments are never shown per group: a small group could identify the writer.
          results: list.length < MIN_GROUP ? null : enps,
        });
      }
      out.groups.sort((a, b) => b.answers - a.answers);
    }
    return send(200, out);
  });

  // ---- everyone --------------------------------------------------------------------------
  // The same people a survey counts as its audience: active staff, not the platform administrator.
  const forMe = async (user) => {
    if (user.role === "super_admin" || !user.active) return [];
    const rows = await db
      .prepare(
        `SELECT s.*,EXISTS(SELECT 1 FROM survey_responders r WHERE r.survey_id=s.id AND r.user_id=?) answered FROM surveys s WHERE s.company_id=? AND s.status='open' AND s.closes_on>=? ORDER BY s.closes_on`,
      )
      .all(user.id, user.company_id, today());
    return rows
      .map((s) => ({ ...s, questions: JSON.parse(s.questions), audience: JSON.parse(s.audience), answered: Boolean(s.answered) }))
      .filter(
        (s) =>
          (!s.audience.branch_ids?.length || s.audience.branch_ids.includes(user.branch_id)) &&
          (!s.audience.department_ids?.length || s.audience.department_ids.includes(user.department_id)),
      )
      .map(({ audience, created_by, ...s }) => s);
  };
  router.get("/api/surveys", async ({ user, send }) => send(200, await forMe(user)));

  router.post("/api/surveys/:id/respond", async ({ user, params, body, send }) => {
    const s = (await forMe(user)).find((x) => x.id === integer(Number(params.id)));
    if (!s) throw new HttpError(404, "This survey is not open for you.");
    if (s.answered) throw new HttpError(409, "You have already answered this survey.");
    const answers = cleanAnswers(s.questions, (await body()).answers);
    await transaction(async () => {
      const r = await db.prepare("INSERT INTO survey_responders(survey_id,user_id) VALUES(?,?) ON CONFLICT DO NOTHING").run(s.id, user.id);
      if (!r.changes) throw new HttpError(409, "You have already answered this survey.");
      await db
        .prepare("INSERT INTO survey_responses(survey_id,department_id,branch_id,answers,submitted_on) VALUES(?,?,?,?,?)")
        .run(s.id, user.department_id ?? null, user.branch_id ?? null, JSON.stringify(answers), today());
    });
    // Not in the activity log with the person: the log would link them to the time of an answer.
    return send(201, { ok: true });
  });
}
