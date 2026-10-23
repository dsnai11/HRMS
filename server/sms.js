// Text messages for the alerts that matter most on a phone without data. Off until
// a provider is configured:
//   SMS_PROVIDER=twilio   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM
//   SMS_PROVIDER=webhook  SMS_WEBHOOK_URL (+ optional SMS_WEBHOOK_TOKEN): we POST
//                         {"to": "+91…", "message": "…"} as JSON, which a small adapter
//                         or most Indian gateways (MSG91, Gupshup, Kaleyra) accept.
// Indian operators need DLT-registered sender IDs and templates; register the wording
// below with the gateway before switching it on.
export const SMS_KINDS = new Set(["leave", "regularization", "payslip", "claim"]);

export function smsConfigured(env = process.env) {
  if (env.SMS_PROVIDER === "twilio")
    return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM);
  if (env.SMS_PROVIDER === "webhook") return Boolean(env.SMS_WEBHOOK_URL);
  return false;
}

// Indian mobile numbers are stored as typed; send them in +91 form.
export function e164(phone) {
  const digits = String(phone ?? "").replace(/[^\d+]/g, "");
  if (/^\+\d{10,15}$/.test(digits)) return digits;
  const d = digits.replace(/^0+/, "");
  if (/^[6-9]\d{9}$/.test(d)) return `+91${d}`;
  if (/^91[6-9]\d{9}$/.test(d)) return `+${d}`;
  return null;
}

export async function sendSms(app, companyId, phone, text, env = process.env) {
  const to = e164(phone);
  if (!smsConfigured(env) || !to) return false;
  const body = text.slice(0, 300);
  const at = new Date(app.clock()).toISOString();
  const id = Number(
    (
      await app.db
        .prepare("INSERT INTO sms_outbox(company_id,to_phone,body,created_at) VALUES(?,?,?,?)")
        .run(companyId, to, body, at)
    ).lastInsertRowid,
  );
  try {
    let res;
    if (env.SMS_PROVIDER === "twilio")
      res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64")}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }),
        },
      );
    else
      res = await fetch(env.SMS_WEBHOOK_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(env.SMS_WEBHOOK_TOKEN ? { Authorization: `Bearer ${env.SMS_WEBHOOK_TOKEN}` } : {}),
        },
        body: JSON.stringify({ to, message: body }),
      });
    if (!res.ok) throw new Error(`SMS provider answered ${res.status}`);
    await app.db
      .prepare("UPDATE sms_outbox SET status='sent',sent_at=? WHERE id=?")
      .run(new Date(app.clock()).toISOString(), id);
    return true;
  } catch (e) {
    await app.db
      .prepare("UPDATE sms_outbox SET status='failed',error=? WHERE id=?")
      .run(String(e.message).slice(0, 300), id);
    return false;
  }
}
