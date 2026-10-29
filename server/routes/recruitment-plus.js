import { randomBytes } from "node:crypto";
import {
  HttpError,
  clientIp,
  integer,
  isoDate,
  number,
  oneOf,
  optionalId,
  optionalString,
  string,
} from "../http.js";
import { tokenHash } from "../db.js";
import { requireOwned, staffWith } from "../scope.js";
import { can } from "../rbac.js";
import { checkFile } from "./documents.js";
import { applyResume, needsOcr, readResumeLater } from "../resume-parse.js";

const STEPS = [
  ["applied", "Applied"],
  ["screening", "Screening"],
  ["interview", "Interview"],
  ["offer", "Offer"],
  ["hired", "Joined"],
];
const EMPLOYMENT = [
  "full_time",
  "part_time",
  "contract",
  "intern",
  "consultant",
];

export const DEFAULT_TEMPLATES = {
  acknowledgement: {
    label: "Application received",
    subject: "We received your application for {{position}}",
    body: "Dear {{name}},\n\nThank you for applying for {{position}} at {{company}}. We have received your application and our team will review it. We will contact you if your profile matches.\n\n{{track}}\n\n{{company}}",
  },
  interview_call: {
    label: "Interview invitation",
    subject: "Interview invitation: {{position}}",
    body: "Dear {{name}},\n\nWe would like to invite you for an interview for {{position}} at {{company}}.\n\n{{details}}\n\nPlease reply to confirm. All the best.\n\n{{company}}",
  },
  rejection: {
    label: "Application not taken forward",
    subject: "Update on your application for {{position}}",
    body: "Dear {{name}},\n\nThank you for your interest in {{company}} and for the time you spent with us. After careful consideration we will not be taking your application for {{position}} forward at this time. We will keep your details for future openings.\n\nWe wish you the very best.\n\n{{company}}",
  },
  welcome: {
    label: "Welcome and login details",
    subject: "Welcome to {{company}}",
    body: "Dear {{name}},\n\nWelcome to {{company}}. We are delighted to have you join us on {{joining_date}}.\n\nYour login for the HR portal:\nAddress: {{login_url}}\nEmail: {{email}}\nTemporary password: {{password}}\nYou will be asked to choose a new password the first time you sign in.\n\nReporting manager: {{manager}} ({{manager_email}})\nOnboarding buddy: {{buddy}}\nWorkstation: {{workstation}}\n\nWe look forward to seeing you.\n\n{{company}}",
  },
  offer_sent: {
    label: "Offer sent",
    subject: "Your offer from {{company}}",
    body: "Dear {{name}},\n\nCongratulations. We are pleased to offer you the position of {{position}} at {{company}}. Please use your private link to read the offer, accept it and share your joining details:\n\n{{link}}\n\nThe link is meant only for you.\n\n{{company}}",
  },
};

export function parseSkills(v) {
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : [];
  if (list.length > 40) throw new HttpError(400, "Add up to 40 skills.");
  return [
    ...new Set(
      list
        .map((s) => String(s).trim().toLowerCase())
        .filter(Boolean)
        .map((s) => {
          if (s.length > 40)
            throw new HttpError(400, "A skill can be up to 40 characters.");
          return s;
        }),
    ),
  ];
}
const sameSkill = (a, b) =>
  a === b ||
  (a.length >= 3 && b.length >= 3 && (a.includes(b) || b.includes(a)));

/** 0–100 match of a candidate to an opening: skills 70%, experience 30% (whichever is defined). */
export function matchScore(opening, cand) {
  const need = JSON.parse(opening.skills || "[]");
  const have = JSON.parse(cand.skills || "[]");
  const minExp = Number(opening.min_experience_years) || 0;
  if (!need.length && !minExp) return null;
  const parts = [];
  if (need.length)
    parts.push([
      70,
      need.filter((n) => have.some((h) => sameSkill(n, h))).length /
        need.length,
    ]);
  if (minExp > 0)
    parts.push([
      30,
      Math.min((Number(cand.experience_years) || 0) / minExp, 1),
    ]);
  const weight = parts.reduce((a, [w]) => a + w, 0);
  return Math.round((parts.reduce((a, [w, r]) => a + w * r, 0) / weight) * 100);
}

export async function rescoreCandidate(db, candidateId) {
  const c = await db
    .prepare("SELECT * FROM candidates WHERE id=?")
    .get(candidateId);
  if (!c) return null;
  const o = c.opening_id
    ? await db
        .prepare("SELECT * FROM job_openings WHERE id=?")
        .get(c.opening_id)
    : null;
  const score = o ? matchScore(o, c) : null;
  await db
    .prepare("UPDATE candidates SET match_score=? WHERE id=?")
    .run(score, c.id);
  return score;
}

/** Extra opening columns from a request body; only fields present are returned. */
export function openingExtras(b) {
  const out = {};
  const num = (k, label, max) => {
    if (b[k] === undefined) return;
    out[k] = b[k] === null || b[k] === "" ? null : number(b[k], label, 0, max);
  };
  const txt = (k, label, max) => {
    if (b[k] !== undefined) out[k] = optionalString(b[k], label, max) || null;
  };
  txt("qualifications", "Qualifications", 1000);
  txt("location", "Location", 120);
  txt("justification", "Justification", 1000);
  num("min_experience_years", "Experience", 60);
  num("salary_min", "Salary minimum", 1e9);
  num("salary_max", "Salary maximum", 1e9);
  if (
    out.salary_min != null &&
    out.salary_max != null &&
    out.salary_min > out.salary_max
  )
    throw new HttpError(400, "Salary minimum cannot be above the maximum.");
  if (b.skills !== undefined)
    out.skills = JSON.stringify(parseSkills(b.skills));
  if (b.min_score !== undefined)
    out.min_score = Math.round(number(b.min_score, "Minimum match", 0, 100));
  if (b.published !== undefined) out.published = b.published ? 1 : 0;
  if (b.closing_date !== undefined)
    out.closing_date = isoDate(b.closing_date, "Closing date");
  return out;
}
export function candidateExtras(b) {
  const out = {};
  if (b.skills !== undefined)
    out.skills = JSON.stringify(parseSkills(b.skills));
  if (b.experience_years !== undefined)
    out.experience_years =
      b.experience_years === null || b.experience_years === ""
        ? null
        : number(b.experience_years, "Experience", 0, 60);
  if (b.qualification !== undefined)
    out.qualification =
      optionalString(b.qualification, "Qualification", 200) || null;
  return out;
}
export async function setColumns(db, table, id, cols) {
  const keys = Object.keys(cols);
  if (!keys.length) return;
  await db
    .prepare(
      `UPDATE ${table} SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
    )
    .run(...keys.map((k) => cols[k]), id);
}

const render = (text, vars) =>
  text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] ?? "").toString());

/** Sends a templated email to a candidate and records it on their timeline. */
export async function candidateMail(
  app,
  candidate,
  key,
  vars = {},
  attachments,
) {
  const { db } = app;
  const def = DEFAULT_TEMPLATES[key];
  const row = await db
    .prepare("SELECT * FROM recruitment_templates WHERE company_id=? AND key=?")
    .get(candidate.company_id, key);
  if (row && !row.enabled) return false;
  const company = await db
    .prepare("SELECT name FROM companies WHERE id=?")
    .get(candidate.company_id);
  const opening = candidate.opening_id
    ? await db
        .prepare("SELECT title FROM job_openings WHERE id=?")
        .get(candidate.opening_id)
    : null;
  const all = {
    name: candidate.name,
    company: company.name,
    position: opening?.title ?? "the role",
    track: "",
    details: "",
    link: "",
    ...vars,
  };
  const sent = candidate.email
    ? await app.notify.mail(
        candidate.company_id,
        candidate.email,
        render(row?.subject ?? def.subject, all),
        render(row?.body ?? def.body, all),
        attachments,
      )
    : false;
  await db
    .prepare(
      "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
    )
    .run(
      candidate.id,
      sent ? "email_sent" : "email_not_sent",
      sent ? def.label : `${def.label} (email is not set up or no address)`,
      null,
      new Date(app.clock()).toISOString(),
    );
  return sent;
}

export function registerRecruitmentPlus(router, app) {
  const { db, transaction, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const base = () =>
    (process.env.APP_URL || process.env.PUBLIC_URL || "").replace(/\/$/, "");
  const hrIds = async (companyId) =>
    (
      await staffWith(db, companyId, ["recruitment.manage"])
    ).map((r) => r.id);

  // ---- requisitions: a manager asks, HR approves -------------------------------------------
  router.post("/api/requisitions", async ({ user, body, send, audit }) => {
    const isHr = can(user, "recruitment.manage");
    const manages = await db
      .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
      .get(user.id);
    if (!isHr && !manages)
      throw new HttpError(
        403,
        "Only managers and HR can raise a job requisition.",
      );
    const b = await body();
    const ref = async (table, key, label) => {
      const v = optionalId(b[key], label);
      if (v !== null) await owned(table, v, user.company_id, label);
      return v;
    };
    const extras = openingExtras(b);
    const title = string(b.title, "Role", 100);
    const approved = isHr;
    const id = await transaction(async () => {
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO job_openings(company_id,title,department_id,branch_id,designation_id,positions,employment_type,description,hiring_manager_id,status,approval_status,requested_by,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              title,
              await ref("departments", "department_id", "department"),
              await ref("branches", "branch_id", "branch"),
              await ref("designations", "designation_id", "designation"),
              Math.round(number(b.positions ?? 1, "Positions", 1, 500)),
              b.employment_type
                ? oneOf(b.employment_type, "Employment type", EMPLOYMENT)
                : null,
              optionalString(b.description, "Description", 4000) || null,
              isHr
                ? (optionalId(b.hiring_manager_id, "Hiring manager") ?? user.id)
                : user.id,
              approved ? "open" : "on_hold",
              approved ? "approved" : "pending_approval",
              user.id,
              user.id,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await setColumns(db, "job_openings", id, extras);
      await audit("requisition_raised", { id, title, approved });
      return id;
    });
    if (!approved)
      await app.notify(await hrIds(user.company_id), {
        companyId: user.company_id,
        kind: "hiring",
        title: `Job requisition to approve: ${title}`,
        body: `Raised by ${user.name}.`,
        link: "hiring",
        email: true,
      });
    return send(201, {
      id,
      approval_status: approved ? "approved" : "pending_approval",
    });
  });
  router.get("/api/requisitions/mine", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `SELECT o.id,o.title,o.positions,o.status,o.approval_status,o.approval_note,o.created_at,
             (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id) candidates,
             (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id AND c.stage='hired') filled
           FROM job_openings o WHERE o.requested_by=? OR o.hiring_manager_id=? ORDER BY o.id DESC LIMIT 100`,
        )
        .all(user.id, user.id),
    ),
  );
  router.post(
    "/api/admin/openings/:id/approval",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const o = await owned("job_openings", params.id, companyId, "opening");
      if (o.approval_status !== "pending_approval")
        throw new HttpError(
          409,
          "This requisition is not waiting for approval.",
        );
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 500) || null;
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Tell the manager why.");
      await db
        .prepare(
          "UPDATE job_openings SET approval_status=?,approved_by=?,approval_note=?,status=? WHERE id=?",
        )
        .run(
          decision,
          user.id,
          note,
          decision === "approved" ? "open" : "closed",
          o.id,
        );
      await audit("requisition_decided", { id: o.id, decision });
      if (o.requested_by)
        await app.notify([o.requested_by], {
          companyId,
          kind: "hiring",
          title: `Your requisition for ${o.title} was ${decision === "approved" ? "approved" : "not approved"}`,
          body: note,
          link: "requisitions",
          email: true,
        });
      return send(200, { ok: true });
    },
  );
  router.patch(
    "/api/admin/openings/:id/details",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const o = await owned("job_openings", params.id, companyId, "opening");
      const extras = openingExtras(await body());
      if (extras.published === 1 && o.approval_status !== "approved")
        throw new HttpError(
          409,
          "Approve the requisition before publishing it.",
        );
      await setColumns(db, "job_openings", o.id, extras);
      // Skills or experience may have changed what "a match" means.
      if (
        extras.skills !== undefined ||
        extras.min_experience_years !== undefined
      )
        for (const c of await db
          .prepare("SELECT id FROM candidates WHERE opening_id=?")
          .all(o.id))
          await rescoreCandidate(db, c.id);
      await audit("opening_details", { id: o.id, fields: Object.keys(extras) });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/openings/:id/posting",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const o = await owned("job_openings", params.id, companyId, "opening");
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      const link = `${base()}/careers.html?c=${companyId}&job=${o.id}`;
      const skills = JSON.parse(o.skills || "[]");
      const money = (n) => `Rs. ${new Intl.NumberFormat("en-IN").format(n)}`;
      const lines = [
        `${company.name} is hiring: ${o.title}`,
        o.location ? `Location: ${o.location}` : null,
        o.employment_type
          ? `Type: ${o.employment_type.replace("_", " ")}`
          : null,
        `Positions: ${o.positions}`,
        o.qualifications ? `Qualifications: ${o.qualifications}` : null,
        o.min_experience_years
          ? `Experience: ${o.min_experience_years}+ years`
          : null,
        skills.length ? `Skills: ${skills.join(", ")}` : null,
        o.salary_min || o.salary_max
          ? `Pay: ${[o.salary_min && money(o.salary_min), o.salary_max && money(o.salary_max)].filter(Boolean).join(" – ")} a year`
          : null,
        o.description ? `\n${o.description}` : null,
        `\nApply here: ${link}`,
      ].filter(Boolean);
      return send(200, {
        text: lines.join("\n"),
        link,
        published: Boolean(o.published),
      });
    },
  );
  router.post(
    "/api/admin/candidates/:id/rescore",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const b = await body();
      await setColumns(db, "candidates", c.id, candidateExtras(b));
      return send(200, { match_score: await rescoreCandidate(db, c.id) });
    },
  );

  // ---- email templates ------------------------------------------------------------------------
  router.get(
    "/api/admin/recruitment/templates",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const rows = await db
        .prepare("SELECT * FROM recruitment_templates WHERE company_id=?")
        .all(companyId);
      return send(
        200,
        Object.entries(DEFAULT_TEMPLATES).map(([key, d]) => {
          const r = rows.find((x) => x.key === key);
          return {
            key,
            label: d.label,
            subject: r?.subject ?? d.subject,
            body: r?.body ?? d.body,
            enabled: r ? Boolean(r.enabled) : true,
            customised: Boolean(r),
          };
        }),
      );
    },
  );
  router.put(
    "/api/admin/recruitment/templates/:key",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const key = oneOf(params.key, "Template", Object.keys(DEFAULT_TEMPLATES));
      const b = await body();
      await db
        .prepare(
          "INSERT INTO recruitment_templates(company_id,key,subject,body,enabled) VALUES(?,?,?,?,?) ON CONFLICT (company_id,key) DO UPDATE SET subject=EXCLUDED.subject, body=EXCLUDED.body, enabled=EXCLUDED.enabled",
        )
        .run(
          companyId,
          key,
          string(b.subject, "Subject", 200),
          string(b.body, "Message", 4000),
          b.enabled === false ? 0 : 1,
        );
      await audit("recruitment_template_saved", { key });
      return send(200, { ok: true });
    },
  );

  // ---- resumes (HR) ---------------------------------------------------------------------------
  router.get(
    "/api/admin/candidates/:id/files",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      return send(
        200,
        await db
          .prepare(
            "SELECT id,kind,name,mime,size,created_at FROM candidate_files WHERE candidate_id=? ORDER BY id",
          )
          .all(c.id),
      );
    },
  );
  // Reads the latest resume again and fills in what the candidate record lacks.
  router.post(
    "/api/admin/candidates/:id/read-resume",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const f = await db
        .prepare(
          "SELECT data,mime FROM candidate_files WHERE candidate_id=? AND kind='resume' ORDER BY id DESC LIMIT 1",
        )
        .get(c.id);
      if (!f) throw new HttpError(404, "This candidate has no resume file.");
      const r = await applyResume(db, c.id, Buffer.from(f.data, "base64"), f.mime, {
        rescore: rescoreCandidate,
        actorId: user.id,
        at: nowIso(),
        ocr: true,
      });
      if (!r)
        throw new HttpError(
          422,
          "No text could be read from this resume. Blurred photos, handwriting, password-protected files and black-and-white fax scans cannot be read.",
        );
      await audit("resume_read", { id: c.id, filled: r.filled });
      return send(200, r);
    },
  );
  router.get(
    "/api/admin/candidate-files/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, res, headers }) => {
      const f = await db
        .prepare(
          "SELECT f.*,c.company_id FROM candidate_files f JOIN candidates c ON c.id=f.candidate_id WHERE f.id=?",
        )
        .get(integer(Number(params.id)));
      if (!f || f.company_id !== companyId)
        throw new HttpError(404, "File not found.");
      const ext = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
        "application/msword": "doc",
      }[f.mime];
      const fileName =
        ext && !f.name.toLowerCase().endsWith(`.${ext}`) ? `${f.name}.${ext}` : f.name;
      res.writeHead(200, {
        ...headers,
        "Content-Type": f.mime,
        "Content-Disposition": `inline; filename="${fileName}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(f.data, "base64"));
    },
  );

  // ---- public careers page and applicant tracker ----------------------------------------------
  const jobsOf = (companyId) =>
    db
      .prepare(
        `SELECT o.id,o.title,o.positions,o.employment_type,o.description,o.qualifications,o.min_experience_years,o.location,o.closing_date,o.skills,
           d.name department_name,b.name branch_name
         FROM job_openings o LEFT JOIN departments d ON d.id=o.department_id LEFT JOIN branches b ON b.id=o.branch_id
         WHERE o.company_id=? AND o.published=1 AND o.approval_status='approved' AND o.status='open'
           AND (o.closing_date IS NULL OR o.closing_date>=?) ORDER BY o.id DESC`,
      )
      .all(companyId, today());
  const activeCompany = async (id) => {
    const c = await db
      .prepare("SELECT id,name FROM companies WHERE id=? AND active=1")
      .get(integer(Number(id)));
    if (!c) throw new HttpError(404, "This careers page does not exist.");
    return c;
  };
  router.get(
    "/api/careers/:companyId",
    { public: true },
    async ({ req, params, send }) => {
      rateLimit(`careers:${clientIp(req)}`, 300);
      const c = await activeCompany(params.companyId);
      return send(200, {
        company: c.name,
        jobs: (await jobsOf(c.id)).map((j) => ({
          ...j,
          skills: JSON.parse(j.skills || "[]"),
        })),
      });
    },
  );
  router.post(
    "/api/careers/:companyId/apply",
    { public: true },
    async ({ req, params, body, send }) => {
      rateLimit(`apply:${clientIp(req)}`, 10);
      const co = await activeCompany(params.companyId);
      const b = await body(3_200_000);
      const job = (await jobsOf(co.id)).find(
        (j) => j.id === Number(b.opening_id),
      );
      if (!job) throw new HttpError(404, "This job is no longer open.");
      const name = string(b.name, "Name", 100);
      const mail = string(b.email, "Email", 254).toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail))
        throw new HttpError(400, "Enter a valid email.");
      const phone = string(b.phone, "Phone", 20);
      if (!/^[0-9+()\-\s]{7,20}$/.test(phone))
        throw new HttpError(400, "Phone must be a valid number.");
      if (
        await db
          .prepare(
            "SELECT id FROM candidates WHERE company_id=? AND lower(email)=? AND opening_id=? AND stage IN ('applied','screening','interview','offer')",
          )
          .get(co.id, mail, job.id)
      )
        throw new HttpError(
          409,
          "You have already applied for this job. Check your email for your tracking link.",
        );
      const extras = candidateExtras(b);
      const file = b.resume ? checkFile(b.resume) : null;
      const token = randomBytes(24).toString("base64url");
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO candidates(company_id,opening_id,name,email,phone,source,expected_ctc,notice_days,created_at,updated_at,track_token_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                co.id,
                job.id,
                name,
                mail,
                phone,
                "Careers page",
                b.expected_ctc
                  ? number(b.expected_ctc, "Expected pay", 0, 1e9)
                  : null,
                b.notice_days
                  ? number(b.notice_days, "Notice period", 0, 365)
                  : null,
                nowIso(),
                nowIso(),
                tokenHash(token),
              )
          ).lastInsertRowid,
        );
        await setColumns(db, "candidates", id, extras);
        if (file)
          await db
            .prepare(
              "INSERT INTO candidate_files(candidate_id,kind,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              id,
              "resume",
              string(b.resume.name ?? "resume", "File name", 100).replace(
                /[\\/\r\n"]/g,
                "_",
              ),
              file.mime,
              file.bytes.length,
              file.data,
              nowIso(),
            );
        await db
          .prepare(
            "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
          )
          .run(id, "added", "Applied on the careers page", null, nowIso());
        await rescoreCandidate(db, id);
        return id;
      });
      if (
        file &&
        !(await applyResume(db, id, file.bytes, file.mime, {
          rescore: rescoreCandidate,
          at: nowIso(),
        })) &&
        needsOcr(file.mime)
      )
        readResumeLater(db, id, file.bytes, file.mime, {
          rescore: rescoreCandidate,
          at: nowIso(),
        });
      const cand = await db
        .prepare("SELECT * FROM candidates WHERE id=?")
        .get(id);
      const track = `${base()}/careers.html?t=${token}`;
      await candidateMail(app, cand, "acknowledgement", {
        track: `Track your application any time: ${track}`,
      });
      await app.notify(await hrIds(co.id), {
        companyId: co.id,
        kind: "hiring",
        title: `New application: ${name} for ${job.title}`,
        body: cand.match_score != null ? `Match ${cand.match_score}%` : null,
        link: "hiring",
      });
      return send(201, { id, track_url: track, token });
    },
  );
  router.get(
    "/api/careers/track/:token",
    { public: true },
    async ({ req, params, send }) => {
      rateLimit(`track:${clientIp(req)}`, 300);
      if (typeof params.token !== "string" || params.token.length < 20)
        throw new HttpError(404, "This link is not valid.");
      const c = await db
        .prepare("SELECT * FROM candidates WHERE track_token_hash=?")
        .get(tokenHash(params.token));
      if (!c) throw new HttpError(404, "This link is not valid.");
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(c.company_id);
      const opening = c.opening_id
        ? await db
            .prepare("SELECT title FROM job_openings WHERE id=?")
            .get(c.opening_id)
        : null;
      const closed = ["rejected", "withdrawn"].includes(c.stage);
      const at = STEPS.findIndex(([k]) => k === c.stage);
      const interviews = await db
        .prepare(
          "SELECT round_name,scheduled_at,mode,location,status FROM interviews WHERE candidate_id=? AND status='scheduled' ORDER BY scheduled_at",
        )
        .all(c.id);
      const offer = await db
        .prepare(
          "SELECT status FROM offers WHERE candidate_id=? AND status IN ('sent','accepted') LIMIT 1",
        )
        .get(c.id);
      return send(200, {
        company: company.name,
        name: c.name,
        position: opening?.title ?? null,
        applied_on: c.created_at,
        closed,
        steps: STEPS.map(([key, label], i) => ({
          key,
          label,
          state: closed
            ? i === 0
              ? "done"
              : "todo"
            : i < at
              ? "done"
              : i === at
                ? "current"
                : "todo",
        })),
        interviews,
        offer: offer ? offer.status : null,
      });
    },
  );

  // ---- recruitment dashboard ------------------------------------------------------------------
  router.get(
    "/api/admin/recruitment/analytics",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const cands = await db
        .prepare(
          "SELECT id,opening_id,source,stage,created_at FROM candidates WHERE company_id=?",
        )
        .all(companyId);
      const events = await db
        .prepare(
          "SELECT e.candidate_id,e.kind,e.created_at FROM candidate_events e JOIN candidates c ON c.id=e.candidate_id WHERE c.company_id=? AND e.kind IN ('hired','interview_scheduled')",
        )
        .all(companyId);
      const offers = await db
        .prepare("SELECT candidate_id,status FROM offers WHERE company_id=?")
        .all(companyId);
      const openings = await db
        .prepare(
          "SELECT id,title,positions,status,created_at,approval_status FROM job_openings WHERE company_id=?",
        )
        .all(companyId);
      const days = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;
      const avg = (xs) =>
        xs.length
          ? Math.round((xs.reduce((a, x) => a + x, 0) / xs.length) * 10) / 10
          : null;
      const firstEvent = (kind) => {
        const m = new Map();
        for (const e of events)
          if (
            e.kind === kind &&
            !(m.has(e.candidate_id) && m.get(e.candidate_id) < e.created_at)
          )
            m.set(e.candidate_id, e.created_at);
        return m;
      };
      const hiredAt = firstEvent("hired");
      const interviewAt = firstEvent("interview_scheduled");
      const byId = new Map(cands.map((c) => [c.id, c]));
      const toHire = [...hiredAt].map(([id, at]) =>
        days(byId.get(id).created_at, at),
      );
      const toInterview = [...interviewAt].map(([id, at]) =>
        days(byId.get(id).created_at, at),
      );
      const fills = [];
      for (const o of openings) {
        const hires = cands.filter(
          (c) => c.opening_id === o.id && hiredAt.has(c.id),
        );
        if (hires.length && hires.length >= o.positions)
          fills.push(
            days(
              o.created_at,
              hires
                .map((h) => hiredAt.get(h.id))
                .sort()
                .at(-1),
            ),
          );
      }
      const offerByCand = new Map();
      for (const o of offers) {
        const s = offerByCand.get(o.candidate_id) ?? new Set();
        s.add(o.status);
        offerByCand.set(o.candidate_id, s);
      }
      const decided = offers.filter((o) =>
        ["accepted", "declined"].includes(o.status),
      );
      const accepted = offers.filter((o) => o.status === "accepted").length;
      const sources = {};
      for (const c of cands) {
        const k = c.source || "Unknown";
        sources[k] ??= { source: k, candidates: 0, hired: 0 };
        sources[k].candidates++;
        if (c.stage === "hired") sources[k].hired++;
      }
      return send(200, {
        funnel: [
          { stage: "Applied", count: cands.length },
          {
            stage: "Interviewed",
            count: cands.filter(
              (c) =>
                interviewAt.has(c.id) ||
                ["interview", "offer", "hired"].includes(c.stage),
            ).length,
          },
          {
            stage: "Offered",
            count: cands.filter(
              (c) =>
                offerByCand.has(c.id) || ["offer", "hired"].includes(c.stage),
            ).length,
          },
          {
            stage: "Hired",
            count: cands.filter((c) => c.stage === "hired").length,
          },
        ],
        avg_days_to_hire: avg(toHire),
        avg_days_to_first_interview: avg(toInterview),
        avg_days_to_fill: avg(fills),
        offers_decided: decided.length,
        offer_acceptance_rate: decided.length
          ? Math.round((accepted / decided.length) * 100)
          : null,
        sources: Object.values(sources).sort(
          (a, b) => b.candidates - a.candidates,
        ),
        open_positions: openings
          .filter((o) => o.status === "open")
          .map((o) => ({
            id: o.id,
            title: o.title,
            positions: o.positions,
            days_open: Math.floor(days(o.created_at, nowIso())),
            candidates: cands.filter(
              (c) =>
                c.opening_id === o.id &&
                ["applied", "screening", "interview", "offer"].includes(
                  c.stage,
                ),
            ).length,
            filled: cands.filter(
              (c) => c.opening_id === o.id && c.stage === "hired",
            ).length,
          })),
        pending_requisitions: openings.filter(
          (o) => o.approval_status === "pending_approval",
        ).length,
      });
    },
  );
}
