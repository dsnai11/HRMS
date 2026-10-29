import { crc32, deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// Reads the text of a resume (PDF, Word .docx or old .doc, or a photo or scan through OCR)
// and picks out what a recruiter types by hand: name, email, phone, years of experience
// and skills. OCR is slower, so photos and scanned PDFs are read in the background.

const MAX_TEXT = 20000;

async function pdfText(bytes) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjs.getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  });
  try {
    const doc = await task.promise;
    const lines = [];
    for (let n = 1; n <= Math.min(doc.numPages, 6); n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let line = "";
      for (const item of content.items) {
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        } else if (item.str && !item.str.endsWith(" ")) line += " ";
      }
      if (line) lines.push(line);
      if (lines.join("\n").length > MAX_TEXT) break;
    }
    return lines.join("\n");
  } finally {
    await task.destroy();
  }
}

// The one file we need from a .docx zip: word/document.xml.
function unzipEntry(bytes, wanted) {
  const buf = Buffer.from(bytes);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--)
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) return null;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count && p + 46 <= buf.length; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) return null;
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    if (name === wanted) {
      const start =
        local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: 8 * 1024 * 1024 });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

function docxText(bytes) {
  const xml = unzipEntry(bytes, "word/document.xml")?.toString("utf8");
  if (!xml) return "";
  return xml
    .replace(/<w:tab\/>/g, " ")
    .replace(/<\/w:p>|<w:br\/>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

// ---- old Word (.doc): an OLE compound file holding the WordDocument and table streams ----
function cfbStreams(buf) {
  if (buf.length < 512 || buf.readUInt32LE(0) !== 0xe011cfd0 || buf.readUInt32LE(4) !== 0xe11ab1a1)
    return null;
  const ss = 2 ** buf.readUInt16LE(0x1e),
    mss = 2 ** buf.readUInt16LE(0x20);
  if (ss !== 512 && ss !== 4096) return null;
  const at = (n) => (n + 1) * ss;
  const END = 0xfffffffa;
  // The FAT's own sectors: 109 listed in the header, more in a DIFAT chain.
  const fatSectors = [];
  for (let i = 0; i < 109; i++) {
    const n = buf.readUInt32LE(0x4c + i * 4);
    if (n < END) fatSectors.push(n);
  }
  let difat = buf.readUInt32LE(0x44);
  for (let guard = 0; difat < END && guard < 1000; guard++) {
    if (at(difat) + ss > buf.length) break;
    for (let i = 0; i < ss / 4 - 1; i++) {
      const n = buf.readUInt32LE(at(difat) + i * 4);
      if (n < END) fatSectors.push(n);
    }
    difat = buf.readUInt32LE(at(difat) + ss - 4);
  }
  const fat = [];
  for (const s of fatSectors)
    for (let i = 0; i < ss / 4 && at(s) + i * 4 + 4 <= buf.length; i++)
      fat.push(buf.readUInt32LE(at(s) + i * 4));
  const chain = (start, table, read) => {
    const parts = [];
    for (let n = start, guard = 0; n < END && guard < 100000; n = table[n] ?? END, guard++)
      parts.push(read(n));
    return Buffer.concat(parts);
  };
  const big = (start) => chain(start, fat, (n) => buf.subarray(at(n), at(n) + ss));
  const dir = big(buf.readUInt32LE(0x30));
  const entries = [];
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const len = dir.readUInt16LE(o + 64);
    entries.push({
      name: dir.toString("utf16le", o, o + Math.max(0, len - 2)),
      type: dir[o + 66],
      start: dir.readUInt32LE(o + 116),
      size: dir.readUInt32LE(o + 120),
    });
  }
  const root = entries.find((e) => e.type === 5);
  const cutoff = buf.readUInt32LE(0x38);
  let mini = null,
    miniFat = null;
  return (name) => {
    const e = entries.find((x) => x.type === 2 && x.name === name);
    if (!e) return null;
    if (e.size >= cutoff) return big(e.start).subarray(0, e.size);
    // Small streams live in the mini stream, in 64-byte sectors.
    if (!mini) {
      mini = big(root.start);
      const mf = big(buf.readUInt32LE(0x3c));
      miniFat = [];
      for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i));
    }
    return chain(e.start, miniFat, (n) => mini.subarray(n * mss, (n + 1) * mss)).subarray(0, e.size);
  };
}

// Word 97-2003: the piece table (in the table stream) says where each run of text is.
function docText(bytes) {
  const stream = cfbStreams(Buffer.from(bytes));
  const wd = stream?.("WordDocument");
  if (!wd || wd.length < 0x1aa || wd.readUInt16LE(0) !== 0xa5ec) return "";
  const flags = wd.readUInt16LE(0x0a);
  if (flags & 0x0100) return ""; // password-protected
  const table = stream(flags & 0x0200 ? "1Table" : "0Table");
  if (!table) return "";
  let i = wd.readUInt32LE(0x1a2);
  const end = i + wd.readUInt32LE(0x1a6);
  while (i < end && table[i] === 0x01) i += 3 + table.readUInt16LE(i + 1);
  if (table[i] !== 0x02) return "";
  const lcb = table.readUInt32LE(i + 1),
    plc = i + 5;
  const n = (lcb - 4) / 12;
  if (!Number.isInteger(n) || n < 1 || plc + lcb > table.length) return "";
  let text = "";
  for (let k = 0; k < n && text.length < MAX_TEXT * 2; k++) {
    const chars = table.readUInt32LE(plc + 4 * (k + 1)) - table.readUInt32LE(plc + 4 * k);
    const fc = table.readUInt32LE(plc + 4 * (n + 1) + 8 * k + 2);
    if (chars <= 0) continue;
    if (fc & 0x40000000) {
      const off = (fc & 0x3fffffff) / 2;
      text += wd.toString("latin1", off, Math.min(wd.length, off + chars));
    } else text += wd.toString("utf16le", fc, Math.min(wd.length, fc + 2 * chars));
  }
  return text
    .replace(/\x13[^\x13\x14\x15]*\x14/g, "") // a field's code, e.g. HYPERLINK "mailto:…"
    .replace(/\x13[^\x13\x15]*\x15/g, "")
    .replace(/[\r\x0b\x0c]/g, "\n")
    .replace(/\x07/g, " ")
    .replace(/[\x00-\x08\x0e-\x1f]/g, "");
}

// ---- scanned PDFs: the page images, for OCR ----
function png(width, height, channels, raw) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = channels === 3 ? 2 : 0;
  const row = width * channels;
  const rows = Buffer.alloc((row + 1) * height);
  for (let y = 0; y < height; y++) raw.copy(rows, y * (row + 1) + 1, y * row, (y + 1) * row);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(rows)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// JPEG images as they are; 8-bit grey or colour images (Flate) turned into PNGs.
// Others (black-and-white fax and JBIG2 scans) are skipped.
export function pdfImages(bytes, max = 3) {
  const buf = Buffer.from(bytes);
  const s = buf.toString("latin1");
  const out = [];
  for (const m of s.matchAll(/\/Subtype\s*\/Image/g)) {
    if (out.length >= max) break;
    const from = s.lastIndexOf(" obj", m.index);
    const streamAt = s.indexOf("stream", m.index);
    if (from < 0 || streamAt < 0) continue;
    const dict = s.slice(from, streamAt);
    const num = (k) => Number(dict.match(new RegExp(`/${k}\\s+(\\d+)(?!\\s+\\d+\\s+R)`))?.[1]);
    const width = num("Width"),
      height = num("Height");
    if (!(width * height >= 150 * 150)) continue; // logos and lines
    let start = streamAt + 6;
    if (s[start] === "\r") start++;
    if (s[start] === "\n") start++;
    const length = num("Length");
    const stop = Number.isFinite(length) ? start + length : s.indexOf("endstream", start);
    if (stop <= start) continue;
    const data = buf.subarray(start, stop);
    try {
      if (/\/DCTDecode/.test(dict)) out.push(data);
      else if (/\/FlateDecode/.test(dict) && num("BitsPerComponent") === 8 && !/\/DecodeParms/.test(dict)) {
        const channels = /\/DeviceRGB/.test(dict) ? 3 : /\/DeviceGray/.test(dict) ? 1 : 0;
        const raw = channels && inflateSync(data, { maxOutputLength: 64 * 1024 * 1024 });
        if (raw && raw.length >= width * height * channels) out.push(png(width, height, channels, raw));
      }
    } catch {
      // a damaged image is skipped
    }
  }
  return out;
}

// ---- OCR: one English worker, used one job at a time and closed when idle ----
const require = createRequire(import.meta.url);
let worker = null,
  idle = null,
  ocrQueue = Promise.resolve();
export async function stopOcr() {
  clearTimeout(idle);
  const w = worker;
  worker = null;
  if (w) await (await w).terminate();
}
function ocrImages(images) {
  const job = ocrQueue.then(async () => {
    clearTimeout(idle);
    worker ??= import("tesseract.js").then(({ createWorker }) =>
      createWorker("eng", 1, {
        // The language data ships with the app, so nothing is downloaded.
        langPath: join(dirname(require.resolve("@tesseract.js-data/eng/package.json")), "4.0.0_best_int"),
        cacheMethod: "none",
        gzip: true,
      }),
    );
    const w = await worker;
    const texts = [];
    for (const img of images) texts.push((await w.recognize(img)).data.text);
    return texts.join("\n");
  });
  ocrQueue = job
    .catch(() => {})
    .then(() => {
      clearTimeout(idle);
      idle = setTimeout(() => void stopOcr(), 60000);
      idle.unref();
    });
  return job;
}
export const needsOcr = (mime) => mime === "image/jpeg" || mime === "image/png" || mime === "application/pdf";

export async function resumeText(bytes, mime, { ocr = false } = {}) {
  try {
    let text =
      mime === "application/pdf"
        ? await pdfText(bytes)
        : mime ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ? docxText(bytes)
          : mime === "application/msword"
            ? docText(bytes)
            : "";
    if (ocr && !text.trim()) {
      const images =
        mime === "application/pdf"
          ? pdfImages(bytes)
          : mime === "image/jpeg" || mime === "image/png"
            ? [Buffer.from(bytes)]
            : [];
      if (images.length) text = await ocrImages(images);
    }
    return text
      .replace(/\r/g, "")
      .replace(/[ \t ]+/g, " ")
      .replace(/\n\s*\n+/g, "\n")
      .trim()
      .slice(0, MAX_TEXT);
  } catch {
    return ""; // A damaged or password-protected file is kept, just not read.
  }
}

// Common skills for a lending and finance company, on top of what each opening asks for.
const COMMON_SKILLS = [
  "sales", "field sales", "direct sales", "collections", "recovery", "credit appraisal",
  "underwriting", "credit analysis", "loan processing", "kyc", "msme lending", "home loans",
  "gold loans", "vehicle loans", "microfinance", "customer service", "relationship management",
  "cross selling", "team handling", "branch operations", "accounting", "tally", "gst", "tds",
  "excel", "advanced excel", "ms office", "powerpoint", "sap", "data entry", "mis",
  "audit", "compliance", "risk management", "legal", "documentation", "hr", "recruitment",
  "payroll", "communication", "negotiation", "hindi", "english", "marathi", "gujarati",
  "sql", "python", "java", "javascript", "power bi", "tableau", "networking", "two wheeler",
];

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a resume says: { name, email, phone, experience_years, skills }; missing parts are null/[]. */
export function parseResume(text, wantedSkills = []) {
  const lower = text.toLowerCase();
  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0].toLowerCase() ?? null;
  // Indian mobile numbers: optional +91 / 0, then ten digits starting 6-9, spaces or dashes allowed.
  const phoneMatch = text.match(/(?<![\d+])(?:\+?91[\s-]?|0)?([6-9](?:[\s-]?\d){9})(?!\d)/);
  const phone = phoneMatch ? phoneMatch[1].replace(/\D/g, "") : null;
  let experience = null;
  for (const m of lower.matchAll(
    /(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)(?:\s+and\s+\d{1,2}\s+months?)?(?:\s+of)?[^.\n]{0,40}?(?:experience|exp\b)/g,
  )) {
    const n = Number(m[1]);
    if (n <= 50) experience = Math.max(experience ?? 0, n);
  }
  if (experience === null) {
    const m = lower.match(/(?:experience|exp)\s*[:-]?\s*(\d{1,2}(?:\.\d{1,2})?)\s*\+?\s*(?:years?|yrs?)/);
    if (m && Number(m[1]) <= 50) experience = Number(m[1]);
  }
  const skills = [
    ...new Set(
      [...wantedSkills.map((s) => s.toLowerCase()), ...COMMON_SKILLS].filter(
        (s) => s.length >= 2 && new RegExp(`(^|[^a-z0-9])${escape(s)}($|[^a-z0-9])`).test(lower),
      ),
    ),
  ]
    // "sales" adds nothing next to "field sales".
    .filter((s, _, all) => !all.some((o) => o !== s && o.split(" ").includes(s)))
    .slice(0, 40);
  // The name is usually the first short line made only of letters, before any contact details.
  const skipLine = /resume|curriculum|vitae|\bcv\b|profile|objective|summary|address|contact|email|phone|mobile/i;
  let name = null;
  for (const raw of text.split("\n").slice(0, 8)) {
    const line = raw.replace(/^(name\s*[:-]\s*)/i, "").trim();
    if (skipLine.test(line)) continue;
    if (/^[A-Za-z][A-Za-z.' ]{2,48}$/.test(line) && line.split(/\s+/).length <= 4 && line.split(/\s+/).length >= 1) {
      name = line
        .toLowerCase()
        .replace(/(^|[\s.'])([a-z])/g, (_, a, b) => a + b.toUpperCase());
      break;
    }
  }
  return { name, email, phone, experience_years: experience, skills };
}

// "asha_rao-CV (1).pdf" becomes "Asha Rao".
export function nameFromFileName(f) {
  return (
    String(f || "")
      .replace(/\.[^.]+$/, "")
      .replace(/\(\d+\)|\b(cv|resume|curriculum vitae|final|new|updated)\b/gi, "")
      .replace(/[_\-.\d]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || "Unnamed candidate"
  );
}

/** Text plus what was found, or null when the file cannot be read. */
export async function readResume(bytes, mime, wantedSkills = [], { ocr = false } = {}) {
  const text = await resumeText(bytes, mime, { ocr });
  return text ? { text, ...parseResume(text, wantedSkills) } : null;
}

/**
 * Reads a stored resume into the candidate: fills email, phone, experience and name
 * (only where empty, or a name taken from the file name), adds found skills, keeps the
 * text for search, rescores, and notes what was read on the candidate's timeline.
 */
export async function applyResume(
  db,
  candidateId,
  bytes,
  mime,
  { rescore, nameIsGuess = false, actorId = null, at = new Date().toISOString(), ocr = false } = {},
) {
  const c = await db.prepare("SELECT * FROM candidates WHERE id=?").get(candidateId);
  const o = c.opening_id
    ? await db.prepare("SELECT skills FROM job_openings WHERE id=?").get(c.opening_id)
    : null;
  const found = await readResume(bytes, mime, JSON.parse(o?.skills || "[]"), { ocr });
  if (!found) return null;
  const { text } = found;
  const had = JSON.parse(c.skills || "[]");
  const skills = [...new Set([...had, ...found.skills])].slice(0, 40);
  const filled = [];
  const set = { resume_text: text, skills: JSON.stringify(skills) };
  if (found.name && nameIsGuess) (set.name = found.name), filled.push("name");
  if (found.email && !c.email) (set.email = found.email), filled.push("email");
  if (found.phone && !c.phone) (set.phone = found.phone), filled.push("phone");
  if (found.experience_years !== null && c.experience_years == null)
    (set.experience_years = found.experience_years), filled.push("experience");
  if (skills.length > had.length) filled.push(`${skills.length - had.length} skill(s)`);
  const keys = Object.keys(set);
  await db
    .prepare(`UPDATE candidates SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`)
    .run(...keys.map((k) => set[k]), candidateId);
  await db
    .prepare("INSERT INTO candidate_events(candidate_id,kind,detail,actor_id,created_at) VALUES(?,?,?,?,?)")
    .run(
      candidateId,
      "note",
      filled.length ? `Resume read: filled ${filled.join(", ")}` : "Resume read: nothing new found",
      actorId,
      at,
    );
  if (rescore) await rescore(db, candidateId);
  return { ...found, text: undefined, filled };
}

// Photos and scanned PDFs: read by OCR after the candidate is saved, one at a time, so a
// bulk import does not wait for it. resumesRead() resolves when the queue is empty.
let later = Promise.resolve();
export function readResumeLater(db, candidateId, bytes, mime, options) {
  later = later
    .then(() => applyResume(db, candidateId, bytes, mime, { ...options, ocr: true }))
    .catch((e) => console.error("Reading a resume by OCR failed:", e.message));
}
export const resumesRead = () => later;
