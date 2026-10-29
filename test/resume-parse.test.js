import { test } from "node:test";
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { nameFromFileName, parseResume, resumeText } from "../server/resume-parse.js";

// A real (if tiny) PDF with one line of text per entry.
function pdfOf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const stream = `BT /F1 11 Tf 50 780 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(" ")} ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const at = [];
  objs.forEach((o, i) => {
    at.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${at.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

// A .docx is a zip; this one stores word/document.xml uncompressed.
function docxOf(lines) {
  const xml = Buffer.from(
    `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>${lines
      .map((l) => `<w:p><w:r><w:t>${l.replace(/&/g, "&amp;")}</w:t></w:r></w:p>`)
      .join("")}</w:body></w:document>`,
  );
  const name = Buffer.from("word/document.xml");
  const crc = crc32(xml);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(xml.length, 18);
  local.writeUInt32LE(xml.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(xml.length, 20);
  central.writeUInt32LE(xml.length, 24);
  central.writeUInt16LE(name.length, 28);
  const body = Buffer.concat([local, name, xml]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(46 + name.length, 12);
  end.writeUInt32LE(body.length, 16);
  return Buffer.concat([body, central, name, end]);
}

const CV = [
  "PRIYA SHARMA",
  "Mobile: +91 98765-43210 | priya.sharma@example.com",
  "Jaipur, Rajasthan",
  "Professional summary",
  "Sales officer with 4.5 years of experience in gold loans and collections.",
  "Skills: Field Sales, KYC, Advanced Excel, Tally, Hindi, English",
  "2019 - 2024 ABC Finance Ltd",
];
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

test("reads name, contact details, experience and skills from PDF and Word resumes", async () => {
  for (const [bytes, mime] of [
    [pdfOf(CV), "application/pdf"],
    [docxOf(CV), DOCX],
  ]) {
    const text = await resumeText(bytes, mime);
    assert.match(text, /PRIYA SHARMA/, mime);
    const r = parseResume(text, ["Branch Banking", "kyc"]);
    assert.equal(r.name, "Priya Sharma", mime);
    assert.equal(r.email, "priya.sharma@example.com");
    assert.equal(r.phone, "9876543210");
    assert.equal(r.experience_years, 4.5);
    for (const s of ["kyc", "field sales", "advanced excel", "tally", "gold loans", "collections", "hindi"])
      assert.ok(r.skills.includes(s), `${s} in ${r.skills}`);
    assert.ok(!r.skills.includes("branch banking"));
  }
  // Years in dates are not phone numbers; unreadable files give no text instead of failing.
  assert.equal(parseResume("Worked 2019-2024 at 12345678901").phone, null);
  assert.equal(parseResume("Total experience: 7 yrs").experience_years, 7);
  assert.equal(await resumeText(Buffer.from("%PDF-1.4 broken"), "application/pdf"), "");
  assert.equal(await resumeText(Buffer.from("\xd0\xcf\x11\xe0", "latin1"), "application/msword"), "");
  assert.equal(nameFromFileName("asha_rao-CV (1).pdf"), "Asha Rao");
});

test("imported resumes fill in the candidate, score them, match duplicates and can be searched", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
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
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true, device: { id: "phone-owner-0000001", platform: "android", model: "T" } })).data.token;
  const job = (await call("/admin/openings", { title: "Sales Officer", positions: 3 }, owner)).data;
  assert.equal(
    (await call(`/admin/openings/${job.id}/details`, { skills: ["kyc", "field sales", "gold loans", "two wheeler"], min_experience_years: 3 }, owner, "PATCH")).status,
    200,
  );
  const file = (name, bytes, mime) => ({ name, mime, data: bytes.toString("base64") });

  // Only files: everything else comes from inside the resumes.
  const imp = await call(`/admin/rms/openings/${job.id}/resumes`, {
    kind: "naukri",
    items: [
      { resume: file("cv_final.pdf", pdfOf(CV), "application/pdf") },
      { resume: file("ravi-kumar.docx", docxOf(["Curriculum Vitae", "Ravi Kumar", "ravi.k@example.com", "Two wheeler loans, KYC"]), DOCX) },
    ],
  }, owner);
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  assert.deepEqual(imp.data.results.map((r) => [r.ok, r.duplicate]), [[true, false], [true, false]]);
  const inbox = (await call(`/admin/rms/openings/${job.id}/inbox`, undefined, owner)).data.people;
  const priya = inbox.find((p) => p.name === "Priya Sharma");
  assert.ok(priya, JSON.stringify(inbox));
  assert.deepEqual([priya.email, priya.phone, priya.experience_years], ["priya.sharma@example.com", "9876543210", 4.5]);
  // 3 of 4 skills (70%) and full experience (30%).
  assert.equal(priya.match_score, Math.round(0.75 * 70 + 30));
  const ravi = inbox.find((p) => p.email === "ravi.k@example.com");
  assert.equal(ravi.name, "Ravi Kumar");

  // The same CV from LinkedIn, sent with no details, is recognised from its phone number.
  const li = (await call("/admin/rms/sources", { kind: "linkedin" }, owner)).data;
  const again = await call(`/intake/${li.key}`, { opening_id: job.id, resume: file("Priya.pdf", pdfOf(CV), "application/pdf") });
  assert.deepEqual([again.status, again.data.id, again.data.duplicate], [201, priya.id, true]);

  // Search looks inside the resume text.
  const find = async (q) => (await call(`/admin/rms/openings/${job.id}/inbox?q=${encodeURIComponent(q)}`, undefined, owner)).data.people.map((p) => p.name);
  assert.deepEqual(await find("tally"), ["Priya Sharma"]);
  assert.deepEqual(await find("ravi kyc"), ["Ravi Kumar"]);
  assert.deepEqual(await find("zzz"), []);

  // HR can read a resume again: a candidate added by hand gains details from it.
  const c = (await call("/admin/candidates", { name: "Manual Person", opening_id: job.id }, owner)).data;
  assert.ok(c.id, JSON.stringify(c));
  assert.equal((await call(`/admin/candidates/${c.id}/read-resume`, {}, owner)).status, 404);
  await db
    .prepare("INSERT INTO candidate_files(candidate_id,kind,name,mime,size,data,created_at) VALUES(?,?,?,?,?,?,?)")
    .run(c.id, "resume", "m.pdf", "application/pdf", 10, pdfOf(["Manual Person", "manual@example.com", "6 years experience in collections"]).toString("base64"), new Date().toISOString());
  const read = await call(`/admin/candidates/${c.id}/read-resume`, {}, owner);
  assert.equal(read.status, 200, JSON.stringify(read.data));
  assert.deepEqual(read.data.filled, ["email", "experience", "1 skill(s)"]);
  const row = await db.prepare("SELECT name,email,experience_years,match_score FROM candidates WHERE id=?").get(c.id);
  assert.deepEqual([row.name, row.email, row.experience_years], ["Manual Person", "manual@example.com", 6]);
});
