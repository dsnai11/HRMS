import { createHmac, timingSafeEqual } from "node:crypto";
import { HttpError } from "../http.js";

// Resumes sent to the company's WhatsApp Business number (WhatsApp Cloud API). Meta calls
// the webhook; every call must carry Meta's signature over the exact body. A CV sent as a
// PDF, Word file or photo is downloaded and taken in through RMS like any other source,
// for the job named in the message (a code such as J12) or the source's default job. The
// same message is never taken twice.
//
//   WHATSAPP_TOKEN          permanent access token (System User) with whatsapp_business_messaging
//   WHATSAPP_APP_SECRET     the Meta app's secret (checks the X-Hub-Signature-256 header)
//   WHATSAPP_VERIFY_TOKEN   any long random text, also entered in Meta's webhook settings
//   Webhook URL             <PUBLIC_URL>/api/whatsapp/webhook
// An RMS source of type WhatsApp chooses the company and default job.
const RESUME_TYPES = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "image/jpeg": "jpg",
  "image/png": "png",
};
const MAX_BYTES = 2_900_000;

export function registerWhatsapp(router, app, env = process.env, fetchFn = (...a) => fetch(...a)) {
  const { db, clock } = app;
  const graph = () => (env.WHATSAPP_GRAPH || "https://graph.facebook.com/v21.0").replace(/\/$/, "");
  const auth = () => ({ Authorization: `Bearer ${env.WHATSAPP_TOKEN}` });
  const configured = () => Boolean(env.WHATSAPP_TOKEN && env.WHATSAPP_APP_SECRET && env.WHATSAPP_VERIFY_TOKEN);

  // Meta checks the webhook once with the verify token and expects the challenge back.
  router.get("/api/whatsapp/webhook", { public: true }, async ({ res, query, headers }) => {
    const ok =
      configured() &&
      query.get("hub.mode") === "subscribe" &&
      typeof query.get("hub.verify_token") === "string" &&
      query.get("hub.verify_token").length === env.WHATSAPP_VERIFY_TOKEN.length &&
      timingSafeEqual(Buffer.from(query.get("hub.verify_token")), Buffer.from(env.WHATSAPP_VERIFY_TOKEN));
    res.writeHead(ok ? 200 : 403, { ...headers, "Content-Type": "text/plain; charset=utf-8" });
    res.end(ok ? String(query.get("hub.challenge") ?? "") : "Forbidden");
  });

  const reply = (phoneNumberId, to, text) =>
    fetchFn(`${graph()}/${encodeURIComponent(phoneNumberId)}/messages`, {
      method: "POST",
      headers: { ...auth(), "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to, type: "text", text: { body: text } }),
    }).catch(() => {});

  async function takeMessage(source, value, m) {
    const media = m.document ?? m.image;
    const phoneNumberId = value.metadata?.phone_number_id;
    if (!media) {
      if (m.type === "text")
        await reply(phoneNumberId, m.from, "Thank you for your interest. Please send your CV as a PDF or Word file, and write the job code (for example J12) in the message.");
      return "ignored";
    }
    if (await db.prepare("SELECT 1 FROM candidate_sources WHERE source_id=? AND external_ref=?").get(source.id, `wa:${m.id}`)) return "duplicate";
    const caption = String(media.caption ?? "");
    const code = /\bJ\s?(\d{1,7})\b/i.exec(caption)?.[1];
    const opening = await db
      .prepare("SELECT * FROM job_openings WHERE id=? AND company_id=? AND status<>'closed'")
      .get(Number(code ?? source.default_opening_id ?? 0), source.company_id);
    if (!opening) {
      await reply(phoneNumberId, m.from, "We received your file. Please send it again with the job code (for example J12) written in the message.");
      return "no_job";
    }
    const meta = await (await fetchFn(`${graph()}/${encodeURIComponent(media.id)}`, { headers: auth() })).json();
    const mime = String(meta.mime_type ?? media.mime_type ?? "").split(";")[0].trim();
    if (!RESUME_TYPES[mime]) {
      await reply(phoneNumberId, m.from, "Please send your CV as a PDF, a Word file or a clear photo.");
      return "wrong_type";
    }
    if (Number(meta.file_size) > MAX_BYTES) {
      await reply(phoneNumberId, m.from, "That file is too large. Please send a file under 2.5 MB.");
      return "too_large";
    }
    const file = await fetchFn(meta.url, { headers: auth() });
    const bytes = Buffer.from(await file.arrayBuffer());
    if (!file.ok || bytes.length > MAX_BYTES) return "download_failed";
    const contact = (value.contacts ?? []).find((c) => c.wa_id === m.from);
    const r = await app.rmsIntake(
      source.company_id,
      opening,
      source,
      {
        name: contact?.profile?.name || undefined,
        phone: String(m.from).replace(/\D/g, "").slice(-10),
        external_ref: `wa:${m.id}`,
        resume: { name: media.filename || `whatsapp-${m.id}.${RESUME_TYPES[mime]}`, mime, data: bytes.toString("base64") },
      },
      null,
    );
    await db.prepare("UPDATE intake_sources SET received=received+1,last_used_at=? WHERE id=?").run(new Date(clock()).toISOString(), source.id);
    await reply(phoneNumberId, m.from, `Thank you. Your CV for ${opening.title} (J${opening.id}) has been received.`);
    return r.duplicate ? "duplicate" : "taken";
  }

  router.post("/api/whatsapp/webhook", { public: true }, async ({ req, send }) => {
    if (!configured()) throw new HttpError(404, "Not found.");
    let raw = Buffer.alloc(0);
    for await (const chunk of req) {
      raw = Buffer.concat([raw, chunk]);
      if (raw.length > 1_000_000) throw new HttpError(413, "Request is too large.");
    }
    const sig = String(req.headers["x-hub-signature-256"] ?? "");
    const want = `sha256=${createHmac("sha256", env.WHATSAPP_APP_SECRET).update(raw).digest("hex")}`;
    if (sig.length !== want.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(want)))
      throw new HttpError(401, "Bad signature.");
    let payload;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new HttpError(400, "Invalid JSON.");
    }
    const source = await db
      .prepare("SELECT * FROM intake_sources WHERE kind='whatsapp' AND active=1 ORDER BY id LIMIT 1")
      .get();
    const outcome = [];
    if (source)
      for (const entry of payload.entry ?? [])
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          for (const m of (value.messages ?? []).slice(0, 20)) {
            try {
              outcome.push(await takeMessage(source, value, m));
            } catch (e) {
              outcome.push("failed");
              await db.prepare("UPDATE intake_sources SET last_error=? WHERE id=?").run(String(e.message).slice(0, 300), source.id);
            }
          }
        }
    // Meta retries anything but a 200, so problems are recorded on the source instead.
    return send(200, { ok: true, outcome });
  });
}
