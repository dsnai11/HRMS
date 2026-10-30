import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { parseEmail } from "../server/mailbox.js";

const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\nPriya Sharma resume");
const email = ({ subject, from, attach = true }) =>
  [
    `From: ${from}`,
    `Subject: ${subject}`,
    `Message-ID: <${randomBytes(6).toString("hex")}@mail.example>`,
    "MIME-Version: 1.0",
    'Content-Type: multipart/mixed; boundary="b1"',
    "",
    "--b1",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Please find my CV attached. Regards=2C Priya",
    ...(attach
      ? ["--b1", 'Content-Type: application/pdf; name="Priya_CV.pdf"', "Content-Disposition: attachment; filename*=UTF-8''Priya%20CV.pdf", "Content-Transfer-Encoding: base64", "", ...pdf.toString("base64").match(/.{1,40}/g)]
      : []),
    "--b1--",
    "",
  ].join("\r\n");

test("reading email: sender, subject (encoded words), attachments in base64 with RFC 2231 names", () => {
  const m = parseEmail(Buffer.from(email({ subject: "=?UTF-8?B?QXBwbGljYXRpb24gZm9yIEoxMg==?=", from: '"Priya Sharma" <Priya@Mail.Example>' })));
  assert.equal(m.subject, "Application for J12");
  assert.deepEqual(m.from, { email: "priya@mail.example", name: "Priya Sharma" });
  assert.equal(m.attachments.length, 1);
  assert.deepEqual([m.attachments[0].name, m.attachments[0].mime], ["Priya CV.pdf", "application/pdf"]);
  assert.ok(m.attachments[0].bytes.equals(pdf));
});

test("an Email source reads its mailbox over IMAP, takes resumes for the job in the subject, and marks mail read", async (t) => {
  const original = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  // A stand-in IMAP server with two unread messages.
  const mails = new Map();
  const seen = new Set();
  const imap = net.createServer((sock) => {
    sock.write("* OK IMAP ready\r\n");
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      let i;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const [tag, ...rest] = line.split(" ");
        const cmd = rest.join(" ");
        if (/^LOGIN/i.test(cmd)) sock.write(cmd === 'LOGIN "careers@example.test" "app-pass-1"' ? `${tag} OK logged in\r\n` : `${tag} NO bad login\r\n`);
        else if (/^SELECT/i.test(cmd)) sock.write(`* ${mails.size} EXISTS\r\n${tag} OK [READ-WRITE] selected\r\n`);
        else if (/^UID SEARCH UNSEEN/i.test(cmd)) sock.write(`* SEARCH ${[...mails.keys()].filter((u) => !seen.has(u)).join(" ")}\r\n${tag} OK done\r\n`);
        else if (/^UID FETCH/i.test(cmd)) {
          const uid = Number(cmd.split(" ")[2]);
          const raw = Buffer.from(mails.get(uid), "latin1");
          sock.write(`* 1 FETCH (UID ${uid} BODY[] {${raw.length}}\r\n`);
          sock.write(raw);
          sock.write(`)\r\n${tag} OK fetched\r\n`);
        } else if (/^UID STORE/i.test(cmd)) {
          seen.add(Number(cmd.split(" ")[2]));
          sock.write(`${tag} OK stored\r\n`);
        } else if (/^LOGOUT/i.test(cmd)) {
          sock.write(`* BYE\r\n${tag} OK bye\r\n`);
          sock.end();
        } else sock.write(`${tag} BAD unknown\r\n`);
      }
    });
  });
  await new Promise((r) => imap.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    original === undefined ? delete process.env.DATA_ENCRYPTION_KEY : (process.env.DATA_ENCRYPTION_KEY = original);
    imap.close();
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const job = (await call("/admin/openings", { title: "Sales Officer", positions: 2 }, owner)).data.id;
  mails.set(7, email({ subject: `Application for J${job}`, from: '"Priya Sharma" <priya@mail.example>' }));
  mails.set(8, email({ subject: "Hello", from: "someone@mail.example", attach: false }));
  const src = (await call("/admin/rms/sources", { kind: "email", name: "Careers mailbox" }, owner)).data;
  const naukri = (await call("/admin/rms/sources", { kind: "naukri" }, owner)).data;
  const box = { host: "127.0.0.1", port: imap.address().port, secure: false, user: "careers@example.test" };
  assert.equal((await call(`/admin/rms/sources/${naukri.id}/mailbox`, { ...box, password: "x" }, owner, "PUT")).status, 409, "only Email sources");
  assert.equal((await call(`/admin/rms/sources/${src.id}/mailbox/check`, {}, owner)).status, 409, "set it first");
  assert.equal((await call(`/admin/rms/sources/${src.id}/mailbox`, { ...box, password: "wrong" }, owner, "PUT")).status, 200);
  const bad = await call(`/admin/rms/sources/${src.id}/mailbox/check`, {}, owner);
  assert.equal(bad.status, 502);
  assert.match(bad.data.error, /refused/);
  assert.equal((await call(`/admin/rms/sources/${src.id}/mailbox`, { ...box, password: "app-pass-1" }, owner, "PUT")).status, 200);
  // The password is stored encrypted and never shown.
  const stored = (await db.prepare("SELECT settings FROM intake_sources WHERE id=?").get(src.id)).settings;
  assert.ok(!stored.includes("app-pass-1"));
  const listed = (await call("/admin/rms/sources", undefined, owner)).data.items.find((s) => s.id === src.id);
  assert.deepEqual(listed.mailbox, { host: "127.0.0.1", user: "careers@example.test" });
  assert.equal(JSON.stringify(listed).includes("app-pass"), false);

  const run = await call(`/admin/rms/sources/${src.id}/mailbox/check`, {}, owner);
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.deepEqual(run.data, { messages: 2, taken: 1, skipped: 1 });
  const c = await db.prepare("SELECT name,email,opening_id,source FROM candidates").get();
  assert.deepEqual([c.name, c.email, c.opening_id, c.source], ["Priya Sharma", "priya@mail.example", job, "Careers mailbox"]);
  assert.deepEqual([...seen].sort(), [7, 8], "both marked read");
  // Nothing new next time.
  assert.deepEqual((await call(`/admin/rms/sources/${src.id}/mailbox/check`, {}, owner)).data, { messages: 0, taken: 0, skipped: 0 });
});
