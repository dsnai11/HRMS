import { HttpError, integer, oneOf, optionalString } from "../http.js";
import { staffWith } from "../scope.js";

// The hiring manager and the department head see who applied for their openings, with the
// ATS score, screening answers and resume, and tell HR what they think. HR still moves the
// candidate through the stages.

export const TEAM_VIEWS = {
  shortlist: "Shortlist",
  hold: "Keep on hold",
  not_suitable: "Not suitable",
};

/** The people who look after an opening besides HR: hiring manager, requester, department head. */
export async function openingTeam(db, openingId) {
  const o = await db
    .prepare(
      "SELECT o.hiring_manager_id,o.requested_by,d.head_id FROM job_openings o LEFT JOIN departments d ON d.id=o.department_id WHERE o.id=?",
    )
    .get(openingId);
  return o ? [...new Set([o.hiring_manager_id, o.requested_by, o.head_id].filter(Boolean))] : [];
}

export function registerHiringTeam(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const mine = (user) =>
    db
      .prepare(
        `SELECT o.id,o.title,o.status,o.positions,o.published,o.approval_status,o.closing_date,d.name department_name,b.name branch_name
         FROM job_openings o LEFT JOIN departments d ON d.id=o.department_id LEFT JOIN branches b ON b.id=o.branch_id
         WHERE o.company_id=? AND (o.hiring_manager_id=? OR o.requested_by=? OR d.head_id=?) ORDER BY o.id DESC LIMIT 100`,
      )
      .all(user.company_id, user.id, user.id, user.id);
  // A candidate this person may see: on one of their openings.
  const reachable = async (user, candidateId) => {
    const c = await db.prepare("SELECT * FROM candidates WHERE id=? AND company_id=?").get(integer(Number(candidateId)), user.company_id);
    if (!c || !c.opening_id || !(await openingTeam(db, c.opening_id)).includes(user.id))
      throw new HttpError(404, "Candidate not found.");
    return c;
  };

  router.get("/api/team-hiring", async ({ user, send }) => {
    const openings = await mine(user);
    if (!openings.length) return send(200, { company_id: user.company_id, openings: [], candidates: [] });
    const ids = openings.map((o) => o.id);
    const questions = new Map(
      (await db.prepare(`SELECT id,screening FROM job_openings WHERE id IN (${ids.map(() => "?").join(",")})`).all(...ids)).map(
        (o) => [o.id, JSON.parse(o.screening || "[]")],
      ),
    );
    const rows = await db
      .prepare(
        `SELECT c.id,c.opening_id,c.name,c.email,c.phone,c.stage,c.source,c.match_score,c.match_detail,c.experience_years,c.qualification,
           c.skills,c.screening,c.expected_ctc,c.notice_days,c.created_at,c.team_view,c.team_view_note,c.team_view_at,v.name team_view_name,
           (SELECT f.id FROM candidate_files f WHERE f.candidate_id=c.id AND f.kind='resume' ORDER BY f.id DESC LIMIT 1) resume_id
         FROM candidates c LEFT JOIN users v ON v.id=c.team_view_by
         WHERE c.opening_id IN (${ids.map(() => "?").join(",")})
         ORDER BY c.match_score DESC NULLS LAST, c.id DESC LIMIT 1000`,
      )
      .all(...ids);
    const counts = new Map();
    for (const r of rows) counts.set(r.opening_id, (counts.get(r.opening_id) || 0) + 1);
    return send(200, {
      company_id: user.company_id,
      openings: openings.map((o) => ({ ...o, applicants: counts.get(o.id) || 0 })),
      candidates: rows.map((r) => {
        const s = r.screening ? JSON.parse(r.screening) : null;
        return {
          ...r,
          skills: JSON.parse(r.skills || "[]"),
          match_detail: JSON.parse(r.match_detail || "null"),
          screening: s?.answers
            ? (questions.get(r.opening_id) || []).map((q) => ({ question: q.text, answer: s.answers[q.id] ?? null, failed: (s.failed || []).includes(q.text) }))
            : [],
        };
      }),
    });
  });

  router.get("/api/team-hiring/files/:id", async ({ user, params, res, headers }) => {
    const f = await db.prepare("SELECT * FROM candidate_files WHERE id=?").get(integer(Number(params.id)));
    if (!f) throw new HttpError(404, "File not found.");
    await reachable(user, f.candidate_id);
    const safe = f.name.replace(/[^\w.\- ]+/g, "_");
    res.writeHead(200, {
      ...headers,
      "Content-Type": f.mime,
      "Content-Disposition": `inline; filename="${safe}"`,
      "Cache-Control": "private, no-store",
    });
    res.end(await app.blobs.bytes(f.data));
  });

  router.post("/api/team-hiring/candidates/:id/view", async ({ user, params, body, send, audit }) => {
    const c = await reachable(user, params.id);
    const b = await body();
    const view = oneOf(b.view, "Your view", Object.keys(TEAM_VIEWS));
    const note = optionalString(b.note, "Note", 500) || null;
    if (view === "not_suitable" && !note) throw new HttpError(400, "Say briefly why the candidate is not suitable.");
    const at = nowIso();
    await db
      .prepare("UPDATE candidates SET team_view=?,team_view_note=?,team_view_by=?,team_view_at=? WHERE id=?")
      .run(view, note, user.id, at, c.id);
    await db
      .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
      .run(c.id, "note", `${user.name}: ${TEAM_VIEWS[view]}${note ? ` (${note})` : ""}`.slice(0, 500), user.id, at);
    await audit("candidate_team_view", { id: c.id, view });
    const hr = (await staffWith(db, user.company_id, ["recruitment.manage"], user.id)).map((r) => r.id);
    if (hr.length)
      await app.notify(hr, {
        companyId: user.company_id,
        kind: "hiring",
        title: `${user.name}: ${TEAM_VIEWS[view]} · ${c.name}`,
        body: note,
        link: "hiring",
      });
    return send(200, { ok: true });
  });
}
