import { createHash, randomBytes } from "node:crypto";
import { HttpError, clientIp, integer, number, oneOf, optionalString, string } from "../http.js";
import { candidateMail, rescoreCandidate } from "./recruitment-plus.js";
import { staffWith } from "../scope.js";
import { nameFromFileName, needsOcr, readResume, readResumeLater } from "../resume-parse.js";

// Recruitment management: every resume for a job, whichever platform it came from.
// Each source (LinkedIn, Naukri, WhatsApp, an agency…) has a secret key; a connector
// built later posts candidates to /api/intake/<key>, and HR can also import resumes by
// hand. Someone already on the job (same email, or the same last ten phone digits)
// keeps one record and gains another source entry instead of a duplicate.
export const SOURCE_KINDS = {
  linkedin: "LinkedIn",
  naukri: "Naukri",
  indeed: "Indeed",
  whatsapp: "WhatsApp",
  email: "Email",
  careers: "Careers page",
  referral: "Referral",
  agency: "Agency",
  walk_in: "Walk-in",
  job_fair: "Job fair",
  other: "Other",
};
const RESUME_TYPES = {
  "application/pdf": "%PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "PK",
  "application/msword": "\xd0\xcf\x11\xe0",
  "image/jpeg": "\xff\xd8\xff",
  "image/png": "\x89PNG",
};
const hash = (k) => createHash("sha256").update(k).digest("hex");
const digits = (p) => String(p ?? "").replace(/\D/g, "").slice(-10);

function resumeFile(r) {
  if (!r) return null;
  const mime = oneOf(r.mime, "Resume type", Object.keys(RESUME_TYPES));
  const data = string(r.data, "Resume", 4_000_000);
  if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, "The resume file is not valid.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > 3 * 1024 * 1024) throw new HttpError(413, "Resumes can be up to 3 MB.");
  const magic = RESUME_TYPES[mime];
  if (bytes.subarray(0, magic.length).toString("latin1") !== magic)
    throw new HttpError(400, "The resume does not look like the file type it says.");
  return {
    mime,
    data,
    size: bytes.length,
    name: string(r.name ?? "resume", "File name", 120).replace(/[\\/\r\n"]/g, "_"),
  };
}

export function registerRms(router, app) {
  const { db, transaction, rateLimit } = app;
  const nowIso = () => new Date(app.clock()).toISOString();

  // One candidate in, from any source. Returns { id, duplicate }.
  async function intake(companyId, opening, source, b, actorId) {
    const file = resumeFile(b.resume);
    let email = optionalString(b.email, "Email", 254)?.toLowerCase() ?? null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new HttpError(400, "Enter a valid email.");
    let phone = optionalString(b.phone, "Phone", 20);
    if (phone && digits(phone).length < 7) throw new HttpError(400, "Phone must be a valid number.");
    // Read the resume first, so a CV sent with nothing else still has a name and contact
    // details, and is matched against people already on this job.
    const read = file
      ? await readResume(Buffer.from(file.data, "base64"), file.mime, JSON.parse(opening.skills || "[]"))
      : null;
    email ??= read?.email ?? null;
    phone ??= read?.phone ?? null;
    const name = b.name
      ? string(b.name, "Name", 100)
      : read?.name || (file ? nameFromFileName(file.name) : string(b.name, "Name", 100));
    const ref = optionalString(b.external_ref, "Reference", 120);
    const same = await db
      .prepare(
        `SELECT id,email,phone FROM candidates WHERE company_id=? AND opening_id=? AND stage NOT IN ('rejected','withdrawn')`,
      )
      .all(companyId, opening.id);
    const dup = same.find(
      (c) =>
        (email && c.email && c.email.toLowerCase() === email) ||
        (phone && c.phone && digits(c.phone) === digits(phone) && digits(phone).length >= 10),
    );
    const at = nowIso();
    const id = await transaction(async () => {
      let id = dup?.id;
      if (!id) {
        id = Number(
          (
            await db
              .prepare(
                "INSERT INTO candidates(company_id,opening_id,name,email,phone,source,expected_ctc,notice_days,notes,created_by,created_at,updated_at,location) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                opening.id,
                name,
                email,
                phone,
                source.name,
                b.expected_ctc ? number(Number(b.expected_ctc), "Expected pay", 0, 1e9) : null,
                b.notice_days ? number(Number(b.notice_days), "Notice period", 0, 365) : null,
                optionalString(b.notes, "Notes", 2000),
                actorId,
                at,
                at,
                optionalString(b.location, "City", 80),
              )
          ).lastInsertRowid,
        );
        await db
          .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
          .run(id, "added", `Received from ${source.name}`, actorId, at);
        if (read)
          await db
            .prepare("UPDATE candidates SET resume_text=?,skills=?,experience_years=? WHERE id=?")
            .run(read.text, JSON.stringify(read.skills), read.experience_years, id);
      } else {
        // Fill in what the earlier record lacked.
        await db
          .prepare("UPDATE candidates SET email=COALESCE(email,?),phone=COALESCE(phone,?),updated_at=? WHERE id=?")
          .run(email, phone, at, id);
        await db
          .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
          .run(id, "note", `Also received from ${source.name}`, actorId, at);
      }
      await db
        .prepare("INSERT INTO candidate_sources(candidate_id,source_id,source_name,external_ref,received_at) VALUES(?,?,?,?,?)")
        .run(id, source.id ?? null, source.name, ref, at);
      if (file)
        await db
          .prepare("INSERT INTO candidate_files(candidate_id,kind,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)")
          .run(id, "resume", file.name, file.mime, file.size, await app.blobs.put(file.data, "resumes"), at);
      if (!dup) await rescoreCandidate(db, id);
      return id;
    });
    if (!dup && email) {
      const cand = await db.prepare("SELECT * FROM candidates WHERE id=?").get(id);
      await candidateMail(app, cand, "acknowledgement", {}).catch(() => {});
    }
    // A photo or scanned PDF is read by OCR in the background.
    const later = Boolean(file && !read && !dup && needsOcr(file.mime));
    if (later)
      readResumeLater(db, id, Buffer.from(file.data, "base64"), file.mime, {
        rescore: rescoreCandidate,
        nameIsGuess: !b.name,
        at,
      });
    return {
      id,
      duplicate: Boolean(dup),
      ...(later ? { reading: true } : {}),
      ...(read ? { read: { name: !b.name && Boolean(read.name), email: read.email, phone: read.phone, experience_years: read.experience_years, skills: read.skills } } : {}),
    };
  }
  app.rmsIntake = intake;
  const openingFor = async (companyId, b) => {
    const raw = b.opening_id ?? b.job_code;
    const id = Number(String(raw ?? "").replace(/^J/i, ""));
    const o = Number.isSafeInteger(id)
      ? await db.prepare("SELECT * FROM job_openings WHERE id=? AND company_id=?").get(id, companyId)
      : null;
    if (!o) throw new HttpError(404, "No such job opening. Send opening_id (or job_code like J12).");
    if (o.status === "closed") throw new HttpError(409, "This job opening is closed.");
    return o;
  };

  // ---- sources ----------------------------------------------------------------------
  router.get("/api/admin/rms/sources", { perm: "recruitment.manage" }, async ({ companyId, send }) =>
    send(200, {
      kinds: SOURCE_KINDS,
      items: (await db
        .prepare(
          "SELECT id,name,kind,key_hint,active,received,created_at,last_used_at,fee_per_hire,monthly_cost,default_opening_id,last_error,settings FROM intake_sources WHERE company_id=? ORDER BY name",
        )
        .all(companyId))
        .map(({ settings, ...s }) => {
          const x = JSON.parse(settings || "{}");
          return { ...s, mailbox: x.mailbox ? { host: x.host, user: x.user } : null };
        }),
    }),
  );
  // The key is shown once; only its hash is kept.
  router.post("/api/admin/rms/sources", { perm: "recruitment.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body();
    const kind = oneOf(b.kind, "Source type", Object.keys(SOURCE_KINDS));
    const name = optionalString(b.name, "Name", 60) ?? SOURCE_KINDS[kind];
    const key = `rms_${randomBytes(24).toString("base64url")}`;
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO intake_sources(company_id,name,kind,key_hash,key_hint,created_by,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(companyId, name, kind, hash(key), key.slice(-4), user.id, nowIso())
      ).lastInsertRowid,
    );
    await audit("rms_source_added", { id, kind });
    return send(201, { id, key, intake_path: `/api/intake/${key}` });
  });
  router.patch("/api/admin/rms/sources/:id", { perm: "recruitment.manage" }, async ({ params, companyId, body, send, audit }) => {
    const b = await body();
    const r = await db
      .prepare("UPDATE intake_sources SET active=? WHERE id=? AND company_id=?")
      .run(b.active ? 1 : 0, integer(Number(params.id)), companyId);
    if (!r.changes) throw new HttpError(404, "Source not found.");
    await audit("rms_source_updated", { id: Number(params.id), active: Boolean(b.active) });
    return send(200, { ok: true });
  });

  // ---- intake from a connector (no sign-in; the key is the credential) ---------------------
  router.post("/api/intake/:key", { public: true }, async ({ req, params, body, send }) => {
    rateLimit(`intake:${clientIp(req)}`, 600);
    const source = await db
      .prepare("SELECT * FROM intake_sources WHERE key_hash=? AND active=1")
      .get(hash(String(params.key)));
    if (!source) throw new HttpError(401, "Unknown or switched-off source key.");
    const b = await body(4_500_000);
    const opening = await openingFor(source.company_id, b);
    const r = await intake(source.company_id, opening, source, b, null);
    await db
      .prepare("UPDATE intake_sources SET received=received+1,last_used_at=? WHERE id=?")
      .run(nowIso(), source.id);
    if (!r.duplicate)
      await app.notify(
        (await staffWith(db, source.company_id, ["recruitment.manage"])).map((u) => u.id),
        {
          companyId: source.company_id,
          kind: "hiring",
          title: `New resume from ${source.name} for ${opening.title}`,
          link: "rms",
        },
      );
    return send(201, r);
  });

  // ---- HR imports resumes by hand (up to 20 at a time) ---------------------------------------
  router.post("/api/admin/rms/openings/:id/resumes", { perm: "recruitment.manage" }, async ({ user, params, companyId, body, send, audit }) => {
    const b = await body(30_000_000);
    const opening = await openingFor(companyId, { opening_id: params.id });
    const items = Array.isArray(b.items) ? b.items : [];
    if (!items.length || items.length > 20) throw new HttpError(400, "Import between 1 and 20 resumes at a time.");
    const source = b.source_id
      ? await db.prepare("SELECT * FROM intake_sources WHERE id=? AND company_id=?").get(integer(Number(b.source_id)), companyId)
      : { id: null, name: SOURCE_KINDS[oneOf(b.kind ?? "other", "Source type", Object.keys(SOURCE_KINDS))] };
    if (!source) throw new HttpError(400, "Choose one of your sources.");
    const results = [];
    for (const item of items) {
      try {
        results.push({ ok: true, ...(await intake(companyId, opening, source, item, user.id)) });
      } catch (e) {
        results.push({ ok: false, error: e.message, name: item?.name ?? null });
      }
    }
    await audit("rms_resumes_imported", { opening: opening.id, count: results.filter((r) => r.ok).length });
    return send(201, { results });
  });

  // ---- the inbox for one job, and a summary across jobs -----------------------------------------
  router.get("/api/admin/rms/openings", { perm: "recruitment.manage" }, async ({ companyId, send }) => {
    const openings = await db
      .prepare(
        `SELECT o.id,o.title,o.status,o.positions,b.name branch_name,
           (SELECT COUNT(*) FROM candidates c WHERE c.opening_id=o.id) candidates
         FROM job_openings o LEFT JOIN branches b ON b.id=o.branch_id WHERE o.company_id=? ORDER BY o.status='closed',o.id DESC`,
      )
      .all(companyId);
    const bySource = await db
      .prepare(
        `SELECT c.opening_id,COALESCE(s.source_name,c.source,'Not recorded') source,COUNT(DISTINCT c.id) n
         FROM candidates c LEFT JOIN candidate_sources s ON s.candidate_id=c.id WHERE c.company_id=? GROUP BY 1,2`,
      )
      .all(companyId);
    return send(
      200,
      openings.map((o) => ({
        ...o,
        candidates: Number(o.candidates),
        sources: bySource
          .filter((s) => s.opening_id === o.id)
          .map((s) => ({ name: s.source, n: Number(s.n) }))
          .sort((a, b) => b.n - a.n),
      })),
    );
  });
  router.get("/api/admin/rms/openings/:id/inbox", { perm: "recruitment.manage" }, async ({ params, query, companyId, send }) => {
    const opening = await db
      .prepare("SELECT id,title,status FROM job_openings WHERE id=? AND company_id=?")
      .get(integer(Number(params.id)), companyId);
    if (!opening) throw new HttpError(404, "Job opening not found.");
    // Every word must appear in the name, contact details, skills or the resume itself.
    const words = String(query.get("q") ?? "")
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 6);
    const people = await db
      .prepare(
        `SELECT c.id,c.name,c.email,c.phone,c.stage,c.source,c.match_score,c.created_at,c.skills,c.experience_years,
           (SELECT f.id FROM candidate_files f WHERE f.candidate_id=c.id AND f.kind='resume' ORDER BY f.id DESC LIMIT 1) resume_id,
           (SELECT COUNT(*) FROM candidate_files f WHERE f.candidate_id=c.id AND f.kind='resume') resumes
         FROM candidates c WHERE c.opening_id=? AND c.company_id=?${words.length ? words.map(() => " AND LOWER(CONCAT_WS(' ',c.name,c.email,c.phone,c.skills,c.resume_text)) LIKE ?").join("") : ""}
         ORDER BY c.created_at DESC LIMIT 500`,
      )
      .all(opening.id, companyId, ...words.map((w) => `%${w.replace(/[%_\\]/g, "")}%`));
    const sources = await db
      .prepare(
        `SELECT s.candidate_id,s.source_name,s.received_at FROM candidate_sources s JOIN candidates c ON c.id=s.candidate_id
         WHERE c.opening_id=? ORDER BY s.id`,
      )
      .all(opening.id);
    return send(200, {
      opening,
      people: people.map((p) => {
        const mine = sources.filter((s) => s.candidate_id === p.id).map((s) => s.source_name);
        return {
          ...p,
          skills: JSON.parse(p.skills || "[]"),
          resumes: Number(p.resumes),
          sources: [...new Set(mine.length ? mine : [p.source || "Not recorded"])],
        };
      }),
    });
  });
}
