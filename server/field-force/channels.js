// Field Force, Phase 2: escalation beyond the phone app.
//
// WhatsApp: the morning message and the reminder also go as WhatsApp templates when the
// company switches it on. The reminder template carries four quick-reply buttons; a tap
// comes back through the WhatsApp webhook and is saved as the person's reason.
//   Needs WHATSAPP_TOKEN (and, for replies, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN,
//   as for RMS) plus FF_WHATSAPP_PHONE_ID: the WhatsApp Business number that sends them.
//   The two templates must be approved by Meta first (see the portal's setup card).
//
// Calls: at the IVR time, anyone still not punched in and without a reason is called by
// the company's calling provider, which asks them to press a key; at the AI time, anyone
// still without a reason gets an AI voice call. The HRMS does not dial: it asks the provider
// to, and the provider reports back what was pressed or said.
//   FF_CALL_URL    where we POST each call request (JSON, below)
//   FF_CALL_TOKEN  a shared secret: sent as "Authorization: Bearer …" both ways
//   APP_URL        this portal's address, for the provider's callback
// Request:  { id, kind: "ivr"|"ai", to: "+91…", name, language, company, script,
//             options: [{ key: "1", reason: "on_the_way", label }, …], callback_url }
// Callback: POST /api/field-force/calls/callback { id, status: "answered"|"no_answer"|"failed",
//             key?: "1".."4", reason?: "on_the_way"|… }
import { timingSafeEqual } from "node:crypto";
import { HttpError } from "../http.js";
import { e164 } from "../sms.js";
import { REASONS, clockOf, dayStatus, localTime, pending, recordReason } from "./activation.js";

const KEYS = Object.keys(REASONS); // key 1 = on_the_way, 2 = on_leave, 3 = app_issue, 4 = call_me
const graph = (env) => (env.WHATSAPP_GRAPH || "https://graph.facebook.com/v21.0").replace(/\/$/, "");
export const whatsappReady = (env = process.env) => Boolean(env.WHATSAPP_TOKEN && env.FF_WHATSAPP_PHONE_ID);
export const callsReady = (env = process.env) => Boolean(env.FF_CALL_URL && env.FF_CALL_TOKEN);
const digits = (phone) => e164(phone)?.slice(1) ?? null;

async function logContact(db, row) {
  const r = await db
    .prepare(
      `INSERT INTO ff_contacts(company_id,user_id,day,channel,step,status,external_id,detail,created_at) VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT DO NOTHING RETURNING id`,
    )
    .get(row.companyId, row.userId, row.day, row.channel, row.step, row.status, row.externalId ?? null, row.detail ?? null, row.at);
  return r?.id ?? null;
}

// ---- WhatsApp out ----------------------------------------------------------------------------------
export async function sendWhatsapp(app, { companyId, day, step, people }, env = process.env) {
  const times = await clockOf(app.db, companyId);
  if (!times.whatsapp || !whatsappReady(env) || !people.length) return;
  const at = new Date(app.clock()).toISOString();
  const template = step === "nudge" ? times.wa_nudge_template : times.wa_remind_template;
  for (const p of people) {
    const to = digits(p.phone);
    const base = { companyId, userId: p.id, day, channel: "whatsapp", step, at };
    if (!to) {
      await logContact(app.db, { ...base, status: "skipped", detail: "No valid mobile number" });
      continue;
    }
    const components = [{ type: "body", parameters: [{ type: "text", text: p.name.split(" ")[0] }] }];
    if (step === "remind")
      KEYS.forEach((reason, i) =>
        components.push({ type: "button", sub_type: "quick_reply", index: String(i), parameters: [{ type: "payload", payload: `ff:${reason}` }] }),
      );
    try {
      const res = await fetch(`${graph(env)}/${encodeURIComponent(env.FF_WHATSAPP_PHONE_ID)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to, type: "template", template: { name: template, language: { code: times.wa_language }, components } }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error?.message || `WhatsApp answered ${res.status}`);
      await logContact(app.db, { ...base, status: "sent", externalId: data.messages?.[0]?.id ?? null });
    } catch (e) {
      await logContact(app.db, { ...base, status: "failed", detail: String(e.message).slice(0, 300) });
    }
  }
}

// ---- WhatsApp in: a reason button tapped. Answers true when the message was Field Force's. ----
export function whatsappHandler(app, env = process.env) {
  return async function takeFieldForceReply(value, m) {
    const payload = m.button?.payload ?? m.interactive?.button_reply?.id ?? "";
    if (!payload.startsWith("ff:")) return false;
    const reason = payload.slice(3);
    const at = new Date(app.clock()).toISOString();
    const day = app.dayOf(at);
    // The sender must be field staff with that number; anyone else's tap is ignored.
    const staff = await app.db
      .prepare("SELECT u.id,u.company_id,u.phone FROM ff_staff f JOIN users u ON u.id=f.user_id WHERE u.active=1 AND u.phone IS NOT NULL AND u.phone<>''")
      .all();
    const person = staff.find((u) => digits(u.phone) === m.from);
    const reply = (text) =>
      fetch(`${graph(env)}/${encodeURIComponent(value.metadata?.phone_number_id ?? env.FF_WHATSAPP_PHONE_ID)}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ messaging_product: "whatsapp", to: m.from, type: "text", text: { body: text } }),
      }).catch(() => {});
    if (!person || !REASONS[reason]) return true;
    const { people } = await dayStatus(app, person.company_id, day, { only: [person.id] });
    const p = people[0];
    if (!p || !pending(p)) {
      await reply(p && ["on_time", "late"].includes(p.status) ? "You have already punched in today. Thank you." : "Nothing is needed from you today. Thank you.");
      return true;
    }
    await recordReason(app.db, { companyId: person.company_id, userId: person.id, day, reason, via: "whatsapp", at });
    await logContact(app.db, { companyId: person.company_id, userId: person.id, day, channel: "whatsapp", step: "remind", status: "answered", externalId: m.id, detail: reason, at });
    await app.notify([person.id], { companyId: person.company_id, kind: "activation", title: `Reason noted: ${REASONS[reason]}`, inApp: true });
    await reply(`Thank you. Your manager can see: ${REASONS[reason]}.${reason === "on_the_way" ? " Please punch in when you start." : ""}`);
    return true;
  };
}

// ---- calls out ---------------------------------------------------------------------------------------
const SCRIPT = {
  ivr: (name, company) =>
    `Hello ${name}, this is ${company}. You have not punched in today. Press 1 if you are on the way to a customer or market, 2 if you are on leave, 3 for an app or network problem, or 4 to ask your manager to call you.`,
  ai: (name, company) =>
    `You are calling ${name}, a field employee of ${company}, who has not punched in today and has not answered our messages. Politely ask why, and record one of: on the way to a customer or market, on leave, an app or network problem, or wants a call back from their manager. Keep it under a minute.`,
};
export async function runCalls(app, env = process.env) {
  if (!callsReady(env)) return;
  const { db, timezone } = app;
  const now = app.clock();
  const at = new Date(now).toISOString();
  const day = app.dayOf(at);
  const hhmm = localTime(now, timezone);
  const companies = await db
    .prepare("SELECT c.id FROM ff_settings s JOIN companies c ON c.id=s.company_id WHERE c.active=1 AND s.active=1 AND (s.ivr_at IS NOT NULL OR s.ai_at IS NOT NULL)")
    .all();
  const callback = `${(env.APP_URL || env.PUBLIC_URL || "").replace(/\/$/, "")}/api/field-force/calls/callback`;
  for (const { id: companyId } of companies) {
    const times = await clockOf(db, companyId);
    if (hhmm >= times.report) continue;
    // The later call wins once its time has come, so a late start does not ring twice.
    const kind = times.ai && hhmm >= times.ai ? "ai" : times.ivr && hhmm >= times.ivr ? "ivr" : null;
    if (!kind) continue;
    const { people } = await dayStatus(app, companyId, day);
    for (const p of people.filter((x) => pending(x) && !x.reason)) {
      const base = { companyId, userId: p.id, day, channel: kind, step: kind, at };
      const to = e164(p.phone);
      if (!to) {
        await logContact(db, { ...base, status: "skipped", detail: "No valid mobile number" });
        continue;
      }
      // One call of each kind per person per day (a unique index); taken before dialling.
      const id = await logContact(db, { ...base, status: "sent" });
      if (!id) continue;
      try {
        const res = await fetch(env.FF_CALL_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${env.FF_CALL_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            id: `ff-${id}`,
            kind,
            to,
            name: p.name,
            language: times.wa_language,
            company: app.company,
            script: SCRIPT[kind](p.name.split(" ")[0], app.company),
            options: KEYS.map((reason, i) => ({ key: String(i + 1), reason, label: REASONS[reason] })),
            callback_url: callback,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Calling provider answered ${res.status}`);
        if (data.call_id) await db.prepare("UPDATE ff_contacts SET external_id=? WHERE id=?").run(String(data.call_id).slice(0, 100), id);
      } catch (e) {
        await db
          .prepare("UPDATE ff_contacts SET status='failed',detail=?,updated_at=? WHERE id=?")
          .run(String(e.message).slice(0, 300), at, id);
      }
    }
  }
}

export function registerChannels(router, app, env = process.env) {
  const { db } = app;
  // Which outside services are set up, for the portal's setup card.
  router.get("/api/field-force/channels", { perm: "attendance.read" }, async ({ send }) =>
    send(200, {
      whatsapp_ready: whatsappReady(env),
      calls_ready: callsReady(env),
      push_ready: Boolean(env.FCM_SERVICE_ACCOUNT),
      email_ready: Boolean(env.RESEND_API_KEY && env.MAIL_FROM),
    }),
  );
  // The calling provider reports the outcome of a call.
  router.post("/api/field-force/calls/callback", { public: true }, async ({ req, body, send }) => {
    app.rateLimit(`ff-call:${req.socket.remoteAddress}`, 600);
    const given = String(req.headers.authorization ?? "");
    const want = `Bearer ${env.FF_CALL_TOKEN ?? ""}`;
    if (!callsReady(env) || given.length !== want.length || !timingSafeEqual(Buffer.from(given), Buffer.from(want)))
      throw new HttpError(401, "Not allowed.");
    const b = await body();
    const id = /^ff-(\d{1,12})$/.exec(String(b.id ?? ""))?.[1];
    const contact = id && (await db.prepare("SELECT * FROM ff_contacts WHERE id=? AND channel IN ('ivr','ai')").get(Number(id)));
    if (!contact) throw new HttpError(404, "Unknown call.");
    if (!["answered", "no_answer", "failed"].includes(b.status)) throw new HttpError(400, "Status must be answered, no_answer or failed.");
    const reason = REASONS[b.reason] ? b.reason : /^[1-4]$/.test(String(b.key ?? "")) ? KEYS[Number(b.key) - 1] : null;
    const at = new Date(app.clock()).toISOString();
    await db
      .prepare("UPDATE ff_contacts SET status=?,reason=?,updated_at=? WHERE id=?")
      .run(b.status, reason, at, contact.id);
    if (reason && b.status === "answered") {
      // Only if they still have not started that day; a punch-in always wins.
      const { people } = await dayStatus(app, contact.company_id, contact.day, { only: [contact.user_id] });
      if (people[0] && pending(people[0]))
        await recordReason(db, { companyId: contact.company_id, userId: contact.user_id, day: contact.day, reason, via: contact.channel, at });
      if (reason === "call_me") {
        const u = await db.prepare("SELECT name,phone,manager_id FROM users WHERE id=?").get(contact.user_id);
        if (u.manager_id)
          await app.notify([u.manager_id], {
            companyId: contact.company_id,
            kind: "activation",
            title: `${u.name} has not started and asked to be called`,
            body: u.phone ? `Phone: ${u.phone}` : null,
            link: "fieldforce",
          });
      }
    }
    return send(200, { ok: true });
  });
  app.whatsappHandlers.push(whatsappHandler(app, env));
}
