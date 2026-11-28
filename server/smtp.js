// Sending mail through the company's own mail server (SMTP), with no extra packages.
// Settings (Render → Environment):
//   SMTP_HOST      e.g. smtp.gmail.com, smtp.office365.com, smtp.zoho.in, mail.lifc.in
//   SMTP_PORT      587 (STARTTLS, the usual one) or 465 (TLS from the start); default 587
//   SMTP_USER      the mailbox login, usually the full email address
//   SMTP_PASS      its password or app password
//   MAIL_FROM      the sender, e.g. "Laxmi HRMS <hrms@lifc.in>" (often must be the same mailbox)
//   SMTP_SECURE    optional: "true" forces TLS from the start, "false" forces STARTTLS
//   SMTP_TLS_REJECT_UNAUTHORIZED  optional: "false" accepts a self-signed server certificate
// The password is only ever sent over an encrypted connection.
import net from "node:net";
import tls from "node:tls";
import { randomBytes } from "node:crypto";

export const smtpConfigured = (env = process.env) => Boolean(env.SMTP_HOST && env.MAIL_FROM);
/** Mail can go out by either route: Resend (RESEND_API_KEY) or SMTP. */
export const mailReady = (env = process.env) =>
  Boolean(env.MAIL_FROM && (env.RESEND_API_KEY || env.SMTP_HOST));

const addressOf = (from) => (String(from).match(/<([^>]+)>/)?.[1] ?? String(from)).trim();
const b64 = (s) => Buffer.from(s, "utf8").toString("base64");
const wrap = (s) => s.replace(/.{1,76}/g, "$&\r\n");
// A header value with non-English letters is sent encoded so every mail program reads it.
const header = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const TYPES = { pdf: "application/pdf", ics: "text/calendar", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", csv: "text/csv" };

/** The full message text (headers and body), with attachments as a multipart message. */
export function buildMessage({ from, to, subject, text, attachments = [] }) {
  const host = addressOf(from).split("@")[1] || "localhost";
  const head = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${header(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString("hex")}@${host}>`,
    "MIME-Version: 1.0",
  ];
  const textPart = ["Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64", "", wrap(b64(text || ""))];
  if (!attachments.length) return [...head, ...textPart].join("\r\n");
  const boundary = `hrms-${randomBytes(10).toString("hex")}`;
  const parts = attachments.map((a) => {
    const name = String(a.filename || "file").replace(/["\r\n]/g, "_");
    const type = TYPES[name.split(".").pop().toLowerCase()] || "application/octet-stream";
    return [`Content-Type: ${type}; name="${name}"`, "Content-Transfer-Encoding: base64", `Content-Disposition: attachment; filename="${name}"`, "", wrap(String(a.content).replace(/\s+/g, ""))].join("\r\n");
  });
  return [
    ...head,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    textPart.join("\r\n"),
    ...parts.map((p) => `--${boundary}\r\n${p}`),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

/** Sends one message; resolves when the server accepts it, rejects with the server's reason. */
export async function smtpSend(env, { to, subject, text, attachments }) {
  const port = Number(env.SMTP_PORT) || 587;
  const secure = env.SMTP_SECURE ? env.SMTP_SECURE === "true" : port === 465;
  const host = env.SMTP_HOST;
  const timeout = Number(env.SMTP_TIMEOUT_MS) || 20000;
  // Only for a company mail server with its own (self-signed) certificate.
  const rejectUnauthorized = env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false";
  let socket = secure ? tls.connect({ host, port, servername: host, rejectUnauthorized }) : net.connect({ host, port });
  let buffer = "";
  let waiting = null;
  let failure = null;
  const onData = (chunk) => {
    buffer += chunk.toString("utf8");
    if (!waiting) return; // kept until the next reply is asked for
    // A reply is complete at a line like "250 OK" (code, then a space); "250-..." lines continue it.
    const lines = buffer.split("\r\n");
    for (let i = 0; i < lines.length - 1; i++) {
      if (/^\d{3} /.test(lines[i]) || /^\d{3}$/.test(lines[i])) {
        const reply = lines.slice(0, i + 1).join("\n");
        buffer = lines.slice(i + 1).join("\r\n");
        const w = waiting;
        waiting = null;
        w?.resolve({ code: Number(lines[i].slice(0, 3)), text: reply });
        return;
      }
    }
  };
  const attach = (s) => {
    s.setTimeout(timeout, () => s.destroy(new Error("The mail server did not answer in time.")));
    s.on("data", onData);
    s.on("error", (e) => {
      failure = e;
      waiting?.reject(e);
    });
  };
  attach(socket);
  const next = () =>
    new Promise((resolve, reject) => {
      if (failure) return reject(failure);
      waiting = { resolve, reject };
      onData(Buffer.alloc(0)); // a reply that arrived early
    });
  const expect = async (codes, what) => {
    const r = await next();
    if (!codes.includes(r.code)) throw new Error(`Mail server refused ${what}: ${r.text.split("\n").pop().slice(0, 200)}`);
    return r;
  };
  const say = async (line, codes, what) => {
    socket.write(`${line}\r\n`);
    return expect(codes, what);
  };
  try {
    await expect([220], "the connection");
    const me = addressOf(env.MAIL_FROM).split("@")[1] || "hrms";
    let hello = await say(`EHLO ${me}`, [250], "the greeting");
    if (!secure) {
      if (!/STARTTLS/i.test(hello.text)) throw new Error("The mail server does not offer an encrypted connection on this port. Try SMTP_PORT=465.");
      await say("STARTTLS", [220], "encryption");
      socket.removeListener("data", onData);
      socket = tls.connect({ socket, servername: host, rejectUnauthorized });
      attach(socket);
      await new Promise((resolve, reject) => {
        socket.once("secureConnect", resolve);
        socket.once("error", reject);
      });
      hello = await say(`EHLO ${me}`, [250], "the greeting");
    }
    if (env.SMTP_USER) {
      if (/AUTH[^\n]*PLAIN/i.test(hello.text))
        await say(`AUTH PLAIN ${Buffer.from(`\0${env.SMTP_USER}\0${env.SMTP_PASS ?? ""}`).toString("base64")}`, [235], "the login (check SMTP_USER and SMTP_PASS)");
      else {
        await say("AUTH LOGIN", [334], "the login");
        await say(b64(env.SMTP_USER), [334], "the login");
        await say(b64(env.SMTP_PASS ?? ""), [235], "the login (check SMTP_USER and SMTP_PASS)");
      }
    }
    await say(`MAIL FROM:<${addressOf(env.MAIL_FROM)}>`, [250], "the sender (MAIL_FROM)");
    await say(`RCPT TO:<${addressOf(to)}>`, [250, 251], "the recipient");
    await say("DATA", [354], "the message");
    // A line starting with "." is doubled so it is not read as the end of the message.
    const msg = buildMessage({ from: env.MAIL_FROM, to, subject, text, attachments }).replace(/\r\n\./g, "\r\n..");
    await say(`${msg}\r\n.`, [250], "the message");
    socket.write("QUIT\r\n");
  } finally {
    socket.end();
  }
}
