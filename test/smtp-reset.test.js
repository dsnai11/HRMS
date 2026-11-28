import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import tls from "node:tls";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { buildMessage } from "../server/smtp.js";

// A self-signed certificate for the pretend mail server (needs openssl, as on macOS and Render).
function cert() {
  const dir = mkdtempSync(join(tmpdir(), "smtp-"));
  const r = spawnSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=localhost", "-days", "1", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem")], { stdio: "ignore" });
  if (r.status !== 0) return null;
  return { key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) };
}

// A pretend SMTP server: insists on STARTTLS before login, checks the login, keeps each message.
function fakeSmtp(keys, { user, pass }) {
  const inbox = [];
  const server = net.createServer((raw) => {
    let sock = raw;
    let buf = "";
    let inData = false;
    let msg = "";
    let secure = false;
    let authed = false;
    const reply = (s) => sock.write(`${s}\r\n`);
    const onLine = (line) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          inbox.push(msg);
          msg = "";
          return reply("250 queued");
        }
        msg += `${line.startsWith("..") ? line.slice(1) : line}\r\n`;
        return;
      }
      const cmd = line.toUpperCase();
      if (cmd.startsWith("EHLO")) return reply(secure ? "250-fake\r\n250 AUTH PLAIN LOGIN" : "250-fake\r\n250 STARTTLS");
      if (cmd === "STARTTLS") {
        reply("220 go ahead");
        raw.removeAllListeners("data");
        sock = new tls.TLSSocket(raw, { isServer: true, ...keys });
        sock.on("data", feed);
        secure = true;
        return;
      }
      if (cmd.startsWith("AUTH PLAIN")) {
        if (!secure) return reply("530 encryption first");
        const [, u, p] = Buffer.from(line.slice(11), "base64").toString().split("\0");
        authed = u === user && p === pass;
        return reply(authed ? "235 ok" : "535 bad login");
      }
      if (cmd.startsWith("MAIL FROM")) return reply(authed ? "250 ok" : "530 login first");
      if (cmd.startsWith("RCPT TO")) return reply("250 ok");
      if (cmd === "DATA") {
        inData = true;
        return reply("354 send it");
      }
      if (cmd === "QUIT") return reply("221 bye");
      reply("500 what");
    };
    const feed = (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        onLine(line);
      }
    };
    raw.on("data", feed);
    raw.on("error", () => {});
    reply("220 fake smtp ready");
  });
  return { server, inbox };
}

test("mail message: subject encoding, attachments and dot lines", () => {
  const m = buildMessage({ from: "HRMS <hrms@lifc.in>", to: "a@b.in", subject: "वेतन slip", text: "Hello", attachments: [{ filename: "Offer-letter.pdf", content: "JVBERi0=" }] });
  assert.match(m, /Subject: =\?UTF-8\?B\?/);
  assert.match(m, /multipart\/mixed/);
  assert.match(m, /Content-Type: application\/pdf; name="Offer-letter.pdf"/);
  assert.match(m, /Message-ID: <[0-9a-f]+@lifc\.in>/);
});

test("forgot password by email through the company's SMTP server: link, new password, sign in", async (t) => {
  const keys = cert();
  if (!keys) return t.skip("openssl is not available");
  const { server: smtp, inbox } = fakeSmtp(keys, { user: "hrms@lifc.test", pass: "app-pass-123" });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    SMTP_HOST: "127.0.0.1",
    SMTP_PORT: String(smtp.address().port),
    SMTP_USER: "hrms@lifc.test",
    SMTP_PASS: "app-pass-123",
    SMTP_TLS_REJECT_UNAUTHORIZED: "false",
    MAIL_FROM: "Laxmi HRMS <hrms@lifc.test>",
    APP_URL: "https://hrms.example.test",
  });
  delete process.env.RESEND_API_KEY;
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    process.env = saved;
    await new Promise((r) => server.close(r));
    server.closeAllConnections();
    smtp.close();
    await db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body) => {
    const res = await fetch(base + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() };
  };
  const asked = await call("/forgot-password", { email: "admin@example.test" });
  assert.equal(asked.status, 200);
  for (let i = 0; i < 50 && !inbox.length; i++) await new Promise((r) => setTimeout(r, 100));
  assert.equal(inbox.length, 1, "one email reached the mail server");
  const body = Buffer.from(inbox[0].split("\r\n\r\n")[1].replace(/\r\n/g, ""), "base64").toString();
  assert.match(inbox[0], /Subject: Reset your HRMS password/);
  const token = body.match(/\?reset=([0-9a-f]{64})/)?.[1];
  assert.ok(token, body);
  const row = await db.prepare("SELECT status FROM email_outbox ORDER BY id DESC").get();
  assert.equal(row.status, "sent");

  // An unknown address gets the same answer and no email.
  assert.equal((await call("/forgot-password", { email: "nobody@example.test" })).status, 200);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(inbox.length, 1);

  assert.equal((await call("/reset-password", { token, password: "New-password-456" })).status, 200);
  assert.equal((await call("/reset-password", { token, password: "Other-password-789" })).status, 400, "the link works once");
  assert.equal((await call("/login", { email: "admin@example.test", password: "New-password-456", native: true })).status, 200);
  assert.equal((await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).status, 401);
  void app;
});

test("SMTP: a wrong password is reported as a failed email, not a crash", async (t) => {
  const keys = cert();
  if (!keys) return t.skip("openssl is not available");
  const { server: smtp } = fakeSmtp(keys, { user: "u", pass: "right" });
  await new Promise((r) => smtp.listen(0, "127.0.0.1", r));
  t.after(() => smtp.close());
  const { smtpSend } = await import("../server/smtp.js");
  await assert.rejects(
    smtpSend({ SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtp.address().port), SMTP_USER: "u", SMTP_PASS: "wrong", MAIL_FROM: "a@b.test", SMTP_TLS_REJECT_UNAUTHORIZED: "false" }, { to: "x@y.test", subject: "s", text: "t" }),
    /check SMTP_USER and SMTP_PASS/,
  );
});
