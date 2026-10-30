import {
  HttpError,
  integer,
  isoDate,
  number,
  oneOf,
  optionalId,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { offerLetter } from "../letters.js";
import {
  candidateExtras,
  candidateMail,
  openingExtras,
  rescoreCandidate,
  setColumns,
} from "./recruitment-plus.js";
import { createInvite } from "./preboarding.js";
import { creditGate } from "./credit.js";
import { notifyOwnerGroups } from "./onboarding-plus.js";
import { assignJoinerCourses } from "./learning.js";
import { preboardingForHire } from "./preboarding.js";
import { storePrivate } from "./payroll-setup.js";
import { encryptionKey } from "../crypto-store.js";

const STAGES = [
  "applied",
  "screening",
  "interview",
  "offer",
  "hired",
  "rejected",
  "withdrawn",
];
// Where a candidate may be moved by hand; offer and hired follow from offers and hiring.
const MANUAL = ["applied", "screening", "interview", "rejected", "withdrawn"];
const OPEN = ["applied", "screening", "interview", "offer"];
const OWNERS = ["hr", "manager", "employee", "it", "finance", "admin"];
const DEFAULT_TASKS = [
  ["Collect signed offer and ID documents", "documents", "hr", 0],
  ["Collect bank details and PAN, UAN and ESI numbers", "documents", "hr", 0],
  ["Set up salary in payroll", "payroll", "hr", 0],
  ["Approve the employee's phone for punching", "access", "hr", 1],
  ["Hand over laptop and access card", "assets", "it", 1],
  ["Create email and system accounts", "access", "it", 1],
  ["Complete personal profile and emergency contact", "profile", "employee", 3],
  ["Meet the team and share the first-week plan", "induction", "manager", 3],
  ["Company policy induction", "induction", "hr", 7],
  ["Issue ID card and allot a workstation", "assets", "admin", 1],
  ["Add to payroll and bank advice", "payroll", "finance", 2],
];

export function registerRecruitment(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const addDays = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  };
  const addMonths = (d, n) => {
    const x = new Date(`${d}T00:00:00Z`);
    const day = x.getUTCDate();
    x.setUTCDate(1);
    x.setUTCMonth(x.getUTCMonth() + n);
    const last = new Date(
      Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0),
    ).getUTCDate();
    x.setUTCDate(Math.min(day, last));
    return x.toISOString().slice(0, 10);
  };
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const event = (candidateId, kind, detail, actorId) =>
    db
      .prepare(
        "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
      )
      .run(candidateId, kind, detail ?? null, actorId, nowIso());
  const touch = (id) =>
    db
      .prepare("UPDATE candidates SET updated_at=? WHERE id=?")
      .run(nowIso(), id);
  const ref = async (table, id, companyId, label) => {
    const v = optionalId(id, label);
    if (v !== null) await requireOwned(db, table, v, companyId, label);
    return v;
  };

  // ---- openings -------------------------------------------------------------------------
  router.get(
    "/api/admin/openings",
    { perm: "recruitment.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `SELECT o.*,d.name department_name,b.name branch_name,m.name hiring_manager_name,
             (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id) candidates,
             (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id AND c.stage IN ('applied','screening','interview','offer')) in_process,
             (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id AND c.stage='hired') filled
           FROM job_openings o LEFT JOIN departments d ON d.id=o.department_id LEFT JOIN branches b ON b.id=o.branch_id
           LEFT JOIN users m ON m.id=o.hiring_manager_id
           WHERE o.company_id=? ${status ? "AND o.status=?" : ""} ORDER BY o.id DESC LIMIT 200`,
          )
          .all(...(status ? [companyId, status] : [companyId])),
      );
    },
  );
  const openingFields = async (b, companyId, existing = {}) => ({
    title:
      b.title === undefined ? existing.title : string(b.title, "Title", 100),
    department_id:
      b.department_id === undefined
        ? (existing.department_id ?? null)
        : await ref("departments", b.department_id, companyId, "department"),
    branch_id:
      b.branch_id === undefined
        ? (existing.branch_id ?? null)
        : await ref("branches", b.branch_id, companyId, "branch"),
    designation_id:
      b.designation_id === undefined
        ? (existing.designation_id ?? null)
        : await ref("designations", b.designation_id, companyId, "designation"),
    hiring_manager_id:
      b.hiring_manager_id === undefined
        ? (existing.hiring_manager_id ?? null)
        : await ref("users", b.hiring_manager_id, companyId, "hiring manager"),
    positions:
      b.positions === undefined
        ? (existing.positions ?? 1)
        : number(b.positions, "Positions", 1, 500),
    employment_type:
      b.employment_type === undefined
        ? (existing.employment_type ?? null)
        : b.employment_type
          ? oneOf(b.employment_type, "Employment type", [
              "full_time",
              "part_time",
              "contract",
              "intern",
              "consultant",
            ])
          : null,
    description:
      b.description === undefined
        ? (existing.description ?? null)
        : optionalString(b.description, "Description", 4000),
  });
  router.post(
    "/api/admin/openings",
    { perm: "recruitment.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const f = await openingFields(b, companyId);
      const extras = openingExtras(b);
      if (!f.title) throw new HttpError(400, "Title is required.");
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO job_openings(company_id,title,department_id,branch_id,designation_id,positions,employment_type,description,hiring_manager_id,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                f.title,
                f.department_id,
                f.branch_id,
                f.designation_id,
                f.positions,
                f.employment_type,
                f.description,
                f.hiring_manager_id,
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await setColumns(db, "job_openings", id, extras);
        await audit("opening_created", { id, title: f.title });
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/openings/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const row = await owned("job_openings", params.id, companyId, "opening");
      const b = await body();
      const f = await openingFields(b, companyId, row);
      const extras = openingExtras(b);
      if (extras.published === 1 && row.approval_status !== "approved")
        throw new HttpError(
          409,
          "Approve the requisition before publishing it.",
        );
      const status =
        b.status === undefined
          ? row.status
          : oneOf(b.status, "Status", ["open", "on_hold", "closed"]);
      await db
        .prepare(
          "UPDATE job_openings SET title=?,department_id=?,branch_id=?,designation_id=?,positions=?,employment_type=?,description=?,hiring_manager_id=?,status=?,closed_at=? WHERE id=?",
        )
        .run(
          f.title,
          f.department_id,
          f.branch_id,
          f.designation_id,
          f.positions,
          f.employment_type,
          f.description,
          f.hiring_manager_id,
          status,
          status === "closed" ? (row.closed_at ?? nowIso()) : null,
          row.id,
        );
      await setColumns(db, "job_openings", row.id, extras);
      if (
        extras.skills !== undefined ||
        extras.min_experience_years !== undefined
      )
        for (const c of await db
          .prepare("SELECT id FROM candidates WHERE opening_id=?")
          .all(row.id))
          await rescoreCandidate(db, c.id);
      await audit("opening_updated", { id: row.id, status });
      return send(200, { ok: true });
    },
  );

  // ---- candidates -------------------------------------------------------------------------
  const CAND = `SELECT c.*,o.title opening_title,o.min_score opening_min_score FROM candidates c LEFT JOIN job_openings o ON o.id=c.opening_id`;
  router.get(
    "/api/admin/candidates",
    { perm: "recruitment.manage" },
    async ({ companyId, query, send }) => {
      const where = ["c.company_id=?"],
        params = [companyId];
      const stage = query.get("stage");
      if (stage)
        (where.push("c.stage=?"), params.push(oneOf(stage, "Stage", STAGES)));
      const opening = query.get("opening_id");
      if (opening)
        (where.push("c.opening_id=?"), params.push(integer(Number(opening))));
      const q = query.get("q")?.trim().toLowerCase();
      if (q)
        (where.push("(lower(c.name) LIKE ? OR lower(c.email) LIKE ?)"),
          params.push(`%${q}%`, `%${q}%`));
      return send(
        200,
        await db
          .prepare(
            `${CAND} WHERE ${where.join(" AND ")} ORDER BY c.updated_at DESC LIMIT 300`,
          )
          .all(...params),
      );
    },
  );
  const candidateFields = async (b, companyId, existing = {}) => {
    const email =
      b.email === undefined
        ? (existing.email ?? null)
        : optionalString(b.email, "Email", 254);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "Enter a valid email.");
    const phone =
      b.phone === undefined
        ? (existing.phone ?? null)
        : optionalString(b.phone, "Phone", 20);
    if (phone && !/^[0-9+()\-\s]{7,20}$/.test(phone))
      throw new HttpError(400, "Phone must be a valid number.");
    const opt = (key, f) =>
      b[key] === undefined
        ? (existing[key] ?? null)
        : b[key] === null || b[key] === ""
          ? null
          : f(b[key]);
    return {
      name: b.name === undefined ? existing.name : string(b.name, "Name", 100),
      email,
      phone,
      source:
        b.source === undefined
          ? (existing.source ?? null)
          : optionalString(b.source, "Source", 60),
      opening_id:
        b.opening_id === undefined
          ? (existing.opening_id ?? null)
          : await ref("job_openings", b.opening_id, companyId, "opening"),
      expected_ctc: opt("expected_ctc", (v) =>
        number(v, "Expected pay", 0, 1000000000),
      ),
      notice_days: opt("notice_days", (v) =>
        number(v, "Notice period", 0, 365),
      ),
      resume_url:
        b.resume_url === undefined
          ? (existing.resume_url ?? null)
          : optionalString(b.resume_url, "Resume link", 500),
      notes:
        b.notes === undefined
          ? (existing.notes ?? null)
          : optionalString(b.notes, "Notes", 2000),
    };
  };
  router.post(
    "/api/admin/candidates",
    { perm: "recruitment.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const f = await candidateFields(b, companyId);
      const extras = candidateExtras(b);
      if (!f.name) throw new HttpError(400, "Name is required.");
      if (
        f.email &&
        (await db
          .prepare(
            "SELECT id FROM candidates WHERE company_id=? AND lower(email)=? AND opening_id IS NOT DISTINCT FROM ? AND stage IN ('applied','screening','interview','offer')",
          )
          .get(companyId, f.email.toLowerCase(), f.opening_id))
      )
        throw new HttpError(
          409,
          "This person is already in the pipeline for that opening.",
        );
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO candidates(company_id,opening_id,name,email,phone,source,expected_ctc,notice_days,resume_url,notes,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                f.opening_id,
                f.name,
                f.email,
                f.phone,
                f.source,
                f.expected_ctc,
                f.notice_days,
                f.resume_url,
                f.notes,
                user.id,
                nowIso(),
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await event(
          id,
          "added",
          f.source ? `Source: ${f.source}` : null,
          user.id,
        );
        await setColumns(db, "candidates", id, extras);
        await rescoreCandidate(db, id);
        await audit("candidate_added", { id, name: f.name });
        return id;
      });
      if (f.email)
        await candidateMail(
          app,
          await db.prepare("SELECT * FROM candidates WHERE id=?").get(id),
          "acknowledgement",
        );
      return send(201, { id });
    },
  );
  router.get(
    "/api/admin/candidates/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      return send(200, {
        ...(await db.prepare(`${CAND} WHERE c.id=?`).get(c.id)),
        events: await db
          .prepare(
            "SELECT e.*,u.name actor_name FROM candidate_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.candidate_id=? ORDER BY e.id DESC",
          )
          .all(c.id),
        interviews: await db
          .prepare(
            "SELECT i.*,u.name interviewer_name FROM interviews i JOIN users u ON u.id=i.interviewer_id WHERE i.candidate_id=? ORDER BY i.scheduled_at",
          )
          .all(c.id),
        offers: await db
          .prepare("SELECT * FROM offers WHERE candidate_id=? ORDER BY id DESC")
          .all(c.id),
      });
    },
  );
  router.patch(
    "/api/admin/candidates/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const b = await body();
      const f = await candidateFields(b, companyId, c);
      const extras = candidateExtras(b);
      await db
        .prepare(
          "UPDATE candidates SET name=?,email=?,phone=?,source=?,opening_id=?,expected_ctc=?,notice_days=?,resume_url=?,notes=?,updated_at=? WHERE id=?",
        )
        .run(
          f.name,
          f.email,
          f.phone,
          f.source,
          f.opening_id,
          f.expected_ctc,
          f.notice_days,
          f.resume_url,
          f.notes,
          nowIso(),
          c.id,
        );
      await setColumns(db, "candidates", c.id, extras);
      await rescoreCandidate(db, c.id);
      await audit("candidate_updated", { id: c.id });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/candidates/:id/stage",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const b = await body();
      await moveStage(c, b.stage, b.reason, user, companyId);
      return send(200, { ok: true });
    },
  );

  // Moves a candidate by hand (the stage button and bulk actions): offer and hired follow
  // from offers and hiring; rejecting or withdrawing needs a reason, withdraws open offers
  // and tells a rejected candidate.
  async function moveStage(c, wanted, why, user, companyId, { mail = true } = {}) {
    const stage = oneOf(wanted, "Stage", MANUAL);
    if (["hired"].includes(c.stage))
      throw new HttpError(409, "This candidate has already been hired.");
    const reason = optionalString(why, "Reason", 300);
    if ((stage === "rejected" || stage === "withdrawn") && !reason)
      throw new HttpError(400, "Say why.");
    await transaction(async () => {
      if (stage === "rejected" || stage === "withdrawn")
        await db
          .prepare(
            "UPDATE offers SET status='withdrawn',decided_at=? WHERE candidate_id=? AND status IN ('draft','sent')",
          )
          .run(nowIso(), c.id);
      await db
        .prepare(
          "UPDATE candidates SET stage=?,closed_reason=?,updated_at=? WHERE id=?",
        )
        .run(stage, reason, nowIso(), c.id);
      await event(c.id, `stage_${stage}`, reason, user?.id ?? null);
      await app.audit(user, "candidate_stage", { id: c.id, stage }, companyId);
    });
    if (mail && stage === "rejected" && c.stage !== "rejected")
      await candidateMail(app, c, "rejection");
    return stage;
  }
  app.moveCandidateStage = moveStage;

  // ---- interviews -------------------------------------------------------------------------
  router.patch(
    "/api/admin/interviews/:id",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const i = await owned("interviews", params.id, companyId, "interview");
      if (i.status !== "scheduled")
        throw new HttpError(409, `This interview is already ${i.status}.`);
      const b = await body();
      const status =
        b.status === undefined
          ? "scheduled"
          : oneOf(b.status, "Status", ["scheduled", "cancelled", "no_show"]);
      const at =
        b.scheduled_at === undefined
          ? i.scheduled_at
          : new Date(string(b.scheduled_at, "Date and time", 30)).toISOString();
      await db
        .prepare("UPDATE interviews SET status=?,scheduled_at=? WHERE id=?")
        .run(status, at, i.id);
      await event(
        i.candidate_id,
        status === "scheduled"
          ? "interview_rescheduled"
          : `interview_${status}`,
        i.round_name,
        user.id,
      );
      await audit("interview_updated", { id: i.id, status });
      return send(200, { ok: true });
    },
  );
  // Interviewers see their own interviews and give feedback on them.
  const MINE = `SELECT i.*,c.name candidate_name,c.resume_url,o.title opening_title FROM interviews i
    JOIN candidates c ON c.id=i.candidate_id LEFT JOIN job_openings o ON o.id=c.opening_id`;
  router.get("/api/interviews/mine", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${MINE} WHERE i.interviewer_id=? ORDER BY (i.status='scheduled') DESC,i.scheduled_at DESC LIMIT 100`,
        )
        .all(user.id),
    ),
  );
  router.post(
    "/api/interviews/:id/feedback",
    async ({ user, params, body, send, audit }) => {
      const i = await owned(
        "interviews",
        params.id,
        user.company_id,
        "interview",
      );
      if (i.interviewer_id !== user.id)
        throw new HttpError(403, "Only the interviewer can give feedback.");
      if (i.status === "cancelled")
        throw new HttpError(409, "This interview was cancelled.");
      const b = await body();
      const rating = number(b.rating, "Rating", 1, 5);
      if (!Number.isInteger(rating))
        throw new HttpError(400, "Rating must be 1 to 5.");
      const rec = oneOf(b.recommendation, "Recommendation", [
        "strong_yes",
        "yes",
        "no",
        "strong_no",
      ]);
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE interviews SET status='completed',rating=?,recommendation=?,feedback=? WHERE id=?",
          )
          .run(rating, rec, string(b.feedback, "Feedback", 2000), i.id);
        if (Array.isArray(b.scores))
          for (const x of b.scores.slice(0, 20)) {
            const r = number(x?.rating, "Question score", 1, 5);
            if (!Number.isInteger(r))
              throw new HttpError(400, "Question scores must be 1 to 5.");
            await db
              .prepare(
                "UPDATE interview_questions SET rating=? WHERE id=? AND interview_id=?",
              )
              .run(r, integer(Number(x.id)), i.id);
          }
        await event(
          i.candidate_id,
          "feedback",
          `${i.round_name}: ${rec.replace("_", " ")} (${rating}/5)`,
          user.id,
        );
        await touch(i.candidate_id);
        await audit("interview_feedback", { id: i.id });
      });
      return send(200, { ok: true });
    },
  );

  // ---- offers ---------------------------------------------------------------------------------
  router.post(
    "/api/admin/candidates/:id/offers",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      if (!OPEN.includes(c.stage))
        throw new HttpError(
          409,
          "This candidate is no longer in the pipeline.",
        );
      if (
        await db
          .prepare(
            "SELECT id FROM offers WHERE candidate_id=? AND status IN ('draft','sent','accepted')",
          )
          .get(c.id)
      )
        throw new HttpError(
          409,
          "There is already a live offer. Withdraw it first.",
        );
      const b = await body();
      const joining = isoDate(b.joining_date, "Joining date");
      if (!joining || joining < today())
        throw new HttpError(400, "Joining date must be today or later.");
      const validUntil = isoDate(b.valid_until, "Valid until");
      let breakup = null;
      if (b.breakup !== undefined && b.breakup !== null) {
        const parts = Array.isArray(b.breakup) ? b.breakup : [];
        if (parts.length < 1 || parts.length > 12)
          throw new HttpError(400, "Give 1 to 12 salary components.");
        const clean = parts.map((x) => ({
          name: string(x?.name, "Component name", 60),
          monthly: Math.round(
            number(x?.monthly, "Component amount", 0, 100000000),
          ),
        }));
        if (
          Math.abs(
            clean.reduce((a, x) => a + x.monthly, 0) -
              Math.round(
                number(b.monthly_gross, "Monthly gross", 1, 100000000),
              ),
          ) > 1
        )
          throw new HttpError(
            400,
            "The components must add up to the monthly gross.",
          );
        breakup = JSON.stringify(clean);
      }
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO offers(company_id,candidate_id,designation,monthly_gross,joining_date,valid_until,note,probation_months,ctc_breakup,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                c.id,
                string(b.designation, "Designation", 100),
                Math.round(
                  number(b.monthly_gross, "Monthly gross", 1, 100000000),
                ),
                joining,
                validUntil,
                optionalString(b.note, "Note", 1000),
                b.probation_months === undefined
                  ? 6
                  : Math.round(
                      number(b.probation_months, "Probation months", 0, 24),
                    ),
                breakup,
                user.id,
                nowIso(),
              )
          ).lastInsertRowid,
        );
        await db
          .prepare(
            "UPDATE candidates SET stage='offer',updated_at=? WHERE id=?",
          )
          .run(nowIso(), c.id);
        await event(c.id, "offer_drafted", null, user.id);
        await audit("offer_created", { id, candidateId: c.id });
        return id;
      });
      return send(201, { id });
    },
  );
  router.post(
    "/api/admin/offers/:id/status",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const o = await owned("offers", params.id, companyId, "offer");
      const status = oneOf((await body()).status, "Status", [
        "sent",
        "accepted",
        "declined",
        "withdrawn",
      ]);
      const allowed = {
        draft: ["sent", "withdrawn"],
        sent: ["accepted", "declined", "withdrawn"],
        accepted: ["withdrawn"],
      };
      if (!allowed[o.status]?.includes(status))
        throw new HttpError(
          409,
          `An offer that is ${o.status} cannot become ${status}.`,
        );
      const cand = await db
        .prepare("SELECT * FROM candidates WHERE id=?")
        .get(o.candidate_id);
      if (cand.stage === "hired")
        throw new HttpError(409, "This candidate has already been hired.");
      await transaction(async () => {
        await db
          .prepare("UPDATE offers SET status=?,decided_at=? WHERE id=?")
          .run(
            status,
            ["accepted", "declined", "withdrawn"].includes(status)
              ? nowIso()
              : null,
            o.id,
          );
        // A declined or withdrawn offer sends the candidate back to interviewing, or closes them if they declined.
        if (status === "declined")
          await db
            .prepare(
              "UPDATE candidates SET stage='rejected',closed_reason='Declined the offer',updated_at=? WHERE id=?",
            )
            .run(nowIso(), cand.id);
        else if (status === "withdrawn")
          await db
            .prepare(
              "UPDATE candidates SET stage='interview',updated_at=? WHERE id=? AND stage='offer'",
            )
            .run(nowIso(), cand.id);
        await event(cand.id, `offer_${status}`, null, user.id);
        await audit("offer_status", { id: o.id, status });
      });
      let link = null;
      if (status === "sent") {
        // Sending the offer also issues the candidate's private joining link and emails it.
        link = (await createInvite(app, user.id, companyId, cand)).link;
        await candidateMail(app, cand, "offer_sent", { link });
      }
      return send(200, { ok: true, link });
    },
  );
  router.get(
    "/api/admin/offers/:id/letter",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const o = await owned("offers", params.id, companyId, "offer");
      const candidate = await db
        .prepare("SELECT * FROM candidates WHERE id=?")
        .get(o.candidate_id);
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        company: company.name,
        ...offerLetter({
          company: company.name,
          candidate,
          offer: o,
          today: today(),
        }),
      });
    },
  );

  // ---- hire: turns an accepted offer into an employee ---------------------------------------
  router.post(
    "/api/admin/candidates/:id/hire",
    { perm: "employees.write" },
    async ({ user, params, companyId, body, send, audit }) => {
      if (!can(user, "recruitment.manage"))
        throw new HttpError(403, "You do not have permission to do that.");
      const c = await owned("candidates", params.id, companyId, "candidate");
      if (c.stage === "hired")
        throw new HttpError(409, "This candidate has already been hired.");
      const offer = await db
        .prepare(
          "SELECT * FROM offers WHERE candidate_id=? AND status='accepted'",
        )
        .get(c.id);
      if (!offer)
        throw new HttpError(409, "Record an accepted offer before hiring.");
      const b = await body();
      const blocked = await creditGate(
        db,
        companyId,
        c.id,
        optionalString(b.credit_override_note, "Note", 300),
      );
      if (blocked) throw new HttpError(409, blocked);
      const mail = b.email ?? c.email;
      if (!mail)
        throw new HttpError(400, "An email is needed to create the login.");
      const opening = c.opening_id
        ? await db
            .prepare("SELECT * FROM job_openings WHERE id=?")
            .get(c.opening_id)
        : null;
      const pre = await preboardingForHire(app, c.id);
      const f = pre?.form ?? {};
      const buddyId = optionalId(b.buddy_id, "Buddy");
      if (buddyId) await owned("users", buddyId, companyId, "buddy");
      const userId = await transaction(async () => {
        const userId = await app.createEmployee(
          user,
          companyId,
          {
            name: c.name,
            email: mail,
            password: b.password,
            phone: f.phone ?? c.phone ?? undefined,
            address: f.address ?? undefined,
            emergency_name: f.emergency_name ?? undefined,
            emergency_phone: f.emergency_phone ?? undefined,
            emergency_relation: f.emergency_relation ?? undefined,
            date_of_joining: offer.joining_date,
            employment_type: opening?.employment_type ?? b.employment_type,
            department_id:
              b.department_id ?? opening?.department_id ?? undefined,
            branch_id: b.branch_id ?? opening?.branch_id ?? undefined,
            designation_id:
              b.designation_id ?? opening?.designation_id ?? undefined,
            workplace_id: b.workplace_id,
            manager_id: b.manager_id ?? opening?.hiring_manager_id ?? undefined,
            gender: b.gender ?? f.gender ?? undefined,
            date_of_birth: b.date_of_birth ?? f.date_of_birth ?? undefined,
          },
          audit,
        );
        await db
          .prepare(
            "UPDATE users SET probation_end_date=?,buddy_id=? WHERE id=?",
          )
          .run(
            offer.probation_months > 0
              ? addMonths(offer.joining_date, offer.probation_months)
              : null,
            buddyId ?? null,
            userId,
          );
        if (pre) {
          // What the candidate gave before joining moves onto the new employee's record.
          for (const d of pre.documents)
            await db
              .prepare(
                "INSERT INTO documents(company_id,user_id,kind,name,mime,size,data,uploaded_by,verified_by,verified_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                userId,
                d.kind,
                d.name,
                d.mime,
                d.size,
                d.data,
                user.id,
                d.verified ? user.id : null,
                d.verified ? nowIso() : null,
                nowIso(),
              );
          if (Object.keys(pre.sensitive).length && encryptionKey())
            await storePrivate(app, userId, companyId, pre.sensitive, user.id);
        }
        await db
          .prepare(
            "UPDATE candidates SET stage='hired',user_id=?,updated_at=? WHERE id=?",
          )
          .run(userId, nowIso(), c.id);
        await event(c.id, "hired", `Joining ${offer.joining_date}`, user.id);
        // Onboarding checklist from the company template, or the standard one.
        const template = await db
          .prepare(
            "SELECT * FROM onboarding_template WHERE company_id=? ORDER BY id",
          )
          .all(companyId);
        for (const t of template.length
          ? template.map((x) => [x.title, x.category, x.owner, x.due_days])
          : DEFAULT_TASKS)
          await db
            .prepare(
              "INSERT INTO onboarding_tasks(company_id,user_id,title,category,owner,due_date,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              userId,
              t[0],
              t[1],
              t[2],
              addDays(offer.joining_date, t[3]),
              nowIso(),
            );
        await assignJoinerCourses(app, userId, companyId, offer.joining_date);
        await db
          .prepare("UPDATE joining_acks SET user_id=? WHERE candidate_id=?")
          .run(userId, c.id);
        await audit("candidate_hired", { id: c.id, userId });
        return userId;
      });
      const notice = (ids, title, body) =>
        app.notify(ids, {
          companyId,
          kind: "onboarding",
          title,
          body,
          link: "team",
        });
      if (buddyId)
        await notice(
          [buddyId],
          `You are ${c.name}'s onboarding buddy`,
          `${c.name} joins on ${offer.joining_date}. Please help them settle in.`,
        );
      await notifyOwnerGroups(
        app,
        companyId,
        userId,
        c.name,
        offer.joining_date,
      );
      if (b.send_welcome !== false) {
        const mgrRow =
          (b.manager_id ?? opening?.hiring_manager_id)
            ? await db
                .prepare("SELECT name,email FROM users WHERE id=?")
                .get(b.manager_id ?? opening?.hiring_manager_id)
            : null;
        const buddyRow = buddyId
          ? await db.prepare("SELECT name FROM users WHERE id=?").get(buddyId)
          : null;
        const base = (
          process.env.APP_URL ||
          process.env.PUBLIC_URL ||
          ""
        ).replace(/\/$/, "");
        await candidateMail(app, { ...c, email: c.email ?? mail }, "welcome", {
          email: mail,
          password: b.password,
          login_url: base || "your HR portal address",
          joining_date: offer.joining_date,
          manager: mgrRow?.name ?? "to be confirmed",
          manager_email: mgrRow?.email ?? "",
          buddy: buddyRow?.name ?? "to be confirmed",
          workstation:
            optionalString(b.workstation, "Workstation details", 300) ||
            "to be shared by IT",
        });
      }
      const mgr = b.manager_id ?? opening?.hiring_manager_id;
      if (mgr)
        await notice(
          [mgr],
          `${c.name} will join your team on ${offer.joining_date}`,
          null,
        );
      return send(201, { user_id: userId });
    },
  );
  router.get(
    "/api/admin/recruitment/summary",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const stages = await db
        .prepare(
          "SELECT stage,COUNT(*) n FROM candidates WHERE company_id=? GROUP BY stage",
        )
        .all(companyId);
      const open = await db
        .prepare(
          "SELECT COUNT(*) n,COALESCE(SUM(positions),0) p FROM job_openings WHERE company_id=? AND status='open'",
        )
        .get(companyId);
      return send(200, {
        stages: Object.fromEntries(stages.map((s) => [s.stage, s.n])),
        open_openings: open.n,
        open_positions: open.p,
      });
    },
  );

  // ---- onboarding ---------------------------------------------------------------------------------
  router.get(
    "/api/admin/onboarding/template",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT * FROM onboarding_template WHERE company_id=? ORDER BY id",
          )
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/onboarding/template",
    { perm: "recruitment.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO onboarding_template(company_id,title,category,owner,due_days,created_at) VALUES(?,?,?,?,?,?)",
            )
            .run(
              companyId,
              string(b.title, "Task", 120),
              optionalString(b.category, "Category", 40) ?? "general",
              oneOf(b.owner ?? "hr", "Owner", OWNERS),
              number(b.due_days ?? 0, "Due after (days)", 0, 365),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("onboarding_template_added", { id });
      return send(201, { id });
    },
  );
  router.post(
    "/api/admin/onboarding/template/seed-defaults",
    { perm: "recruitment.manage" },
    async ({ companyId, send, audit }) => {
      if (
        await db
          .prepare(
            "SELECT id FROM onboarding_template WHERE company_id=? LIMIT 1",
          )
          .get(companyId)
      )
        throw new HttpError(409, "A checklist already exists.");
      for (const t of DEFAULT_TASKS)
        await db
          .prepare(
            "INSERT INTO onboarding_template(company_id,title,category,owner,due_days,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(companyId, t[0], t[1], t[2], t[3], nowIso());
      await audit("onboarding_template_seeded", {});
      return send(201, { created: DEFAULT_TASKS.length });
    },
  );
  router.delete(
    "/api/admin/onboarding/template/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send, audit }) => {
      const t = await owned(
        "onboarding_template",
        params.id,
        companyId,
        "task",
      );
      await db.prepare("DELETE FROM onboarding_template WHERE id=?").run(t.id);
      await audit("onboarding_template_removed", { id: t.id });
      return send(200, { ok: true });
    },
  );
  // People still onboarding, with progress.
  router.get(
    "/api/admin/onboarding",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT u.id,u.name,u.employee_code,u.date_of_joining,COUNT(t.id) total,SUM(t.done) done,
             SUM(CASE WHEN t.done=0 AND t.due_date<? THEN 1 ELSE 0 END) overdue
           FROM users u JOIN onboarding_tasks t ON t.user_id=u.id WHERE u.company_id=? AND u.active=1
           GROUP BY u.id,u.name,u.employee_code,u.date_of_joining HAVING SUM(t.done)<COUNT(t.id) ORDER BY u.date_of_joining DESC`,
          )
          .all(today(), companyId),
      ),
  );
  const TASKS =
    "SELECT * FROM onboarding_tasks WHERE user_id=? ORDER BY done,due_date,id";
  router.get(
    "/api/admin/employees/:id/onboarding",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const p = await owned("users", params.id, companyId, "employee");
      return send(200, await db.prepare(TASKS).all(p.id));
    },
  );
  router.post(
    "/api/admin/employees/:id/onboarding",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const p = await owned("users", params.id, companyId, "employee");
      const b = await body();
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO onboarding_tasks(company_id,user_id,title,category,owner,due_date,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              p.id,
              string(b.title, "Task", 120),
              optionalString(b.category, "Category", 40) ?? "general",
              oneOf(b.owner ?? "hr", "Owner", OWNERS),
              isoDate(b.due_date, "Due date"),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("onboarding_task_added", { id, employeeId: p.id });
      return send(201, { id });
    },
  );
  router.get("/api/onboarding/mine", async ({ user, send }) =>
    send(200, await db.prepare(TASKS).all(user.id)),
  );
  // Tasks for new joiners that this person is responsible for (managers see their reports').
  router.get("/api/onboarding/assigned", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `SELECT t.*,u.name employee_name FROM onboarding_tasks t JOIN users u ON u.id=t.user_id
           WHERE t.company_id=? AND t.done=0 AND ((t.owner='manager' AND u.manager_id=?)
             OR (t.owner IN ('it','finance','admin') AND EXISTS (SELECT 1 FROM onboarding_owner_members m WHERE m.company_id=t.company_id AND m.owner=t.owner AND m.user_id=?))
             ${can(user, "recruitment.manage") ? "OR t.owner IN ('hr','it','finance','admin')" : ""})
           ORDER BY t.due_date,t.id LIMIT 200`,
        )
        .all(user.company_id, user.id, user.id),
    ),
  );
  router.post(
    "/api/onboarding-tasks/:id/done",
    async ({ user, params, body, send, audit }) => {
      const t = await owned(
        "onboarding_tasks",
        params.id,
        user.company_id,
        "task",
      );
      const subject = await db
        .prepare("SELECT manager_id FROM users WHERE id=?")
        .get(t.user_id);
      const member =
        ["it", "finance", "admin"].includes(t.owner) &&
        (await db
          .prepare(
            "SELECT 1 x FROM onboarding_owner_members WHERE company_id=? AND owner=? AND user_id=?",
          )
          .get(user.company_id, t.owner, user.id));
      const allowed =
        can(user, "recruitment.manage") ||
        Boolean(member) ||
        (t.owner === "employee" && t.user_id === user.id) ||
        (t.owner === "manager" && subject.manager_id === user.id);
      if (!allowed) throw new HttpError(403, "You cannot complete this task.");
      const done = (await body()).done === false ? 0 : 1;
      await db
        .prepare(
          "UPDATE onboarding_tasks SET done=?,done_at=?,done_by=? WHERE id=?",
        )
        .run(done, done ? nowIso() : null, done ? user.id : null, t.id);
      await audit("onboarding_task", { id: t.id, done });
      return send(200, { ok: true });
    },
  );

  // ---- assets -------------------------------------------------------------------------------------
  router.get(
    "/api/admin/assets",
    { perm: "assets.manage" },
    async ({ companyId, query, send }) => {
      const status = query.get("status");
      return send(
        200,
        await db
          .prepare(
            `SELECT a.*,u.name assigned_name,u.employee_code FROM assets a LEFT JOIN users u ON u.id=a.assigned_to WHERE a.company_id=? ${status ? "AND a.status=?" : ""} ORDER BY a.tag LIMIT 500`,
          )
          .all(...(status ? [companyId, status] : [companyId])),
      );
    },
  );
  router.post(
    "/api/admin/assets",
    { perm: "assets.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO assets(company_id,name,tag,category,created_at) VALUES(?,?,?,?,?)",
            )
            .run(
              companyId,
              string(b.name, "Name", 100),
              string(b.tag, "Asset tag", 40),
              optionalString(b.category, "Category", 40),
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("asset_added", { id });
      return send(201, { id });
    },
  );
  router.post(
    "/api/admin/assets/:id/assign",
    { perm: "assets.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const a = await owned("assets", params.id, companyId, "asset");
      if (a.status !== "available")
        throw new HttpError(409, `This asset is ${a.status}.`);
      const p = await owned(
        "users",
        (await body()).user_id,
        companyId,
        "employee",
      );
      await db
        .prepare(
          "UPDATE assets SET status='assigned',assigned_to=?,assigned_at=? WHERE id=?",
        )
        .run(p.id, nowIso(), a.id);
      await audit("asset_assigned", { id: a.id, employeeId: p.id });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/assets/:id/return",
    { perm: "assets.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const a = await owned("assets", params.id, companyId, "asset");
      if (a.status !== "assigned")
        throw new HttpError(409, "This asset is not assigned.");
      const retire = (await body()).retire === true;
      await db
        .prepare(
          "UPDATE assets SET status=?,assigned_to=NULL,assigned_at=NULL WHERE id=?",
        )
        .run(retire ? "retired" : "available", a.id);
      await audit("asset_returned", { id: a.id, retire });
      return send(200, { ok: true });
    },
  );
  router.get("/api/assets/mine", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT id,name,tag,category,assigned_at FROM assets WHERE assigned_to=? ORDER BY assigned_at",
        )
        .all(user.id),
    ),
  );
}
