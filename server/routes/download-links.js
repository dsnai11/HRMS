import { randomBytes } from "node:crypto";
import { HttpError, integer, oneOf } from "../http.js";
import { can } from "../rbac.js";
import { mayDecide } from "../approval.js";

// Short-lived links for the phone app: the system's PDF viewer or browser cannot send
// the sign-in token, so the app asks for a link (with the token), the server checks
// access then, and the link works without sign-in for five minutes.
const TTL = 5 * 60000;

export function registerDownloadLinks(router, app) {
  const { db } = app;
  const links = new Map();
  const sweep = () => {
    const now = app.clock();
    for (const [k, v] of links) if (v.until < now) links.delete(k);
  };

  async function fileFor(user, kind, id) {
    if (kind === "document") {
      const d = await db
        .prepare("SELECT * FROM documents WHERE id=? AND company_id=? AND deleted_at IS NULL")
        .get(id, user.company_id);
      if (!d) return null;
      const leave = await db
        .prepare("SELECT user_id FROM leave_requests WHERE document_id=? AND company_id=?")
        .get(d.id, user.company_id);
      const allowed =
        d.user_id === user.id ||
        can(user, "employees.write") ||
        (leave && (await mayDecide(app, user, leave.user_id)));
      return allowed ? { mime: d.mime, name: d.name, data: d.data } : null;
    }
    const f = await db
      .prepare(
        `SELECT f.* FROM chat_files f JOIN chat_messages c ON c.id=f.message_id JOIN chat_members m ON m.room_id=f.room_id AND m.user_id=?
         JOIN chat_rooms r ON r.id=f.room_id WHERE f.id=? AND c.deleted_at IS NULL AND r.company_id=?`,
      )
      .get(user.id, id, user.company_id);
    return f ? { mime: f.mime, name: f.name, data: f.data } : null;
  }

  router.post("/api/download-links", async ({ user, body, send }) => {
    const b = await body();
    const kind = oneOf(b.kind, "Kind", ["document", "chat_file"]);
    const file = await fileFor(user, kind, integer(Number(b.id)));
    if (!file) throw new HttpError(404, "File not found.");
    sweep();
    const token = randomBytes(24).toString("hex");
    links.set(token, { ...file, until: app.clock() + TTL });
    return send(201, { url: `/api/dl/${token}`, expires_in: TTL / 1000 });
  });

  router.get("/api/dl/:token", { public: true }, async ({ params, res, headers }) => {
    sweep();
    const f = links.get(String(params.token));
    if (!f) throw new HttpError(404, "This link has expired. Open the file again from the app.");
    const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[f.mime] ?? "bin";
    res.writeHead(200, {
      ...headers,
      "Content-Type": f.mime,
      "Content-Disposition": `inline; filename="${String(f.name).replace(/[^A-Za-z0-9._ -]/g, "_").replace(/\.(pdf|jpg|png)$/i, "")}.${ext}"`,
      "Cache-Control": "private, no-store",
    });
    res.end(Buffer.from(f.data, "base64"));
  });
}
