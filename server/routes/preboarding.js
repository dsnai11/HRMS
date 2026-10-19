import { randomBytes } from "node:crypto";
import {
  HttpError,
  clientIp,
  integer,
  isoDate,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { tokenHash } from "../db.js";
import { requireOwned } from "../scope.js";
import { offerLetter } from "../letters.js";
import {
  decryptJson,
  encryptJson,
  encryptionKey,
  mask,
} from "../crypto-store.js";
import { KINDS, TYPES, checkFile } from "./documents.js";
import { cleanPrivate } from "./payroll-setup.js";

const LINK_DAYS = 30;
const MAX_DOCS = 12;
const EDITABLE = ["invited", "in_progress", "changes_requested"];
const GENDERS = ["male", "female", "other"];
const SENSITIVE = ["pan", "uan", "esi_ip", "bank_account"];
const phoneOk = /^[0-9+()\-\s]{7,20}$/;

const text = (v, label, max) => {
  const s = optionalString(v, label, max);
  return s === null || s === "" ? null : s;
};
const phone = (v, label) => {
  const s = text(v, label, 20);
  if (s !== null && !phoneOk.test(s))
    throw new HttpError(400, `${label} must be a valid phone number.`);
  return s;
};
const rows = (v, label, shape) => {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 6)
    throw new HttpError(400, `${label}: add up to 6 entries.`);
  return v.map((r) => {
    const out = {};
    for (const [k, [l, max]] of Object.entries(shape))
      out[k] = text(r?.[k], l, max);
    return out;
  });
};

/** Checks the editable (non-secret) part of the form; only fields that are present are changed. */
export function cleanForm(b, base = {}) {
  const f = { ...base };
  if (b.date_of_birth !== undefined) {
    f.date_of_birth = b.date_of_birth
      ? isoDate(b.date_of_birth, "Date of birth")
      : null;
    if (
      f.date_of_birth &&
      f.date_of_birth > new Date().toISOString().slice(0, 10)
    )
      throw new HttpError(400, "Date of birth cannot be in the future.");
  }
  if (b.gender !== undefined)
    f.gender = b.gender ? oneOf(b.gender, "Gender", GENDERS) : null;
  if (b.phone !== undefined) f.phone = phone(b.phone, "Phone");
  if (b.address !== undefined) f.address = text(b.address, "Address", 300);
  if (b.emergency_name !== undefined)
    f.emergency_name = text(b.emergency_name, "Emergency contact name", 100);
  if (b.emergency_phone !== undefined)
    f.emergency_phone = phone(b.emergency_phone, "Emergency contact phone");
  if (b.emergency_relation !== undefined)
    f.emergency_relation = text(
      b.emergency_relation,
      "Emergency contact relation",
      50,
    );
  if (b.education !== undefined)
    f.education = rows(b.education, "Education", {
      degree: ["Degree", 100],
      institute: ["Institute", 120],
      year: ["Year", 4],
      score: ["Score", 20],
    });
  if (b.employment !== undefined)
    f.employment = rows(b.employment, "Previous employment", {
      employer: ["Employer", 120],
      role: ["Role", 100],
      from: ["From", 10],
      to: ["To", 10],
      reason: ["Reason for leaving", 200],
    });
  return f;
}

export function registerPreboarding(router, app) {
  const { db, transaction, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const openRate = (req) => rateLimit(`join:${clientIp(req)}`, 300);

  const hrIds = async (companyId) =>
    (
      await db
        .prepare(
          "SELECT id FROM users WHERE company_id=? AND active=1 AND role IN ('admin','hr')",
        )
        .all(companyId)
    ).map((r) => r.id);

  async function byToken(token) {
    if (typeof token !== "string" || token.length < 20 || token.length > 100)
      throw new HttpError(404, "This link is not valid.");
    const p = await db
      .prepare("SELECT * FROM preboarding WHERE token_hash=?")
      .get(tokenHash(token));
    if (!p) throw new HttpError(404, "This link is not valid.");
    if (p.expires_at < nowIso())
      throw new HttpError(410, "This link has expired. Ask HR for a new one.");
    const candidate = await db
      .prepare("SELECT * FROM candidates WHERE id=?")
      .get(p.candidate_id);
    if (candidate.stage === "hired")
      throw new HttpError(
        410,
        "You have already joined. Please sign in to the HR portal.",
      );
    if (["rejected", "withdrawn"].includes(candidate.stage))
      throw new HttpError(410, "This link is no longer active.");
    const offer = await db
      .prepare(
        "SELECT * FROM offers WHERE candidate_id=? AND status IN ('sent','accepted') ORDER BY id DESC",
      )
      .get(candidate.id);
    return { p, candidate, offer };
  }
  const readSensitive = (p) => {
    const key = encryptionKey();
    return p.sensitive && key ? decryptJson(p.sensitive, key) : {};
  };
  const maskedSensitive = (p) =>
    Object.fromEntries(
      Object.entries(readSensitive(p)).map(([k, v]) => [
        k,
        SENSITIVE.includes(k) ? mask(v) : v,
      ]),
    );
  const docsOf = (id) =>
    db
      .prepare(
        "SELECT id,kind,name,mime,size,verified,created_at FROM preboarding_documents WHERE preboarding_id=? ORDER BY id",
      )
      .all(id);
  const markProgress = (p) =>
    p.status === "invited"
      ? db
          .prepare("UPDATE preboarding SET status='in_progress' WHERE id=?")
          .run(p.id)
      : null;

  // ---- candidate side: no login, the link is the credential ---------------------------------
  router.get(
    "/api/join/:token",
    { public: true },
    async ({ req, params, send }) => {
      openRate(req);
      const { p, candidate, offer } = await byToken(params.token);
      await db
        .prepare("UPDATE preboarding SET last_opened_at=? WHERE id=?")
        .run(nowIso(), p.id);
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(p.company_id);
      return send(200, {
        company: company.name,
        name: candidate.name,
        status: p.status,
        hr_note: p.hr_note,
        editable: EDITABLE.includes(p.status),
        encryption_configured: Boolean(encryptionKey()),
        offer: offer
          ? {
              status: offer.status,
              designation: offer.designation,
              joining_date: offer.joining_date,
              valid_until: offer.valid_until,
              letter: offerLetter({
                company: company.name,
                candidate,
                offer,
                today: today(),
              }),
            }
          : null,
        form: JSON.parse(p.form),
        sensitive: maskedSensitive(p),
        documents: await docsOf(p.id),
        doc_kinds: KINDS.filter((k) => k !== "offer_letter"),
      });
    },
  );
  router.post(
    "/api/join/:token/accept",
    { public: true },
    async ({ req, params, body, send, audit }) => {
      openRate(req);
      const { p, candidate, offer } = await byToken(params.token);
      if (!offer || offer.status !== "sent")
        throw new HttpError(409, "There is no offer waiting for your reply.");
      if (offer.valid_until && offer.valid_until < today())
        throw new HttpError(409, "This offer has expired. Please contact HR.");
      const norm = (s) => s.trim().replace(/\s+/g, " ").toLowerCase();
      const typed = string((await body()).full_name, "Full name", 100);
      if (norm(typed) !== norm(candidate.name))
        throw new HttpError(
          400,
          "Type your full name exactly as it appears at the top of the letter.",
        );
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE offers SET status='accepted',decided_at=?,accepted_name=?,accepted_ip=? WHERE id=?",
          )
          .run(nowIso(), typed.trim(), clientIp(req), offer.id);
        await db
          .prepare(
            "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
          )
          .run(
            candidate.id,
            "offer_accepted",
            "Accepted online",
            null,
            nowIso(),
          );
      });
      await app.notify(await hrIds(p.company_id), {
        companyId: p.company_id,
        kind: "hiring",
        title: `${candidate.name} accepted the offer`,
        link: "hiring",
        email: true,
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/join/:token/decline",
    { public: true },
    async ({ req, params, body, send }) => {
      openRate(req);
      const { p, candidate, offer } = await byToken(params.token);
      if (!offer || offer.status !== "sent")
        throw new HttpError(409, "There is no offer waiting for your reply.");
      const reason = text((await body()).reason, "Reason", 300);
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE offers SET status='declined',decided_at=? WHERE id=?",
          )
          .run(nowIso(), offer.id);
        await db
          .prepare(
            "UPDATE candidates SET stage='rejected',closed_reason=?,updated_at=? WHERE id=?",
          )
          .run(
            reason ? `Declined the offer: ${reason}` : "Declined the offer",
            nowIso(),
            candidate.id,
          );
        await db
          .prepare(
            "INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)",
          )
          .run(candidate.id, "offer_declined", reason, null, nowIso());
      });
      await app.notify(await hrIds(p.company_id), {
        companyId: p.company_id,
        kind: "hiring",
        title: `${candidate.name} declined the offer`,
        link: "hiring",
        email: true,
      });
      return send(200, { ok: true });
    },
  );
  router.put(
    "/api/join/:token/form",
    { public: true },
    async ({ req, params, body, send }) => {
      openRate(req);
      const { p } = await byToken(params.token);
      if (!EDITABLE.includes(p.status))
        throw new HttpError(
          409,
          "Your details are with HR. Please wait for their reply.",
        );
      const b = await body(64_000);
      const form = cleanForm(b, JSON.parse(p.form));
      let sensitive = p.sensitive;
      const wantsSecret = Object.keys(b).some((k) =>
        [
          "pan",
          "uan",
          "esi_ip",
          "bank_account",
          "ifsc",
          "bank_name",
          "account_holder",
        ].includes(k),
      );
      if (wantsSecret) {
        const key = encryptionKey();
        if (!key)
          throw new HttpError(
            503,
            "Bank and ID numbers cannot be saved online yet. Please give them to HR directly.",
          );
        // A masked value sent back unchanged (••••1234) means "keep what is stored".
        const incoming = Object.fromEntries(
          Object.entries(b).filter(
            ([, v]) => typeof v !== "string" || !v.includes("•"),
          ),
        );
        sensitive = encryptJson(cleanPrivate(incoming, readSensitive(p)), key);
      }
      await db
        .prepare("UPDATE preboarding SET form=?,sensitive=? WHERE id=?")
        .run(JSON.stringify(form), sensitive ?? null, p.id);
      await markProgress(p);
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/join/:token/documents",
    { public: true },
    async ({ req, params, body, send }) => {
      openRate(req);
      const { p } = await byToken(params.token);
      if (!EDITABLE.includes(p.status))
        throw new HttpError(
          409,
          "Your details are with HR. Please wait for their reply.",
        );
      const b = await body(3_000_000);
      const { mime, data, bytes } = checkFile(b);
      const kind = oneOf(
        b.kind ?? "other",
        "Type",
        KINDS.filter((k) => k !== "offer_letter"),
      );
      if (
        (
          await db
            .prepare(
              "SELECT COUNT(*) n FROM preboarding_documents WHERE preboarding_id=?",
            )
            .get(p.id)
        ).n >= MAX_DOCS
      )
        throw new HttpError(
          409,
          `You can upload up to ${MAX_DOCS} files. Remove one first.`,
        );
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO preboarding_documents(preboarding_id,kind,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              p.id,
              kind,
              string(b.name, "Name", 120).replace(/[\\/\r\n"]/g, "_"),
              mime,
              bytes.length,
              data,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await markProgress(p);
      return send(201, { id });
    },
  );
  router.delete(
    "/api/join/:token/documents/:id",
    { public: true },
    async ({ req, params, send }) => {
      openRate(req);
      const { p } = await byToken(params.token);
      if (!EDITABLE.includes(p.status))
        throw new HttpError(
          409,
          "Your details are with HR. Please wait for their reply.",
        );
      await db
        .prepare(
          "DELETE FROM preboarding_documents WHERE id=? AND preboarding_id=?",
        )
        .run(integer(Number(params.id)), p.id);
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/join/:token/submit",
    { public: true },
    async ({ req, params, send }) => {
      openRate(req);
      const { p, candidate, offer } = await byToken(params.token);
      if (!EDITABLE.includes(p.status))
        throw new HttpError(409, "Your details have already been submitted.");
      if (!offer || offer.status !== "accepted")
        throw new HttpError(
          409,
          "Please accept the offer before submitting your details.",
        );
      const form = JSON.parse(p.form);
      const missing = [];
      for (const [k, l] of [
        ["date_of_birth", "date of birth"],
        ["address", "address"],
        ["emergency_name", "emergency contact name"],
        ["emergency_phone", "emergency contact phone"],
      ])
        if (!form[k]) missing.push(l);
      if (encryptionKey()) {
        const s = readSensitive(p);
        for (const [k, l] of [
          ["bank_account", "bank account number"],
          ["ifsc", "IFSC"],
          ["account_holder", "account holder name"],
        ])
          if (!s[k]) missing.push(l);
      }
      const kinds = (await docsOf(p.id)).map((d) => d.kind);
      for (const [k, l] of [
        ["id_proof", "an ID proof"],
        ["address_proof", "an address proof"],
      ])
        if (!kinds.includes(k)) missing.push(`upload ${l}`);
      if (missing.length)
        throw new HttpError(400, `Still needed: ${missing.join(", ")}.`);
      await db
        .prepare(
          "UPDATE preboarding SET status='submitted',submitted_at=?,hr_note=NULL WHERE id=?",
        )
        .run(nowIso(), p.id);
      await app.notify(await hrIds(p.company_id), {
        companyId: p.company_id,
        kind: "hiring",
        title: `${candidate.name} submitted joining details`,
        link: "hiring",
        email: true,
      });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/join/:token/documents/:id/file",
    { public: true },
    async ({ req, params, res, headers }) => {
      openRate(req);
      const { p } = await byToken(params.token);
      const d = await db
        .prepare(
          "SELECT * FROM preboarding_documents WHERE id=? AND preboarding_id=?",
        )
        .get(integer(Number(params.id)), p.id);
      if (!d) throw new HttpError(404, "Document not found.");
      res.writeHead(200, {
        ...headers,
        "Content-Type": d.mime,
        "Content-Disposition": `inline; filename="${d.name}.${TYPES[d.mime]}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(d.data, "base64"));
    },
  );

  // ---- HR side ------------------------------------------------------------------------------
  router.post(
    "/api/admin/candidates/:id/preboarding/invite",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, send, audit }) => {
      const c = await requireOwned(
        db,
        "candidates",
        integer(Number(params.id)),
        companyId,
        "candidate",
      );
      if (c.stage === "hired")
        throw new HttpError(409, "This candidate has already joined.");
      const offer = await db
        .prepare(
          "SELECT * FROM offers WHERE candidate_id=? AND status IN ('sent','accepted') ORDER BY id DESC",
        )
        .get(c.id);
      if (!offer)
        throw new HttpError(
          409,
          "Mark the offer as sent before inviting the candidate to the joining portal.",
        );
      const token = randomBytes(32).toString("base64url");
      const expires = new Date(clock() + LINK_DAYS * 86400000).toISOString();
      const existing = await db
        .prepare("SELECT id FROM preboarding WHERE candidate_id=?")
        .get(c.id);
      if (existing)
        await db
          .prepare(
            "UPDATE preboarding SET token_hash=?,expires_at=? WHERE id=?",
          )
          .run(tokenHash(token), expires, existing.id);
      else
        await db
          .prepare(
            "INSERT INTO preboarding(company_id,candidate_id,token_hash,expires_at,created_by,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(companyId, c.id, tokenHash(token), expires, user.id, nowIso());
      const base = (
        process.env.APP_URL ||
        process.env.PUBLIC_URL ||
        ""
      ).replace(/\/$/, "");
      const link = `${base}/join.html?t=${token}`;
      const company = await db
        .prepare("SELECT name FROM companies WHERE id=?")
        .get(companyId);
      const emailed = c.email
        ? await app.notify.mail(
            companyId,
            c.email,
            `Your offer from ${company.name}`,
            `Dear ${c.name},\n\nCongratulations. Please use the secure link below to read your offer, accept it and share your joining details:\n\n${link}\n\nThe link is valid for ${LINK_DAYS} days and is meant only for you.\n\n${company.name}`,
          )
        : false;
      await audit("preboarding_invited", { candidateId: c.id });
      return send(201, { link, emailed, expires_at: expires });
    },
  );
  router.get(
    "/api/admin/candidates/:id/preboarding",
    { perm: "recruitment.manage" },
    async ({ params, companyId, send }) => {
      const c = await requireOwned(
        db,
        "candidates",
        integer(Number(params.id)),
        companyId,
        "candidate",
      );
      const p = await db
        .prepare("SELECT * FROM preboarding WHERE candidate_id=?")
        .get(c.id);
      if (!p) return send(200, { invited: false });
      return send(200, {
        invited: true,
        id: p.id,
        status: p.status,
        expires_at: p.expires_at,
        expired: p.expires_at < nowIso(),
        submitted_at: p.submitted_at,
        last_opened_at: p.last_opened_at,
        hr_note: p.hr_note,
        form: JSON.parse(p.form),
        sensitive: maskedSensitive(p),
        documents: await docsOf(p.id),
      });
    },
  );
  const ownedDoc = async (id, companyId) => {
    const d = await db
      .prepare(
        "SELECT d.*,p.company_id FROM preboarding_documents d JOIN preboarding p ON p.id=d.preboarding_id WHERE d.id=?",
      )
      .get(integer(Number(id)));
    if (!d || d.company_id !== companyId)
      throw new HttpError(404, "Document not found.");
    return d;
  };
  router.get(
    "/api/admin/preboarding/documents/:id/file",
    { perm: "recruitment.manage" },
    async ({ params, companyId, res, headers, audit }) => {
      const d = await ownedDoc(params.id, companyId);
      await audit("preboarding_document_viewed", { id: d.id });
      res.writeHead(200, {
        ...headers,
        "Content-Type": d.mime,
        "Content-Disposition": `inline; filename="${d.name}.${TYPES[d.mime]}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(d.data, "base64"));
    },
  );
  router.post(
    "/api/admin/preboarding/documents/:id/verify",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const d = await ownedDoc(params.id, companyId);
      const verified = (await body()).verified === false ? 0 : 1;
      await db
        .prepare("UPDATE preboarding_documents SET verified=? WHERE id=?")
        .run(verified, d.id);
      await audit("preboarding_document_verified", { id: d.id, verified });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/candidates/:id/preboarding/review",
    { perm: "recruitment.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const c = await requireOwned(
        db,
        "candidates",
        integer(Number(params.id)),
        companyId,
        "candidate",
      );
      const p = await db
        .prepare("SELECT * FROM preboarding WHERE candidate_id=?")
        .get(c.id);
      if (!p || p.status !== "submitted")
        throw new HttpError(409, "There is nothing waiting for review.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", [
        "verified",
        "changes_requested",
      ]);
      const note = text(b.note, "Note", 500);
      if (decision === "changes_requested" && !note)
        throw new HttpError(400, "Tell the candidate what to correct.");
      if (decision === "verified") {
        const bad = await db
          .prepare(
            "SELECT COUNT(*) n FROM preboarding_documents WHERE preboarding_id=? AND verified=0 AND kind IN ('id_proof','address_proof')",
          )
          .get(p.id);
        if (bad.n > 0)
          throw new HttpError(
            409,
            "Verify the ID and address proofs before approving.",
          );
      }
      await db
        .prepare(
          "UPDATE preboarding SET status=?,hr_note=?,verified_by=?,verified_at=? WHERE id=?",
        )
        .run(decision, note, user.id, nowIso(), p.id);
      await audit("preboarding_reviewed", { candidateId: c.id, decision });
      if (decision === "changes_requested" && c.email) {
        await app.notify.mail(
          companyId,
          c.email,
          "Please update your joining details",
          `Dear ${c.name},\n\nHR needs a correction in your joining details:\n\n${note}\n\nPlease open your joining link again to update and resubmit.`,
        );
      }
      return send(200, { ok: true });
    },
  );
  // Everyone due to join or recently joined, with how far their onboarding has got.
  router.get(
    "/api/admin/onboarding/joiners",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const pending = await db
        .prepare(
          `SELECT c.id candidate_id,c.name,o.designation,o.joining_date,o.status offer_status,p.status preboarding_status,
             (SELECT COUNT(*) FROM preboarding_documents d WHERE d.preboarding_id=p.id) docs,
             (SELECT COUNT(*) FROM preboarding_documents d WHERE d.preboarding_id=p.id AND d.verified=1) docs_verified
           FROM candidates c JOIN offers o ON o.candidate_id=c.id AND o.status IN ('sent','accepted')
           LEFT JOIN preboarding p ON p.candidate_id=c.id
           WHERE c.company_id=? AND c.stage='offer' ORDER BY o.joining_date`,
        )
        .all(companyId);
      const joined = await db
        .prepare(
          `SELECT u.id user_id,u.name,u.employee_code,u.date_of_joining,u.probation_end_date,b.name buddy_name,
             (SELECT COUNT(*) FROM onboarding_tasks t WHERE t.user_id=u.id) tasks,
             (SELECT COUNT(*) FROM onboarding_tasks t WHERE t.user_id=u.id AND t.done=1) tasks_done
           FROM users u LEFT JOIN users b ON b.id=u.buddy_id
           WHERE u.company_id=? AND u.active=1 AND u.date_of_joining>=? ORDER BY u.date_of_joining DESC LIMIT 100`,
        )
        .all(companyId, addDays(today(), -60));
      return send(200, { pending, joined });
    },
  );
  function addDays(d, n) {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + n);
    return x.toISOString().slice(0, 10);
  }
}

/** Reads a candidate's pre-boarding data for the hire step: profile fields, secrets and files. */
export async function preboardingForHire(app, candidateId) {
  const p = await app.db
    .prepare("SELECT * FROM preboarding WHERE candidate_id=?")
    .get(candidateId);
  if (!p) return null;
  const key = encryptionKey();
  return {
    id: p.id,
    status: p.status,
    form: JSON.parse(p.form),
    sensitive: p.sensitive && key ? decryptJson(p.sensitive, key) : {},
    documents: await app.db
      .prepare(
        "SELECT * FROM preboarding_documents WHERE preboarding_id=? ORDER BY id",
      )
      .all(p.id),
  };
}
