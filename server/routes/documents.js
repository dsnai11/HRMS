import { HttpError, integer, oneOf, string } from "../http.js";
import { requireOwned } from "../scope.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

export const KINDS = [
  "id_proof",
  "address_proof",
  "pan",
  "education",
  "experience",
  "bank",
  "offer_letter",
  "medical",
  "form16",
  "other",
];
export const TYPES = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};
const MAX_BYTES = 2 * 1024 * 1024;

/** Validates an uploaded file body {mime,data}; returns the decoded bytes. */
export function checkFile(b) {
  const mime = oneOf(b.mime, "File type", Object.keys(TYPES));
  const data = string(b.data, "File", 3_000_000);
  if (!/^[A-Za-z0-9+/=]+$/.test(data))
    throw new HttpError(400, "The file is not valid.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_BYTES)
    throw new HttpError(413, "Files can be up to 2 MB.");
  // The first bytes must match the declared type.
  const magic = {
    "application/pdf": "%PDF",
    "image/jpeg": "\xff\xd8\xff",
    "image/png": "\x89PNG",
  }[mime];
  if (bytes.subarray(0, magic.length).toString("latin1") !== magic)
    throw new HttpError(
      400,
      "The file does not look like a " + TYPES[mime].toUpperCase() + ".",
    );
  return { mime, data, bytes };
}

// Files are kept in the database as base64 text, so no separate file storage is needed;
// the limit keeps the database small. Large scans should be compressed before upload.
export function registerDocuments(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const LIST =
    "SELECT d.id,d.user_id,d.kind,d.name,d.mime,d.size,d.verified_at,d.created_at,v.name verified_by_name FROM documents d LEFT JOIN users v ON v.id=d.verified_by";
  const mayAccess = (user, ownerId) =>
    ownerId === user.id || can(user, "employees.write");

  router.get("/api/documents", async ({ user, query, send }) => {
    const target = query.get("user_id")
      ? integer(Number(query.get("user_id")))
      : user.id;
    if (!mayAccess(user, target))
      throw new HttpError(403, "You cannot see these documents.");
    const owner = await db
      .prepare("SELECT id FROM users WHERE id=? AND company_id=?")
      .get(target, user.company_id);
    if (!owner) throw new HttpError(404, "Employee not found.");
    return send(
      200,
      await db
        .prepare(
          `${LIST} WHERE d.user_id=? AND d.deleted_at IS NULL ORDER BY d.id DESC`,
        )
        .all(target),
    );
  });
  router.post("/api/documents", async ({ user, body, send, audit }) => {
    const b = await body(3_000_000);
    const target = b.user_id ? integer(b.user_id) : user.id;
    if (!mayAccess(user, target))
      throw new HttpError(403, "You cannot add documents for this person.");
    const owner = await db
      .prepare("SELECT id FROM users WHERE id=? AND company_id=?")
      .get(target, user.company_id);
    if (!owner) throw new HttpError(404, "Employee not found.");
    const { mime, data, bytes } = checkFile(b);
    if (
      (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM documents WHERE user_id=? AND deleted_at IS NULL",
          )
          .get(target)
      ).n >= 30
    )
      throw new HttpError(
        409,
        "There are already 30 documents on file. Remove one first.",
      );
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO documents(company_id,user_id,kind,name,mime,size,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
          )
          .run(
            user.company_id,
            target,
            oneOf(b.kind ?? "other", "Type", KINDS),
            string(b.name, "Name", 120).replace(/[\\/\r\n"]/g, "_"),
            mime,
            bytes.length,
            data,
            user.id,
            nowIso(),
          )
      ).lastInsertRowid,
    );
    await audit("document_uploaded", { id, employeeId: target });
    return send(201, { id });
  });
  router.get(
    "/api/documents/:id/file",
    async ({ user, params, res, headers, audit }) => {
      const d = await requireOwned(
        db,
        "documents",
        integer(Number(params.id)),
        user.company_id,
        "document",
      );
      // Whoever may decide a leave request may also open its supporting document.
      const forLeave = async () => {
        const r = await db
          .prepare("SELECT user_id FROM leave_requests WHERE document_id=? AND company_id=?")
          .get(d.id, user.company_id);
        return r ? mayDecide(app, user, r.user_id) : false;
      };
      if (d.deleted_at || !(mayAccess(user, d.user_id) || (await forLeave())))
        throw new HttpError(404, "Document not found.");
      if (d.user_id !== user.id)
        await audit("document_viewed", { id: d.id, employeeId: d.user_id });
      res.writeHead(200, {
        ...headers,
        "Content-Type": d.mime,
        "Content-Disposition": `inline; filename="${d.name}.${TYPES[d.mime]}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(d.data, "base64"));
    },
  );
  router.post(
    "/api/documents/:id/verify",
    { perm: "employees.write" },
    async ({ user, params, companyId, send, audit }) => {
      const d = await requireOwned(
        db,
        "documents",
        integer(Number(params.id)),
        companyId,
        "document",
      );
      await db
        .prepare("UPDATE documents SET verified_by=?,verified_at=? WHERE id=?")
        .run(user.id, nowIso(), d.id);
      await audit("document_verified", { id: d.id });
      return send(200, { ok: true });
    },
  );
  router.delete("/api/documents/:id", async ({ user, params, send, audit }) => {
    const d = await requireOwned(
      db,
      "documents",
      integer(Number(params.id)),
      user.company_id,
      "document",
    );
    // People can remove what they uploaded until HR verifies it; HR can always remove.
    const own =
      d.uploaded_by === user.id && !d.verified_at && d.user_id === user.id;
    if (!own && !can(user, "employees.write"))
      throw new HttpError(403, "You cannot remove this document.");
    await db
      .prepare("UPDATE documents SET deleted_at=?,data='' WHERE id=?")
      .run(nowIso(), d.id);
    await audit("document_removed", { id: d.id, employeeId: d.user_id });
    return send(200, { ok: true });
  });
  // Which required documents are missing, per person, for onboarding follow-up.
  router.get(
    "/api/admin/documents/missing",
    { perm: "employees.write" },
    async ({ companyId, query, send }) => {
      const need = (query.get("kinds") ?? "id_proof,address_proof,pan")
        .split(",")
        .filter((k) => KINDS.includes(k));
      const people = await db
        .prepare(
          "SELECT id,name,employee_code FROM users WHERE company_id=? AND active=1 AND role<>'super_admin' ORDER BY name",
        )
        .all(companyId);
      const have = await db
        .prepare(
          "SELECT user_id,kind FROM documents WHERE company_id=? AND deleted_at IS NULL",
        )
        .all(companyId);
      const by = new Map();
      for (const h of have)
        by.set(h.user_id, new Set([...(by.get(h.user_id) ?? []), h.kind]));
      return send(
        200,
        people
          .map((p) => ({
            ...p,
            missing: need.filter((k) => !by.get(p.id)?.has(k)),
          }))
          .filter((p) => p.missing.length),
      );
    },
  );
}
