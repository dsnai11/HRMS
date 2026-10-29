import { inflateRawSync } from "node:zlib";

// Reads the text of a PDF or Word (.docx) resume and picks out what a recruiter types by
// hand: name, email, phone, years of experience and skills. Old .doc files and photos are
// not read (that would need OCR); they are kept as files only.

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

export async function resumeText(bytes, mime) {
  try {
    const text =
      mime === "application/pdf"
        ? await pdfText(bytes)
        : mime ===
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ? docxText(bytes)
          : "";
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
export async function readResume(bytes, mime, wantedSkills = []) {
  const text = await resumeText(bytes, mime);
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
  { rescore, nameIsGuess = false, actorId = null, at = new Date().toISOString() } = {},
) {
  const c = await db.prepare("SELECT * FROM candidates WHERE id=?").get(candidateId);
  const o = c.opening_id
    ? await db.prepare("SELECT skills FROM job_openings WHERE id=?").get(c.opening_id)
    : null;
  const found = await readResume(bytes, mime, JSON.parse(o?.skills || "[]"));
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
