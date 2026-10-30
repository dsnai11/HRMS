import { createHash, randomBytes } from "node:crypto";
import { HttpError, clientIp, integer, isoDate, number, oneOf, optionalId, optionalString, string } from "../http.js";
import { rescoreCandidate } from "./recruitment-plus.js";
export { cleanScreening, evaluateScreening, publicScreening } from "../screening.js";

// RMS, further: the talent pool across every job, adding a past candidate to another job,
// bulk stage changes, screening questions with knock-out rules, interview slots the
// candidate picks, the agency portal and the hiring report with cost per hire.
const sha = (s) => createHash("sha256").update(s).digest("hex");
const digits = (p) => String(p ?? "").replace(/\D/g, "").slice(-10);
const OPEN = ["applied", "screening", "interview", "offer"];
const STAGE_LABEL = {
  applied: "Received",
  screening: "Shortlisted",
  interview: "Interviewing",
  offer: "Offered",
  hired: "Hired",
  rejected: "Not selected",
  withdrawn: "Withdrawn",
};

export function registerRmsPlus(router, app) {
  const { db, transaction, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = async (table, id, companyId, label) => {
    const r = await db.prepare(`SELECT * FROM ${table} WHERE id=? AND company_id=?`).get(integer(Number(id)), companyId);
    if (!r) throw new HttpError(404, `That ${label} was not found.`);
    return r;
  };
  const base = (req) => (process.env.PUBLIC_URL ? new URL(process.env.PUBLIC_URL).origin : `http://${req.headers.host}`);

  // ---- talent pool ---------------------------------------------------------------------------
  router.get("/api/admin/rms/talent", { perm: "recruitment.manage" }, async ({ companyId, query, send }) => {
    const where = ["c.company_id=?"],
      params = [companyId];
    for (const w of String(query.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)) {
      where.push("LOWER(CONCAT_WS(' ',c.name,c.email,c.phone,c.skills,c.location,c.qualification,c.resume_text)) LIKE ?");
      params.push(`%${w}%`);
    }
    for (const s of String(query.get("skills") ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean).slice(0, 8)) {
      where.push("LOWER(c.skills) LIKE ?");
      params.push(`%"${s.replace(/"/g, "")}%`);
    }
    if (query.get("location")) {
      where.push("LOWER(COALESCE(c.location,'')||' '||COALESCE(c.resume_text,'')) LIKE ?");
      params.push(`%${String(query.get("location")).toLowerCase().slice(0, 60)}%`);
    }
    if (query.get("min_exp")) where.push("c.experience_years>=?"), params.push(number(Number(query.get("min_exp")), "Experience from", 0, 60));
    if (query.get("max_exp")) where.push("c.experience_years<=?"), params.push(number(Number(query.get("max_exp")), "Experience up to", 0, 60));
    const stage = query.get("stage");
    if (stage === "open") where.push(`c.stage IN (${OPEN.map(() => "?").join(",")})`), params.push(...OPEN);
    else if (stage) where.push("c.stage=?"), params.push(oneOf(stage, "Stage", Object.keys(STAGE_LABEL)));
    const page = Math.max(0, Math.min(1000, Number(query.get("page")) || 0));
    const sql = `FROM candidates c LEFT JOIN job_openings o ON o.id=c.opening_id WHERE ${where.join(" AND ")}`;
    const total = Number((await db.prepare(`SELECT COUNT(*) n ${sql}`).get(...params)).n);
    const rows = await db
      .prepare(
        `SELECT c.id,c.name,c.email,c.phone,c.stage,c.skills,c.experience_years,c.location,c.source,c.match_score,c.updated_at,c.opening_id,o.title opening_title,
           (SELECT f.id FROM candidate_files f WHERE f.candidate_id=c.id AND f.kind='resume' ORDER BY f.id DESC LIMIT 1) resume_id
         ${sql} ORDER BY c.updated_at DESC,c.id DESC LIMIT 50 OFFSET ${page * 50}`,
      )
      .all(...params);
    return send(200, { rows: rows.map((r) => ({ ...r, skills: JSON.parse(r.skills || "[]") })), total, page, page_size: 50 });
  });

  // A past candidate considered for another job: a new record on that job, with the resume.
  router.post("/api/admin/candidates/:id/copy", { perm: "recruitment.manage" }, async ({ user, params, companyId, body, send, audit }) => {
    const c = await owned("candidates", params.id, companyId, "candidate");
    const o = await owned("job_openings", (await body()).opening_id, companyId, "job opening");
    if (o.status === "closed") throw new HttpError(409, "That job is closed.");
    if (c.opening_id === o.id) throw new HttpError(409, "They are already on this job.");
    const there = await db
      .prepare(
        `SELECT id FROM candidates WHERE company_id=? AND opening_id=? AND ((? <> '' AND lower(email)=?) OR (? <> '' AND RIGHT(regexp_replace(COALESCE(phone,''),'[^0-9]','','g'),10)=?))`,
      )
      .get(companyId, o.id, c.email ?? "", (c.email ?? "").toLowerCase(), digits(c.phone), digits(c.phone));
    if (there) throw new HttpError(409, "They are already on this job.");
    const at = nowIso();
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              `INSERT INTO candidates(company_id,opening_id,name,email,phone,source,expected_ctc,notice_days,notes,created_by,created_at,updated_at,skills,experience_years,qualification,resume_text,location)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(companyId, o.id, c.name, c.email, c.phone, "Talent pool", c.expected_ctc, c.notice_days, null, user.id, at, at, c.skills, c.experience_years, c.qualification, c.resume_text, c.location)
        ).lastInsertRowid,
      );
      const f = await db.prepare("SELECT * FROM candidate_files WHERE candidate_id=? AND kind='resume' ORDER BY id DESC LIMIT 1").get(c.id);
      if (f)
        await db
          .prepare("INSERT INTO candidate_files(candidate_id,kind,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, "resume", f.name, f.mime, f.size, f.data, at);
      await db
        .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
        .run(id, "added", `Added from the talent pool (earlier for job J${c.opening_id ?? "-"})`, user.id, at);
      await rescoreCandidate(db, id);
      return id;
    });
    await audit("candidate_copied", { from: c.id, id, opening: o.id });
    return send(201, { id });
  });

  // ---- bulk actions --------------------------------------------------------------------------
  router.post("/api/admin/candidates/bulk", { perm: "recruitment.manage" }, async ({ user, companyId, body, send }) => {
    const b = await body();
    const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map((v) => integer(Number(v))))];
    if (!ids.length || ids.length > 200) throw new HttpError(400, "Choose 1 to 200 candidates.");
    const results = [];
    for (const id of ids) {
      try {
        const c = await db.prepare("SELECT * FROM candidates WHERE id=? AND company_id=?").get(id, companyId);
        if (!c) throw new HttpError(404, "Not found.");
        await app.moveCandidateStage(c, b.stage, b.reason, user, companyId);
        results.push({ id, ok: true });
      } catch (e) {
        if (!e.status) throw e;
        results.push({ id, ok: false, error: e.message });
      }
    }
    return send(200, { moved: results.filter((r) => r.ok).length, results });
  });

  // ---- interview slots the candidate picks ------------------------------------------------------
  router.post("/api/admin/candidates/:id/interview-invites", { perm: "recruitment.manage" }, async ({ req, user, params, companyId, body, send, audit }) => {
    const c = await owned("candidates", params.id, companyId, "candidate");
    if (!OPEN.includes(c.stage)) throw new HttpError(409, "This candidate is no longer in the pipeline.");
    if (!c.email) throw new HttpError(400, "The candidate needs an email address to get the link.");
    const b = await body();
    const slots = [...new Set((Array.isArray(b.slots) ? b.slots : []).map((s) => {
      const ms = Date.parse(String(s));
      if (Number.isNaN(ms)) throw new HttpError(400, "A slot time is not valid.");
      if (ms < clock() + 3600000) throw new HttpError(400, "Offer slots at least an hour from now.");
      return new Date(ms).toISOString();
    }))].sort();
    if (slots.length < 1 || slots.length > 12) throw new HttpError(400, "Offer 1 to 12 slots.");
    const ids = [...new Set((Array.isArray(b.interviewer_ids) ? b.interviewer_ids : []).map((x) => integer(Number(x))))];
    if (!ids.length || ids.length > 6) throw new HttpError(400, "Choose 1 to 6 interviewers.");
    for (const id of ids) {
      const u = await db.prepare("SELECT active FROM users WHERE id=? AND company_id=?").get(id, companyId);
      if (!u?.active) throw new HttpError(400, "Choose active interviewers.");
    }
    const minutes = Math.round(number(b.duration_minutes ?? 45, "Duration", 10, 480));
    const token = randomBytes(24).toString("base64url");
    await db.prepare("UPDATE interview_invites SET status='cancelled' WHERE candidate_id=? AND status='open'").run(c.id);
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO interview_invites(company_id,candidate_id,round_name,mode,location,duration_minutes,interviewer_ids,slots,token_hash,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            companyId,
            c.id,
            string(b.round_name ?? "Interview", "Round", 60),
            oneOf(b.mode ?? "in_person", "Mode", ["in_person", "phone", "video"]),
            optionalString(b.location, "Location or link", 300),
            minutes,
            JSON.stringify(ids),
            JSON.stringify(slots),
            sha(token),
            user.id,
            nowIso(),
            slots.at(-1),
          )
      ).lastInsertRowid,
    );
    const link = `${base(req)}/careers.html?slot=${token}`;
    await app.notify.mail(
      companyId,
      c.email,
      "Choose a time for your interview",
      `Dear ${c.name},\n\nPlease choose a time for your interview that suits you:\n${link}\n\nThe link works once. If none of the times suit you, reply to this email.`,
    );
    await db
      .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
      .run(c.id, "note", `Sent ${slots.length} interview slot(s) to choose from`, user.id, nowIso());
    await audit("interview_slots_sent", { id, candidateId: c.id, slots: slots.length });
    return send(201, { id, link });
  });

  const inviteBy = async (token) => {
    const inv = await db.prepare("SELECT * FROM interview_invites WHERE token_hash=?").get(sha(String(token)));
    if (!inv) throw new HttpError(404, "This link is not valid.");
    return inv;
  };
  // Slots still free: not past, and no panel member already booked at that time.
  const freeSlots = async (inv) => {
    const ids = JSON.parse(inv.interviewer_ids);
    const slots = JSON.parse(inv.slots).filter((s) => Date.parse(s) > clock() + 15 * 60000);
    const busy = await db
      .prepare(
        `SELECT scheduled_at,COALESCE(duration_minutes,60) d FROM interviews WHERE status='scheduled' AND interviewer_id IN (${ids.map(() => "?").join(",")})`,
      )
      .all(...ids);
    return slots.filter((s) => {
      const a = Date.parse(s),
        b = a + inv.duration_minutes * 60000;
      return !busy.some((x) => {
        const xa = Date.parse(x.scheduled_at);
        return xa < b && a < xa + Number(x.d) * 60000;
      });
    });
  };
  router.get("/api/careers/slots/:token", { public: true }, async ({ req, params, send }) => {
    rateLimit(`slots:${clientIp(req)}`, 120);
    const inv = await inviteBy(params.token);
    const c = await db.prepare("SELECT name,opening_id FROM candidates WHERE id=?").get(inv.candidate_id);
    const o = c.opening_id ? await db.prepare("SELECT title FROM job_openings WHERE id=?").get(c.opening_id) : null;
    const company = await db.prepare("SELECT name FROM companies WHERE id=?").get(inv.company_id);
    return send(200, {
      company: company.name,
      job: o?.title ?? null,
      name: c.name,
      round: inv.round_name,
      mode: inv.mode,
      minutes: inv.duration_minutes,
      status: inv.status,
      booked_slot: inv.booked_slot,
      slots: inv.status === "open" ? await freeSlots(inv) : [],
      timezone: app.timezone,
    });
  });
  router.post("/api/careers/slots/:token", { public: true }, async ({ req, params, body, send }) => {
    rateLimit(`slots:${clientIp(req)}`, 30);
    const inv = await inviteBy(params.token);
    if (inv.status !== "open") throw new HttpError(409, inv.status === "booked" ? "Your interview is already booked." : "This link is no longer valid.");
    const slot = new Date(Date.parse(String((await body()).slot))).toISOString();
    if (!(await freeSlots(inv)).includes(slot)) throw new HttpError(409, "That time is no longer free. Choose another.");
    // Booking once: only the request that changes the invite from open goes on.
    const took = await db
      .prepare("UPDATE interview_invites SET status='booked',booked_slot=?,booked_at=? WHERE id=? AND status='open'")
      .run(slot, nowIso(), inv.id);
    if (!took.changes) throw new HttpError(409, "Your interview is already booked.");
    const c = await db.prepare("SELECT * FROM candidates WHERE id=?").get(inv.candidate_id);
    try {
      await app.schedulePanel(
        inv.company_id,
        c,
        {
          interviewer_ids: JSON.parse(inv.interviewer_ids),
          scheduled_at: slot,
          round_name: inv.round_name,
          mode: inv.mode,
          location: inv.location,
          duration_minutes: inv.duration_minutes,
        },
        null,
      );
    } catch (e) {
      await db.prepare("UPDATE interview_invites SET status='open',booked_slot=NULL,booked_at=NULL WHERE id=?").run(inv.id);
      throw e;
    }
    return send(201, { ok: true, slot });
  });

  // ---- agency portal ------------------------------------------------------------------------
  // An agency source's key opens its portal: open jobs to submit to, and only its own
  // candidates with their stage. Nothing about other candidates or HR's notes.
  const agencyBy = async (key) => {
    const s = await db
      .prepare("SELECT * FROM intake_sources WHERE key_hash=? AND active=1 AND kind='agency'")
      .get(sha(String(key)));
    if (!s) throw new HttpError(401, "This agency link is not valid or was switched off.");
    return s;
  };
  router.get("/api/agency/:key", { public: true }, async ({ req, params, send }) => {
    rateLimit(`agency:${clientIp(req)}`, 300);
    const s = await agencyBy(params.key);
    const company = await db.prepare("SELECT name FROM companies WHERE id=?").get(s.company_id);
    const jobs = await db
      .prepare(
        `SELECT o.id,o.title,o.location,o.positions,o.min_experience_years,o.skills,o.description,b.name branch_name FROM job_openings o LEFT JOIN branches b ON b.id=o.branch_id
         WHERE o.company_id=? AND o.status='open' AND o.approval_status='approved' ORDER BY o.id DESC`,
      )
      .all(s.company_id);
    const mine = await db
      .prepare(
        `SELECT c.id,c.name,c.stage,o.title opening_title,MIN(x.received_at) received_at FROM candidate_sources x JOIN candidates c ON c.id=x.candidate_id LEFT JOIN job_openings o ON o.id=c.opening_id
         WHERE x.source_id=? GROUP BY c.id,c.name,c.stage,o.title ORDER BY MIN(x.received_at) DESC LIMIT 500`,
      )
      .all(s.id);
    return send(200, {
      company: company.name,
      agency: s.name,
      jobs: jobs.map((j) => ({ ...j, code: `J${j.id}`, skills: JSON.parse(j.skills || "[]") })),
      submitted: mine.map((c) => ({ name: c.name, job: c.opening_title, status: STAGE_LABEL[c.stage], received_at: c.received_at })),
    });
  });

  // ---- hiring report ------------------------------------------------------------------------
  router.get("/api/admin/rms/report", { perm: "recruitment.manage" }, async ({ companyId, query, send }) => {
    const today = app.dayOf(nowIso());
    const from = isoDate(query.get("from") || `${today.slice(0, 4)}-01-01`, "From"),
      to = isoDate(query.get("to") || today, "To");
    if (from > to) throw new HttpError(400, "From must be before To.");
    const rows = await db
      .prepare(
        `SELECT c.id,c.stage,c.created_at,COALESCE(c.source,'Not recorded') source,b.name branch,r.name recruiter,
           EXISTS(SELECT 1 FROM interviews i WHERE i.candidate_id=c.id) interviewed,
           EXISTS(SELECT 1 FROM offers f WHERE f.candidate_id=c.id) offered,
           (SELECT MIN(e.created_at) FROM candidate_events e WHERE e.candidate_id=c.id AND e.kind='hired') hired_at
         FROM candidates c LEFT JOIN job_openings o ON o.id=c.opening_id LEFT JOIN branches b ON b.id=o.branch_id LEFT JOIN users r ON r.id=o.recruiter_id
         WHERE c.company_id=? AND substr(c.created_at,1,10)>=? AND substr(c.created_at,1,10)<=?`,
      )
      .all(companyId, from, to);
    const sources = await db.prepare("SELECT name,fee_per_hire,monthly_cost FROM intake_sources WHERE company_id=?").all(companyId);
    const months = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
    const group = (key) => {
      const m = new Map();
      for (const r of rows) {
        const k = r[key] ?? "Not set";
        const g = m.get(k) ?? { name: k, received: 0, shortlisted: 0, interviewed: 0, offered: 0, hired: 0, days: [] };
        g.received++;
        if (r.stage !== "applied") g.shortlisted++;
        if (r.interviewed) g.interviewed++;
        if (r.offered) g.offered++;
        if (r.stage === "hired") {
          g.hired++;
          if (r.hired_at) g.days.push((Date.parse(r.hired_at) - Date.parse(r.created_at)) / 86400000);
        }
        m.set(k, g);
      }
      return [...m.values()]
        .map(({ days, ...g }) => {
          const cost = key === "source" ? (() => {
            const s = sources.find((x) => x.name === g.name);
            return s ? Math.round(s.monthly_cost * months + s.fee_per_hire * g.hired) : 0;
          })() : null;
          return {
            ...g,
            conversion: g.received ? Math.round((g.hired / g.received) * 1000) / 10 : 0,
            avg_days_to_hire: days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : null,
            ...(key === "source" ? { cost, cost_per_hire: g.hired ? Math.round(cost / g.hired) : null } : {}),
          };
        })
        .sort((a, b) => b.received - a.received);
    };
    return send(200, { from, to, total: rows.length, by_source: group("source"), by_branch: group("branch"), by_recruiter: group("recruiter") });
  });

  // Source costs, the default job and (for agencies) nothing else is set here.
  router.patch("/api/admin/rms/sources/:id/costs", { perm: "recruitment.manage" }, async ({ params, companyId, body, send, audit }) => {
    const s = await owned("intake_sources", params.id, companyId, "source");
    const b = await body();
    const fee = b.fee_per_hire === undefined ? s.fee_per_hire : number(Number(b.fee_per_hire), "Fee per hire", 0, 1e8);
    const monthly = b.monthly_cost === undefined ? s.monthly_cost : number(Number(b.monthly_cost), "Monthly cost", 0, 1e8);
    let opening = s.default_opening_id;
    if (b.default_opening_id !== undefined) {
      opening = optionalId(b.default_opening_id, "Default job");
      if (opening) await owned("job_openings", opening, companyId, "job opening");
    }
    await db.prepare("UPDATE intake_sources SET fee_per_hire=?,monthly_cost=?,default_opening_id=? WHERE id=?").run(fee, monthly, opening, s.id);
    await audit("rms_source_costs", { id: s.id, fee, monthly, opening });
    return send(200, { ok: true });
  });
}
