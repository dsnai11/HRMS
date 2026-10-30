import { HttpError, integer, isoDate, oneOf, optionalId, string } from "../http.js";
import { requireOwned } from "../scope.js";

// Engagement gallery: photos from HR days, celebrations and awards. People who post
// announcements share photos; everyone in the company (or the chosen branch) sees them.
const CATEGORIES = ["HR Celebration", "Event", "Rewards & Recognition", "Training", "CSR", "Other"];
const MAX_BYTES = 1024 * 1024;

export function registerGallery(router, app) {
  const { db } = app;
  const visible = "g.company_id=? AND g.deleted_at IS NULL AND (g.branch_id IS NULL OR g.branch_id=?)";

  router.get("/api/gallery", async ({ user, query, send }) => {
    const limit = Math.min(Math.max(Number(query.get("limit")) || 30, 1), 100);
    return send(200, {
      categories: CATEGORIES,
      items: await db
        .prepare(
          `SELECT g.id,g.title,g.category,g.event_date,g.size,g.created_at,b.name branch_name,u.name posted_by_name
           FROM gallery_photos g LEFT JOIN branches b ON b.id=g.branch_id LEFT JOIN users u ON u.id=g.posted_by
           WHERE ${visible} ORDER BY g.event_date DESC,g.id DESC LIMIT ?`,
        )
        .all(user.company_id, user.branch_id ?? -1, limit),
    });
  });
  router.get("/api/gallery/:id/image", async ({ user, params, res, headers }) => {
    const g = await db
      .prepare(`SELECT g.mime,g.data FROM gallery_photos g WHERE g.id=? AND ${visible}`)
      .get(integer(Number(params.id)), user.company_id, user.branch_id ?? -1);
    if (!g) throw new HttpError(404, "Photo not found.");
    res.writeHead(200, {
      ...headers,
      "Content-Type": g.mime,
      "Cache-Control": "private, max-age=86400",
    });
    res.end(await app.blobs.bytes(g.data));
  });
  router.post(
    "/api/admin/gallery",
    { perm: "announcements.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(1_500_000);
      const mime = oneOf(b.mime, "Photo type", ["image/jpeg", "image/png"]);
      const data = string(b.data, "Photo", 1_500_000);
      if (!/^[A-Za-z0-9+/=]+$/.test(data)) throw new HttpError(400, "The photo is not valid.");
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > MAX_BYTES) throw new HttpError(413, "Photos can be up to 1 MB.");
      const magic = mime === "image/png" ? "\x89PNG" : "\xff\xd8\xff";
      if (bytes.subarray(0, magic.length).toString("latin1") !== magic)
        throw new HttpError(400, "The file does not look like a photo.");
      const branch = optionalId(b.branch_id, "Branch");
      if (branch) await requireOwned(db, "branches", branch, companyId, "branch");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO gallery_photos(company_id,title,category,event_date,branch_id,mime,size,data,posted_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              string(b.title, "Title", 120),
              oneOf(b.category, "Category", CATEGORIES),
              isoDate(b.event_date, "Event date") ?? app.dayOf(new Date(app.clock()).toISOString()),
              branch,
              mime,
              bytes.length,
              await app.blobs.put(data, "gallery"),
              user.id,
              new Date(app.clock()).toISOString(),
            )
        ).lastInsertRowid,
      );
      await audit("gallery_photo_posted", { id });
      return send(201, { id });
    },
  );
  router.delete(
    "/api/admin/gallery/:id",
    { perm: "announcements.manage" },
    async ({ params, companyId, send, audit }) => {
      const r = await db
        .prepare("UPDATE gallery_photos SET deleted_at=? WHERE id=? AND company_id=? AND deleted_at IS NULL")
        .run(new Date(app.clock()).toISOString(), integer(Number(params.id)), companyId);
      if (!r.changes) throw new HttpError(404, "Photo not found.");
      await audit("gallery_photo_removed", { id: Number(params.id) });
      return send(200, { ok: true });
    },
  );
}
