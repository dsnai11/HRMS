import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { parseResume, pdfImages, resumeText, resumesRead, stopOcr } from "../server/resume-parse.js";

// A scanned resume: the same picture as a JPEG and as raw 8-bit grey pixels (1100 x 330).
const JPG = readFileSync(new URL("./fixtures/scanned-cv.jpg", import.meta.url));
const GREY = inflateSync(readFileSync(new URL("./fixtures/scanned-cv.gray", import.meta.url)));
const [W, H] = [1100, 330];

// A PDF whose only page is an image, as a scanner makes it.
function scannedPdf(image, dict) {
  const parts = [];
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /XObject << /Im1 5 0 R >> >> >>`,
  ];
  const draw = `q ${W} 0 0 ${H} 0 0 cm /Im1 Do Q`;
  objs.push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
  let out = "%PDF-1.4\n";
  objs.forEach((o, i) => (out += `${i + 1} 0 obj\n${o}\nendobj\n`));
  parts.push(Buffer.from(out + `5 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} ${dict} /Length ${image.length} >>\nstream\n`, "latin1"));
  parts.push(image, Buffer.from("\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

// A Word 97-2003 file: an OLE compound file with WordDocument and 1Table streams.
// The text is one 8-bit piece; a hyperlink field shows how field codes are dropped.
function docOf(text) {
  const SECTOR = 512,
    STREAM = 4096;
  const body = Buffer.from(text.replace(/\n/g, "\r") + "\r", "latin1");
  const wd = Buffer.alloc(STREAM);
  wd.writeUInt16LE(0xa5ec, 0);
  wd.writeUInt16LE(0x0200, 0x0a); // text tables in 1Table
  wd.writeUInt32LE(0, 0x1a2); // Clx at the start of the table stream
  wd.writeUInt32LE(21, 0x1a6);
  body.copy(wd, 0x800);
  const table = Buffer.alloc(STREAM);
  table[0] = 0x02;
  table.writeUInt32LE(16, 1);
  table.writeUInt32LE(0, 5);
  table.writeUInt32LE(body.length, 9);
  table.writeUInt32LE((0x800 * 2) | 0x40000000, 13 + 2); // compressed (8-bit) piece
  const header = Buffer.alloc(SECTOR, 0);
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(header);
  header.writeUInt16LE(0x3e, 0x18);
  header.writeUInt16LE(3, 0x1a);
  header.writeUInt16LE(0xfffe, 0x1c);
  header.writeUInt16LE(9, 0x1e);
  header.writeUInt16LE(6, 0x20);
  header.writeUInt32LE(1, 0x2c); // one FAT sector
  header.writeUInt32LE(1, 0x30); // directory in sector 1
  header.writeUInt32LE(4096, 0x38);
  header.writeUInt32LE(0xfffffffe, 0x3c);
  header.writeUInt32LE(0xfffffffe, 0x44);
  for (let i = 0; i < 109; i++) header.writeUInt32LE(i === 0 ? 0 : 0xffffffff, 0x4c + i * 4);
  const fat = Buffer.alloc(SECTOR, 0xff);
  fat.writeUInt32LE(0xfffffffd, 0);
  fat.writeUInt32LE(0xfffffffe, 4);
  for (const first of [2, 10])
    for (let n = first; n < first + 8; n++) fat.writeUInt32LE(n === first + 7 ? 0xfffffffe : n + 1, n * 4);
  const dir = Buffer.alloc(SECTOR, 0);
  [
    ["Root Entry", 5, 0xfffffffe, 0],
    ["WordDocument", 2, 2, STREAM],
    ["1Table", 2, 10, STREAM],
  ].forEach(([name, type, start, size], i) => {
    const o = i * 128;
    const n = Buffer.from(name + "\0", "utf16le");
    n.copy(dir, o);
    dir.writeUInt16LE(n.length, o + 64);
    dir[o + 66] = type;
    dir.writeUInt32LE(start, o + 116);
    dir.writeUInt32LE(size, o + 120);
  });
  for (let i = 3; i < 4; i++) dir.writeUInt32LE(0xffffffff, i * 128 + 68);
  return Buffer.concat([header, fat, dir, wd, table]);
}

test.after(() => stopOcr());

test("reads old Word (.doc) resumes, photos and scanned PDFs", async () => {
  const doc = docOf(
    'Arjun Mehta\nEmail: \x13 HYPERLINK "mailto:arjun@example.com" \x14arjun@example.com\x15\nMobile 98290 11223\n3 years of experience in home loans\x07KYC',
  );
  const docText = await resumeText(doc, "application/msword");
  assert.doesNotMatch(docText, /HYPERLINK/);
  const d = parseResume(docText);
  assert.deepEqual([d.name, d.email, d.phone, d.experience_years], ["Arjun Mehta", "arjun@example.com", "9829011223", 3]);
  assert.ok(d.skills.includes("home loans") && d.skills.includes("kyc"), d.skills.join());

  // Without OCR a photo gives nothing; with it, the same details as a typed resume.
  assert.equal(await resumeText(JPG, "image/jpeg"), "");
  const flate = (await import("node:zlib")).deflateSync(GREY);
  const pdfs = [
    scannedPdf(JPG, "/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode"),
    scannedPdf(flate, "/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"),
  ];
  for (const p of pdfs) assert.equal(pdfImages(p).length, 1);
  for (const [bytes, mime] of [[JPG, "image/jpeg"], [pdfs[0], "application/pdf"], [pdfs[1], "application/pdf"]]) {
    const r = parseResume(await resumeText(bytes, mime, { ocr: true }));
    assert.equal(r.name, "Neha Gupta", mime);
    assert.equal(r.email, "neha.gupta@example.com", mime);
    assert.equal(r.phone, "9123456780", mime);
    assert.equal(r.experience_years, 6, mime);
    for (const s of ["collections", "kyc", "tally", "excel", "recovery"]) assert.ok(r.skills.includes(s), `${s}: ${r.skills}`);
  }
});

test("photo resumes are read in the background after import", async (t) => {
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
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true, device: { id: "phone-owner-0000002", platform: "android", model: "T" } })).data.token;
  const job = (await call("/admin/openings", { title: "Collection Officer", positions: 2 }, owner)).data;
  const imp = await call(`/admin/rms/openings/${job.id}/resumes`, {
    kind: "whatsapp",
    items: [
      { resume: { name: "IMG_2041.jpg", mime: "image/jpeg", data: JPG.toString("base64") } },
      { resume: { name: "old-cv.doc", mime: "application/msword", data: docOf("Sunil Yadav\nsunil@example.com\n5 years experience in recovery").toString("base64") } },
    ],
  }, owner);
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  await resumesRead();
  const people = (await call(`/admin/rms/openings/${job.id}/inbox`, undefined, owner)).data.people;
  const neha = people.find((p) => p.email === "neha.gupta@example.com");
  assert.ok(neha, JSON.stringify(people));
  assert.deepEqual([neha.name, neha.phone, neha.experience_years], ["Neha Gupta", "9123456780", 6]);
  const sunil = people.find((p) => p.email === "sunil@example.com");
  assert.deepEqual([sunil?.name, sunil?.experience_years], ["Sunil Yadav", 5]);
  // OCR text is searchable too.
  const found = (await call(`/admin/rms/openings/${job.id}/inbox?q=tally`, undefined, owner)).data.people;
  assert.deepEqual(found.map((p) => p.id), [neha.id]);
});
