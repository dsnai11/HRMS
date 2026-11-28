import { HttpError, integer, oneOf, optionalString, string } from "../http.js";
import { decryptJson, encryptionKey } from "../crypto-store.js";
import { checkFile } from "./documents.js";

// Bulk upload of HR documents: HR picks many files at once, each is matched to one employee
// by the employee code, PAN or ESI number in its file name, HR checks the list, then each file is saved
// to that employee only. Employees see only their own files (documents.js decides access).

export const BULK_KINDS = {
  hr_document: "HR document (letter, certificate…)",
  esi_card: "ESI card",
  offer_letter: "Offer / appointment letter",
};
const norm = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
const PAN = /(?:^|[^A-Z])([A-Z]{5}[0-9]{4}[A-Z])(?:[^A-Z0-9]|$)/;
// ESI (IP) numbers are 10 digits (17 on old cards), as ESIC names its certificate files.
const ESI = /(?:^|[^0-9])(\d{10}|\d{17})(?:[^0-9]|$)/g;

/**
 * Who a file name belongs to. The code must stand on its own in the name ("LIFC0101.pdf",
 * "LIFC0101_ESI.pdf", "Ravi LIFC0101 increment.pdf"); the longest matching code wins, and two
 * different codes of the same length are left for HR to choose.
 */
export function matchFileName(fileName, people, panOwner = new Map(), esiOwner = new Map()) {
  const base = String(fileName || "").replace(/\.[A-Za-z0-9]{2,4}$/, "");
  const upper = base.toUpperCase();
  const pan = upper.match(PAN)?.[1];
  if (pan && panOwner.has(pan)) return { user: panOwner.get(pan), by: "pan" };
  for (const m of base.matchAll(ESI)) if (esiOwner.has(m[1])) return { user: esiOwner.get(m[1]), by: "esi" };
  const tokens = upper.split(/[^A-Z0-9]+/).filter(Boolean);
  let best = null;
  let tie = false;
  for (const p of people) {
    const code = norm(p.employee_code);
    if (code.length < 3) continue;
    const hit = tokens.some(
      (t, i) =>
        t === code ||
        // written with a separator: "LIFC-0101"
        t + (tokens[i + 1] ?? "") === code ||
        // letters straight after the code: "LIFC0101ESI" (but not "LIFC01012")
        (t.startsWith(code) && /^[A-Z]+$/.test(t.slice(code.length))),
    );
    if (!hit) continue;
    if (!best || code.length > norm(best.employee_code).length) {
      best = p;
      tie = false;
    } else if (code.length === norm(best.employee_code).length && best.id !== p.id) tie = true;
  }
  if (best && !tie) return { user: best, by: "code" };
  return { user: null, by: null, ...(pan ? { pan } : {}) };
}

export function registerBulkDocuments(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();

  // PAN → employee and ESI number → employee, read once per request (both are stored encrypted).
  async function identityOwners(companyId) {
    const key = encryptionKey();
    const pans = new Map();
    const esis = new Map();
    if (!key) return { pans, esis };
    for (const row of await db
      .prepare(
        "SELECT p.user_id,p.data,u.name,u.employee_code FROM employee_private p JOIN users u ON u.id=p.user_id WHERE p.company_id=? AND u.active=1",
      )
      .all(companyId)) {
      try {
        const data = decryptJson(row.data, key);
        const who = { id: row.user_id, name: row.name, employee_code: row.employee_code };
        const pan = String(data.pan ?? "").toUpperCase();
        const esi = String(data.esi_ip ?? "").replace(/\D/g, "");
        if (pan) pans.set(pan, who);
        if (esi) esis.set(esi, who);
      } catch {
        /* a row that does not decrypt is skipped */
      }
    }
    return { pans, esis };
  }

  router.post("/api/admin/documents/match", { perm: "employees.write" }, async ({ companyId, body, send }) => {
    const b = await body();
    if (!Array.isArray(b.files) || !b.files.length) throw new HttpError(400, "Choose the files first.");
    if (b.files.length > 1000) throw new HttpError(400, "Up to 1,000 files at a time.");
    // Everyone active, for HR to pick by hand where a name does not match.
    const people = await db
      .prepare("SELECT id,name,employee_code FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' ORDER BY name")
      .all(companyId);
    // Decrypting everyone's PAN and ESI number is only worth it when a name could hold one.
    const { pans, esis } = b.files.some((f) => PAN.test(String(f).toUpperCase()) || /\d{10}/.test(String(f)))
      ? await identityOwners(companyId)
      : { pans: new Map(), esis: new Map() };
    return send(200, {
      people,
      matches: b.files.map((f) => {
        const m = matchFileName(string(f, "File name", 200), people, pans, esis);
        return { file: f, user: m.user && { id: m.user.id, name: m.user.name, employee_code: m.user.employee_code }, by: m.by };
      }),
    });
  });

  // One file for one employee; the page sends them one by one so a big batch never hits the
  // request size limit, and each result shows against its file.
  router.post("/api/admin/documents/bulk", { perm: "employees.write" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body(3_000_000);
    const target = await db
      .prepare("SELECT id,name FROM users WHERE id=? AND company_id=? AND active=1")
      .get(integer(Number(b.user_id)), companyId);
    if (!target) throw new HttpError(404, "Employee not found.");
    const kind = oneOf(b.kind ?? "hr_document", "Document type", Object.keys(BULK_KINDS));
    const name = (optionalString(b.title, "Title", 120) || string(b.file_name ?? "Document", "File name", 200).replace(/\.[A-Za-z0-9]{2,4}$/, ""))
      .replace(/[\\/\r\n"]/g, "_")
      .slice(0, 120);
    const file = checkFile(b);
    const at = nowIso();
    // One ESI card per person: a new one replaces the old.
    if (kind === "esi_card")
      await db
        .prepare("UPDATE documents SET deleted_at=? WHERE user_id=? AND kind='esi_card' AND deleted_at IS NULL")
        .run(at, target.id);
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO documents(company_id,user_id,kind,name,mime,size,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(companyId, target.id, kind, name, file.mime, file.bytes.length, await app.blobs.put(file.data, "documents"), user.id, at)
      ).lastInsertRowid,
    );
    await audit("document_bulk_uploaded", { id, employeeId: target.id, kind });
    if (b.notify !== false)
      await app.notify([target.id], {
        companyId,
        kind: "document",
        title: kind === "esi_card" ? "Your ESI card is ready" : `HR shared a document with you: ${name}`,
        link: "documents",
      });
    return send(201, { id, employee: target.name });
  });
}
