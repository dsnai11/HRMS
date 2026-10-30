import net from "node:net";
import tls from "node:tls";
import { decryptJson, encryptionKey } from "./crypto-store.js";

// Resumes emailed to a mailbox (careers@…): every few minutes each RMS source of type Email
// with a mailbox set reads new messages over IMAP, takes resume attachments (PDF, Word,
// photos) into RMS for the job code in the subject (J12) or the source's default job, and
// marks the messages read. The mailbox password is stored encrypted (DATA_ENCRYPTION_KEY).
// Gmail and Google Workspace need an app password; Microsoft 365 has switched off password
// sign-in for IMAP, so forward that mailbox to one that allows it.
const RESUME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};
const MIMES = new Set(Object.values(RESUME_TYPES));
const MAX_MESSAGE = 12 * 1024 * 1024;
const MAX_FILE = 2_900_000;

// ---- a small IMAP client: enough to log in, find unread mail, fetch it and mark it read ----
export async function imapSession({ host, port, secure = true, user, pass, timeoutMs = 30000 }) {
  const socket = secure ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
  let buf = Buffer.alloc(0);
  let waiting = null;
  let failed = null;
  const timer = setTimeout(() => socket.destroy(new Error("The mailbox did not answer in time.")), timeoutMs);
  socket.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length > MAX_MESSAGE * 2) socket.destroy(new Error("The mailbox sent too much at once."));
    waiting?.();
  });
  socket.on("error", (e) => ((failed = e), waiting?.()));
  socket.on("close", () => ((failed ??= new Error("The mailbox closed the connection.")), waiting?.()));
  const more = () => new Promise((r) => (waiting = r)).finally(() => (waiting = null));
  // Reads one complete line, following IMAP literals ({n}\r\n then n bytes).
  const readLine = async () => {
    const parts = [];
    for (;;) {
      let i = buf.indexOf("\r\n");
      while (i < 0) {
        if (failed) throw failed;
        await more();
        i = buf.indexOf("\r\n");
      }
      const line = buf.subarray(0, i).toString("latin1");
      buf = buf.subarray(i + 2);
      const lit = /\{(\d+)\}$/.exec(line);
      if (!lit) return { text: [...parts.map((p) => p.text), line].join(""), literals: parts.map((p) => p.data) };
      const n = Number(lit[1]);
      if (n > MAX_MESSAGE) throw new Error("A message is too large.");
      while (buf.length < n) {
        if (failed) throw failed;
        await more();
      }
      parts.push({ text: line, data: buf.subarray(0, n) });
      buf = buf.subarray(n);
    }
  };
  let tag = 0;
  const command = async (cmd) => {
    const t = `A${++tag}`;
    socket.write(`${t} ${cmd}\r\n`);
    const lines = [];
    for (;;) {
      const l = await readLine();
      if (l.text.startsWith(`${t} `)) {
        if (!/^A\d+ OK/i.test(l.text)) throw new Error(`The mailbox refused: ${l.text.slice(t.length + 1, 200)}`);
        return lines;
      }
      lines.push(l);
    }
  };
  const quote = (s) => `"${String(s).replace(/[\\"]/g, (c) => `\\${c}`)}"`;
  try {
    const greeting = await readLine();
    if (!/^\* (OK|PREAUTH)/i.test(greeting.text)) throw new Error("This is not an IMAP mailbox.");
    await command(`LOGIN ${quote(user)} ${quote(pass)}`);
    await command("SELECT INBOX");
  } catch (e) {
    clearTimeout(timer);
    socket.destroy();
    throw e;
  }
  return {
    async unseen(limit = 25) {
      const lines = await command("UID SEARCH UNSEEN");
      const found = lines.map((l) => /^\* SEARCH(.*)$/i.exec(l.text)?.[1] ?? "").join(" ");
      return found.split(/\s+/).filter(Boolean).map(Number).slice(0, limit);
    },
    async fetch(uid) {
      const lines = await command(`UID FETCH ${uid} (BODY.PEEK[])`);
      return lines.find((l) => l.literals.length)?.literals[0] ?? null;
    },
    markRead: (uid) => command(`UID STORE ${uid} +FLAGS (\\Seen)`),
    async close() {
      try {
        await command("LOGOUT");
      } catch {
        // already closed
      }
      clearTimeout(timer);
      socket.destroy();
    },
  };
}

// ---- a small MIME reader: headers, multipart parts, base64 and quoted-printable ----
const decodeWords = (s) =>
  String(s ?? "").replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_, cs, enc, text) => {
    const bytes = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : Buffer.from(text.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
    return bytes.toString(/utf-?8/i.test(cs) ? "utf8" : "latin1");
  });
function headersOf(text) {
  const out = {};
  for (const line of text.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}
const param = (header, name) => {
  const star = new RegExp(`${name}\\*=(?:[^']*'[^']*')?([^;]+)`, "i").exec(header ?? "");
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ""));
  const m = new RegExp(`${name}="?([^";]+)"?`, "i").exec(header ?? "");
  return m ? decodeWords(m[1].trim()) : null;
};
function bodyBytes(raw, encoding) {
  const enc = String(encoding ?? "").toLowerCase();
  if (enc === "base64") return Buffer.from(raw.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  if (enc === "quoted-printable")
    return Buffer.from(raw.toString("latin1").replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1");
  return raw;
}
/** { from: { name, email }, subject, messageId, attachments: [{ name, mime, bytes }] } */
export function parseEmail(raw, depth = 0) {
  const buf = Buffer.from(raw);
  let split = buf.indexOf("\r\n\r\n"),
    gap = 4;
  if (split < 0) (split = buf.indexOf("\n\n")), (gap = 2);
  const head = headersOf(buf.subarray(0, split < 0 ? buf.length : split).toString("latin1"));
  const body = split < 0 ? Buffer.alloc(0) : buf.subarray(split + gap);
  const out = { headers: head, attachments: [] };
  const type = head["content-type"] ?? "text/plain";
  if (/^multipart\//i.test(type) && depth < 5) {
    const boundary = param(type, "boundary");
    if (boundary) {
      const marker = Buffer.from(`--${boundary}`);
      let at = body.indexOf(marker);
      while (at >= 0) {
        const start = at + marker.length;
        if (body.subarray(start, start + 2).toString() === "--") break;
        const next = body.indexOf(marker, start);
        const part = body.subarray(start, next < 0 ? body.length : next).toString("latin1").replace(/^\r?\n/, "").replace(/\r?\n$/, "");
        out.attachments.push(...parseEmail(Buffer.from(part, "latin1"), depth + 1).attachments);
        at = next;
      }
    }
  } else {
    const disposition = head["content-disposition"] ?? "";
    const name = param(disposition, "filename") ?? param(type, "name");
    if (name) {
      const ext = name.toLowerCase().split(".").pop();
      let mime = type.split(";")[0].trim().toLowerCase();
      if (!MIMES.has(mime) && RESUME_TYPES[ext]) mime = RESUME_TYPES[ext];
      out.attachments.push({ name: name.replace(/[\\/\r\n"]/g, "_").slice(0, 120), mime, bytes: bodyBytes(body, head["content-transfer-encoding"]) });
    }
  }
  if (depth === 0) {
    const from = decodeWords(head.from ?? "");
    const email = (/<([^>]+)>/.exec(from)?.[1] ?? /[^\s<>"]+@[^\s<>"]+/.exec(from)?.[0] ?? "").trim().toLowerCase();
    const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim();
    out.from = { email: email || null, name: name && !name.includes("@") ? name.slice(0, 100) : null };
    out.subject = decodeWords(head.subject ?? "");
    out.messageId = (head["message-id"] ?? "").replace(/[<>]/g, "").slice(0, 200) || null;
  }
  return out;
}

/** Reads one source's mailbox once; returns what happened. */
export async function readMailbox(app, source, connect = imapSession) {
  const { db } = app;
  const key = encryptionKey();
  if (!key) throw new Error("Reading a mailbox needs DATA_ENCRYPTION_KEY on the server.");
  const cfg = decryptJson(JSON.parse(source.settings || "{}").mailbox, key);
  const session = await connect({ host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass });
  const result = { messages: 0, taken: 0, skipped: 0 };
  try {
    for (const uid of await session.unseen()) {
      result.messages++;
      const raw = await session.fetch(uid);
      if (raw) {
        const mail = parseEmail(raw);
        const code = /\bJ\s?(\d{1,7})\b/i.exec(mail.subject)?.[1];
        const opening = await db
          .prepare("SELECT * FROM job_openings WHERE id=? AND company_id=? AND status<>'closed'")
          .get(Number(code ?? source.default_opening_id ?? 0), source.company_id);
        const files = mail.attachments.filter((a) => MIMES.has(a.mime) && a.bytes.length > 0 && a.bytes.length <= MAX_FILE);
        if (!opening || !files.length) result.skipped++;
        for (const [i, f] of files.entries()) {
          if (!opening) break;
          const ref = `mail:${mail.messageId ?? `${source.id}-${uid}`}:${i}`;
          if (await db.prepare("SELECT 1 FROM candidate_sources WHERE source_id=? AND external_ref=?").get(source.id, ref)) continue;
          try {
            await app.rmsIntake(
              source.company_id,
              opening,
              source,
              {
                // The sender's name only when they sent their own CV (one file).
                ...(files.length === 1 && mail.from.name ? { name: mail.from.name } : {}),
                ...(files.length === 1 && mail.from.email ? { email: mail.from.email } : {}),
                external_ref: ref,
                resume: { name: f.name, mime: f.mime, data: f.bytes.toString("base64") },
              },
              null,
            );
            result.taken++;
          } catch (e) {
            if (!e.status) throw e;
            result.skipped++;
          }
        }
      }
      await session.markRead(uid);
    }
  } finally {
    await session.close();
  }
  await db
    .prepare("UPDATE intake_sources SET received=received+?,last_used_at=?,last_error=NULL WHERE id=?")
    .run(result.taken, new Date(app.clock()).toISOString(), source.id);
  return result;
}

export function scheduleMailboxes(app, everyMs = 5 * 60000) {
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const sources = await app.db
        .prepare("SELECT * FROM intake_sources WHERE kind='email' AND active=1 AND settings LIKE '%mailbox%'")
        .all();
      for (const s of sources)
        await readMailbox(app, s).catch((e) =>
          app.db.prepare("UPDATE intake_sources SET last_error=? WHERE id=?").run(String(e.message).slice(0, 300), s.id),
        );
    } catch (e) {
      console.error("Mailbox reading failed:", e.message);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, everyMs);
  timer.unref();
  void run();
}
