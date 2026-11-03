import { HttpError, integer, optionalString } from "../http.js";
import { checkFile } from "./documents.js";
import { requireOwned } from "../scope.js";
import { HEX, brandCss, contrast, palette } from "../brand.js";

// Appearance (see migration 064 and brand.js): the brand colour, accent and logo that an
// administrator sets on the web portal; the portal and the phone app both use them.
// Profile photographs: each person can set their own; HR can set anyone's.
const IMAGE = ["image/jpeg", "image/png"];

export function registerBranding(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  // Before sign-in there is no company to go by: the first one is the brand shown.
  const publicCompany = () =>
    db.prepare("SELECT * FROM companies WHERE active=1 ORDER BY id LIMIT 1").get();
  const describe = (c) => ({
    name: c?.name ?? app.company,
    primary: c?.brand_primary ?? null,
    accent: c?.brand_accent ?? null,
    palette: palette(c?.brand_primary, c?.brand_accent),
    logo_url: c?.brand_logo ? `/api/branding/logo?v=${encodeURIComponent(c.brand_updated_at ?? "")}` : null,
    updated_at: c?.brand_updated_at ?? null,
  });
  app.brandOf = describe;

  router.get("/api/branding", { public: true }, async ({ send }) => send(200, describe(await publicCompany())));
  router.get("/api/branding.css", { public: true }, async ({ res, headers }) => {
    res.writeHead(200, { ...headers, "Content-Type": "text/css; charset=utf-8" });
    res.end(brandCss(await publicCompany()));
  });
  router.get("/api/branding/logo", { public: true }, async ({ res, headers }) => {
    const c = await publicCompany();
    if (!c?.brand_logo) throw new HttpError(404, "No logo has been uploaded.");
    res.writeHead(200, { ...headers, "Content-Type": c.brand_logo_mime, "Cache-Control": "public, max-age=86400" });
    res.end(await app.blobs.bytes(c.brand_logo));
  });

  router.get("/api/admin/branding", { perm: "branding.manage" }, async ({ companyId, send }) =>
    send(200, describe(await db.prepare("SELECT * FROM companies WHERE id=?").get(companyId))),
  );
  // Colours: null for either goes back to the standard Laxmi red / an accent worked out from it.
  router.put("/api/admin/branding", { perm: "branding.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const pick = (v, label) => {
      const s = optionalString(v, label, 7);
      if (s && !HEX.test(s)) throw new HttpError(400, `${label} must be a colour like #c8102e.`);
      return s ? s.toLowerCase() : null;
    };
    const primary = pick(b.primary, "Brand colour"),
      accent = pick(b.accent, "Accent colour");
    // Buttons and headers put white text on the brand colour: it has to be readable.
    if (primary && contrast(primary, "#ffffff") < 4.5)
      throw new HttpError(
        400,
        `White text on ${primary} is hard to read (contrast ${Math.round(contrast(primary, "#ffffff") * 10) / 10}:1; it needs 4.5:1). Choose a darker colour.`,
      );
    await db
      .prepare("UPDATE companies SET brand_primary=?,brand_accent=?,brand_updated_at=? WHERE id=?")
      .run(primary, accent, nowIso(), companyId);
    await audit("branding_updated", { primary, accent });
    return send(200, describe(await db.prepare("SELECT * FROM companies WHERE id=?").get(companyId)));
  });
  router.put("/api/admin/branding/logo", { perm: "branding.manage" }, async ({ companyId, body, send, audit }) => {
    const file = checkFile(await body(3_000_000));
    if (!IMAGE.includes(file.mime)) throw new HttpError(400, "The logo must be a PNG or JPG.");
    if (file.bytes.length > 512 * 1024) throw new HttpError(413, "The logo can be up to 512 KB.");
    const old = await db.prepare("SELECT brand_logo FROM companies WHERE id=?").get(companyId);
    await db
      .prepare("UPDATE companies SET brand_logo=?,brand_logo_mime=?,brand_updated_at=? WHERE id=?")
      .run(await app.blobs.put(file.data, "branding"), file.mime, nowIso(), companyId);
    if (old?.brand_logo) app.blobs.remove(old.brand_logo).catch(() => {});
    await audit("branding_logo_updated", { size: file.bytes.length });
    return send(200, describe(await db.prepare("SELECT * FROM companies WHERE id=?").get(companyId)));
  });
  router.delete("/api/admin/branding/logo", { perm: "branding.manage" }, async ({ companyId, send, audit }) => {
    const old = await db.prepare("SELECT brand_logo FROM companies WHERE id=?").get(companyId);
    await db
      .prepare("UPDATE companies SET brand_logo=NULL,brand_logo_mime=NULL,brand_updated_at=? WHERE id=?")
      .run(nowIso(), companyId);
    if (old?.brand_logo) app.blobs.remove(old.brand_logo).catch(() => {});
    await audit("branding_logo_removed", {});
    return send(200, { ok: true });
  });

  // ---- profile photographs ---------------------------------------------------------------------
  async function setPhoto(userId, b) {
    const file = checkFile(b);
    if (!IMAGE.includes(file.mime)) throw new HttpError(400, "The photo must be a JPG or PNG.");
    const old = await db.prepare("SELECT photo FROM users WHERE id=?").get(userId);
    const at = nowIso();
    await db
      .prepare("UPDATE users SET photo=?,photo_mime=?,photo_updated_at=? WHERE id=?")
      .run(await app.blobs.put(file.data, "photos"), file.mime, at, userId);
    await dropUnshared(old?.photo);
    return at;
  }
  // A joining photo is shared with the joining document; that copy is kept.
  async function dropUnshared(data) {
    if (!data) return;
    const used = await db.prepare("SELECT id FROM documents WHERE data=? LIMIT 1").get(data);
    if (!used) app.blobs.remove(data).catch(() => {});
  }
  router.put("/api/profile/photo", { allowTemp: true }, async ({ user, body, send, audit }) => {
    const at = await setPhoto(user.id, await body(3_000_000));
    await audit("profile_photo_updated", {});
    return send(200, { photo_at: at });
  });
  router.delete("/api/profile/photo", async ({ user, send, audit }) => {
    const old = await db.prepare("SELECT photo FROM users WHERE id=?").get(user.id);
    await db.prepare("UPDATE users SET photo=NULL,photo_mime=NULL,photo_updated_at=? WHERE id=?").run(nowIso(), user.id);
    await dropUnshared(old?.photo);
    await audit("profile_photo_removed", {});
    return send(200, { ok: true });
  });
  router.put("/api/admin/employees/:id/photo", { perm: "employees.write" }, async ({ params, companyId, body, send, audit }) => {
    const person = await requireOwned(db, "users", integer(Number(params.id)), companyId, "employee");
    const at = await setPhoto(person.id, await body(3_000_000));
    await audit("profile_photo_updated", { employeeId: person.id });
    return send(200, { photo_at: at });
  });
  // Anyone signed in to the company may see colleagues' photos, as in the directory.
  router.get("/api/people/:id/photo", async ({ user, params, res, headers }) => {
    const p = await db
      .prepare("SELECT photo,photo_mime FROM users WHERE id=? AND company_id=?")
      .get(integer(Number(params.id)), user.company_id);
    if (!p?.photo) throw new HttpError(404, "No photo.");
    res.writeHead(200, { ...headers, "Content-Type": p.photo_mime, "Cache-Control": "private, max-age=86400" });
    res.end(await app.blobs.bytes(p.photo));
  });
}
