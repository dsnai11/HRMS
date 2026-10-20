import {
  HttpError,
  clientIp,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { decryptJson, encryptJson, encryptionKey } from "../crypto-store.js";
import {
  DEFAULT_CONSENT,
  RISK_LABEL,
  assertPublicHttps,
  callProvider,
  riskOf,
} from "../credit.js";
import { cleanPrivate } from "./payroll-setup.js";
import { preboardingForHire } from "./preboarding.js";

const defaults = (companyId) => ({
  company_id: companyId,
  enabled: 0,
  provider_name: "CIBIL",
  method: "POST",
  url: null,
  auth_header: "Authorization",
  api_key_enc: null,
  body_template:
    '{"pan":"{{pan}}","name":"{{name}}","dob":"{{dob}}","mobile":"{{phone}}"}',
  score_path: "score",
  low_min: 750,
  medium_min: 650,
  required_before_hire: 0,
  consent_text: null,
});

export async function loadCreditSettings(db, companyId) {
  return (
    (await db
      .prepare("SELECT * FROM credit_settings WHERE company_id=?")
      .get(companyId)) ?? defaults(companyId)
  );
}

/** Used by hire: is a credit check on file, and is high risk acknowledged? */
export async function creditGate(db, companyId, candidateId, override) {
  const s = await loadCreditSettings(db, companyId);
  if (!s.enabled || !s.required_before_hire) return null;
  const last = await db
    .prepare(
      "SELECT * FROM credit_checks WHERE candidate_id=? AND status IN ('completed','manual') ORDER BY id DESC LIMIT 1",
    )
    .get(candidateId);
  if (!last) return "Complete the credit check before hiring this candidate.";
  if (last.risk === "high" && !override)
    return "The credit check shows high risk. Add a note to confirm you want to proceed.";
  return null;
}

export function registerCredit(router, app) {
  const { db, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const owned = (table, id, companyId, label) =>
    requireOwned(db, table, integer(Number(id)), companyId, label);
  const consentText = (s) => s.consent_text || DEFAULT_CONSENT;

  router.get(
    "/api/admin/credit/settings",
    { perm: "credit.manage" },
    async ({ companyId, send }) => {
      const { api_key_enc, ...s } = await loadCreditSettings(db, companyId);
      return send(200, {
        ...s,
        enabled: Boolean(s.enabled),
        required_before_hire: Boolean(s.required_before_hire),
        consent_text: consentText(s),
        api_key_set: Boolean(api_key_enc),
        encryption_configured: Boolean(encryptionKey()),
      });
    },
  );
  router.put(
    "/api/admin/credit/settings",
    { perm: "credit.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body();
      const cur = await loadCreditSettings(db, companyId);
      const next = { ...cur };
      if (b.enabled !== undefined) next.enabled = b.enabled ? 1 : 0;
      if (b.required_before_hire !== undefined)
        next.required_before_hire = b.required_before_hire ? 1 : 0;
      if (b.provider_name !== undefined)
        next.provider_name = string(b.provider_name, "Bureau name", 40);
      if (b.method !== undefined)
        next.method = oneOf(b.method, "Method", ["GET", "POST"]);
      if (b.url !== undefined) {
        next.url = b.url ? string(b.url, "Provider address", 500) : null;
        if (next.url)
          await assertPublicHttps(next.url).catch((e) => {
            throw new HttpError(400, e.message);
          });
      }
      if (b.auth_header !== undefined) {
        next.auth_header = string(b.auth_header, "Header name", 60);
        if (!/^[A-Za-z0-9-]+$/.test(next.auth_header))
          throw new HttpError(
            400,
            "The header name can only have letters, digits and hyphens.",
          );
      }
      if (b.body_template !== undefined) {
        next.body_template =
          optionalString(b.body_template, "Request body", 2000) || null;
        if (next.body_template)
          try {
            JSON.parse(next.body_template.replace(/\{\{\w+\}\}/g, "x"));
          } catch {
            throw new HttpError(
              400,
              "The request body must be valid JSON (you can use {{pan}}, {{name}}, {{dob}}, {{phone}}).",
            );
          }
      }
      if (b.score_path !== undefined)
        next.score_path = string(b.score_path, "Score field", 100);
      if (b.low_min !== undefined)
        next.low_min = Math.round(number(b.low_min, "Low-risk from", 300, 900));
      if (b.medium_min !== undefined)
        next.medium_min = Math.round(
          number(b.medium_min, "Medium-risk from", 300, 900),
        );
      if (next.medium_min >= next.low_min)
        throw new HttpError(
          400,
          "The medium-risk score must be below the low-risk score.",
        );
      if (b.consent_text !== undefined)
        next.consent_text =
          optionalString(b.consent_text, "Consent wording", 2000) || null;
      if (b.api_key) {
        const key = encryptionKey();
        if (!key)
          throw new HttpError(
            503,
            "The key cannot be stored until the server has DATA_ENCRYPTION_KEY set.",
          );
        next.api_key_enc = encryptJson(
          { api_key: string(b.api_key, "API key", 500) },
          key,
        );
      }
      if (b.clear_api_key) next.api_key_enc = null;
      if (next.enabled && next.method === "GET" && !next.url)
        throw new HttpError(
          400,
          "Enter the provider address, or turn off the automatic lookup.",
        );
      await db
        .prepare(
          `INSERT INTO credit_settings(company_id,enabled,provider_name,method,url,auth_header,api_key_enc,body_template,score_path,low_min,medium_min,required_before_hire,consent_text,updated_by,updated_at)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT (company_id) DO UPDATE SET enabled=EXCLUDED.enabled,provider_name=EXCLUDED.provider_name,method=EXCLUDED.method,url=EXCLUDED.url,auth_header=EXCLUDED.auth_header,api_key_enc=EXCLUDED.api_key_enc,body_template=EXCLUDED.body_template,score_path=EXCLUDED.score_path,low_min=EXCLUDED.low_min,medium_min=EXCLUDED.medium_min,required_before_hire=EXCLUDED.required_before_hire,consent_text=EXCLUDED.consent_text,updated_by=EXCLUDED.updated_by,updated_at=EXCLUDED.updated_at`,
        )
        .run(
          companyId,
          next.enabled,
          next.provider_name,
          next.method,
          next.url,
          next.auth_header,
          next.api_key_enc,
          next.body_template,
          next.score_path,
          next.low_min,
          next.medium_min,
          next.required_before_hire,
          next.consent_text,
          user.id,
          nowIso(),
        );
      await audit("credit_settings_saved", {
        enabled: Boolean(next.enabled),
        required: Boolean(next.required_before_hire),
      });
      return send(200, { ok: true });
    },
  );

  // ---- consent ---------------------------------------------------------------------------------
  const consentOf = (candidateId) =>
    db
      .prepare(
        "SELECT * FROM credit_consents WHERE candidate_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(candidateId);
  // The candidate gives consent from their private joining link.
  router.post(
    "/api/join/:token/credit-consent",
    { public: true },
    async ({ req, params, body, send }) => {
      rateLimit(`join:${clientIp(req)}`, 300);
      const { tokenHash } = await import("../db.js");
      const p = await db
        .prepare("SELECT * FROM preboarding WHERE token_hash=?")
        .get(tokenHash(String(params.token)));
      if (!p || p.expires_at < nowIso())
        throw new HttpError(404, "This link is not valid.");
      const c = await db
        .prepare("SELECT * FROM candidates WHERE id=?")
        .get(p.candidate_id);
      const s = await loadCreditSettings(db, p.company_id);
      if (!s.enabled) throw new HttpError(409, "No credit check is requested.");
      const b = await body();
      if (b.agree !== true)
        throw new HttpError(400, "Tick the box to give your consent.");
      const typed = string(b.full_name, "Full name", 100)
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();
      if (typed !== c.name.trim().replace(/\s+/g, " ").toLowerCase())
        throw new HttpError(
          400,
          "Type your full name exactly as shown to confirm.",
        );
      await db
        .prepare(
          "INSERT INTO credit_consents(candidate_id,consent_text,given_name,given_ip,source,given_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          c.id,
          consentText(s),
          b.full_name.trim(),
          clientIp(req),
          "portal",
          nowIso(),
        );
      await app.audit(
        null,
        "credit_consent_given",
        { candidateId: c.id, source: "portal" },
        p.company_id,
      );
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/candidates/:id/credit-consent",
    { perm: "credit.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const note = string((await body()).note, "How consent was obtained", 300);
      await db
        .prepare(
          "INSERT INTO credit_consents(candidate_id,consent_text,source,note,recorded_by,given_at) VALUES(?,?,?,?,?,?)",
        )
        .run(
          c.id,
          consentText(await loadCreditSettings(db, companyId)),
          "hr_recorded",
          note,
          user.id,
          nowIso(),
        );
      await audit("credit_consent_recorded", { candidateId: c.id });
      return send(201, { ok: true });
    },
  );

  // ---- running a check -------------------------------------------------------------------------
  const shape = (r) => ({
    id: r.id,
    status: r.status,
    bureau: r.bureau,
    score: r.score,
    risk: r.risk,
    risk_label: r.risk ? RISK_LABEL[r.risk] : null,
    requested_at: r.requested_at,
    requested_by_name: r.requested_by_name,
    pan_last4: r.pan_last4,
    note: r.note,
    error: r.error,
    has_report: Boolean(r.report_enc),
  });
  const CHECK = `SELECT k.*,u.name requested_by_name FROM credit_checks k LEFT JOIN users u ON u.id=k.requested_by`;
  router.get(
    "/api/admin/candidates/:id/credit",
    { perm: "credit.manage" },
    async ({ params, companyId, send }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const s = await loadCreditSettings(db, companyId);
      const consent = await consentOf(c.id);
      return send(200, {
        enabled: Boolean(s.enabled),
        required_before_hire: Boolean(s.required_before_hire),
        automatic: Boolean(s.enabled && s.url),
        bureau: s.provider_name,
        consent: consent && {
          source: consent.source,
          given_at: consent.given_at,
          given_name: consent.given_name,
          note: consent.note,
        },
        checks: (
          await db
            .prepare(`${CHECK} WHERE k.candidate_id=? ORDER BY k.id DESC`)
            .all(c.id)
        ).map(shape),
      });
    },
  );
  router.post(
    "/api/admin/candidates/:id/credit-check",
    { perm: "credit.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const c = await owned("candidates", params.id, companyId, "candidate");
      const s = await loadCreditSettings(db, companyId);
      if (!s.enabled)
        throw new HttpError(
          409,
          "Turn on credit checks in the settings first.",
        );
      if (!(await consentOf(c.id)))
        throw new HttpError(
          409,
          "The candidate's consent is needed first. They can give it from their joining link, or you can record it.",
        );
      const b = await body();
      const key = encryptionKey();
      // PAN: given now, or taken from what the candidate entered on the joining portal.
      let data = {};
      if (b.pan) data = cleanPrivate({ pan: b.pan });
      else {
        const pre = await preboardingForHire(app, c.id);
        if (pre?.sensitive?.pan) data = { pan: pre.sensitive.pan };
      }
      const last4 = data.pan ? data.pan.slice(-4) : null;
      const note = optionalString(b.note, "Note", 500) || null;
      let row;
      if (
        b.manual_score !== undefined &&
        b.manual_score !== null &&
        b.manual_score !== ""
      ) {
        const score = Math.round(number(b.manual_score, "Score", 300, 900));
        row = {
          status: "manual",
          score,
          risk: riskOf(score, s),
          report: null,
          error: null,
        };
      } else {
        if (!s.url)
          throw new HttpError(
            409,
            "No bureau connection is set up. Enter the score from the bureau's report instead.",
          );
        if (!data.pan) throw new HttpError(400, "Enter the candidate's PAN.");
        const apiKey =
          s.api_key_enc && key ? decryptJson(s.api_key_enc, key).api_key : null;
        try {
          const r = await callProvider(s, apiKey, {
            pan: data.pan,
            name: c.name,
            dob: b.dob ? isoDate(b.dob, "Date of birth") : "",
            phone: c.phone ?? "",
            email: c.email ?? "",
          });
          row = {
            status: "completed",
            score: r.score,
            risk: riskOf(r.score, s),
            report: r.json,
            error: null,
          };
        } catch (e) {
          row = {
            status: "failed",
            score: null,
            risk: null,
            report: null,
            error: String(e.message).slice(0, 300),
          };
        }
      }
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO credit_checks(company_id,candidate_id,requested_by,requested_at,status,bureau,score,risk,pan_last4,report_enc,note,error) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              c.id,
              user.id,
              nowIso(),
              row.status,
              s.provider_name,
              row.score,
              row.risk,
              last4,
              row.report && key ? encryptJson(row.report, key) : null,
              note,
              row.error,
            )
        ).lastInsertRowid,
      );
      await audit("credit_check_run", {
        candidateId: c.id,
        checkId: id,
        status: row.status,
        risk: row.risk,
      });
      return send(row.status === "failed" ? 502 : 201, {
        id,
        ...shape({
          ...row,
          id,
          bureau: s.provider_name,
          requested_at: nowIso(),
          pan_last4: last4,
          note,
          report_enc: row.report,
        }),
      });
    },
  );
  router.get(
    "/api/admin/credit-checks/:id/report",
    { perm: "credit.manage" },
    async ({ params, companyId, send, audit }) => {
      const k = await owned(
        "credit_checks",
        params.id,
        companyId,
        "credit check",
      );
      const key = encryptionKey();
      if (!k.report_enc || !key)
        throw new HttpError(404, "No report is stored for this check.");
      await audit("credit_report_viewed", {
        checkId: k.id,
        candidateId: k.candidate_id,
      });
      return send(200, decryptJson(k.report_enc, key));
    },
  );

  // ---- HR dashboard ------------------------------------------------------------------------------
  router.get(
    "/api/admin/credit-checks",
    { perm: "credit.manage" },
    async ({ companyId, send }) => {
      const rows = await db
        .prepare(
          `SELECT c.id candidate_id,c.name,c.stage,o.title opening_title,
             (SELECT given_at FROM credit_consents x WHERE x.candidate_id=c.id ORDER BY x.id DESC LIMIT 1) consent_at,
             (SELECT source FROM credit_consents x WHERE x.candidate_id=c.id ORDER BY x.id DESC LIMIT 1) consent_source,
             k.id check_id,k.status,k.score,k.risk,k.bureau,k.requested_at,k.pan_last4
           FROM candidates c LEFT JOIN job_openings o ON o.id=c.opening_id
           LEFT JOIN credit_checks k ON k.id=(SELECT MAX(id) FROM credit_checks z WHERE z.candidate_id=c.id)
           WHERE c.company_id=? AND (c.stage IN ('interview','offer','hired') OR k.id IS NOT NULL)
           ORDER BY c.updated_at DESC LIMIT 300`,
        )
        .all(companyId);
      const count = (f) => rows.filter(f).length;
      return send(200, {
        summary: {
          low: count((r) => r.risk === "low"),
          medium: count((r) => r.risk === "medium"),
          high: count((r) => r.risk === "high"),
          awaiting_consent: count((r) => !r.consent_at && r.stage !== "hired"),
          not_checked: count((r) => r.consent_at && !r.check_id),
        },
        rows,
      });
    },
  );
  router.get(
    "/api/admin/credit/audit",
    { perm: "credit.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            "SELECT a.id,a.action,a.detail,a.created_at,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id WHERE a.company_id=? AND a.action LIKE 'credit\\_%' ESCAPE '\\' ORDER BY a.id DESC LIMIT 200",
          )
          .all(companyId),
      ),
  );
}
