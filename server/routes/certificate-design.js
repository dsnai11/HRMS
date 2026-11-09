import { HttpError, integer, oneOf, optionalString, string } from "../http.js";
import { HEX, contrast, palette } from "../brand.js";
import { checkFile } from "./documents.js";

// LMS → Manage courses → Certificate design: how the certificate looks. Saving adds a new design
// (see migration 072); a certificate keeps the design it was issued under.
const IMAGE = ["image/jpeg", "image/png"];
const MAX_IMAGE = 512 * 1024;
const DEFAULTS = {
  title: "Certificate of Completion",
  message: "has successfully completed the course",
  style: "heritage",
};

export const currentDesignId = async (db, companyId) =>
  (await db.prepare("SELECT id FROM certificate_designs WHERE company_id=? ORDER BY id DESC LIMIT 1").get(companyId))?.id ?? null;

/** What the certificate page needs; a certificate from before any design uses the current one. */
export async function designFor(app, company, designId) {
  const { db } = app;
  const row = await db
    .prepare(
      `SELECT * FROM certificate_designs WHERE company_id=? ${designId ? "AND id=?" : ""} ORDER BY id DESC LIMIT 1`,
    )
    .get(company.id, ...(designId ? [designId] : []));
  const image = (which) => (row?.[which] ? `/api/certificate-design/${row.id}/${which}` : null);
  return {
    title: row?.title ?? DEFAULTS.title,
    message: row?.message ?? DEFAULTS.message,
    style: row?.style ?? DEFAULTS.style,
    color: row?.color ?? palette(company.brand_primary, company.brand_accent).primary,
    signatory_name: row?.signatory_name ?? null,
    signatory_title: row?.signatory_title ?? null,
    signature_url: image("signature"),
    seal_url: image("seal"),
    company: company.name,
    logo_url: app.brandOf(company).logo_url || "/brand/logo.png",
  };
}

export function registerCertificateDesign(router, app) {
  const { db, clock } = app;
  const companyOf = (id) => db.prepare("SELECT * FROM companies WHERE id=?").get(id);

  router.get("/api/admin/certificate-design", { perm: "performance.manage" }, async ({ companyId, send }) =>
    send(200, await designFor(app, await companyOf(companyId), null)),
  );

  // undefined keeps the image, null removes it from the new design, a file replaces it.
  const pickImage = async (v, label, old, mime) => {
    if (v === undefined) return [old, mime];
    if (v === null) return [null, null];
    const file = checkFile(v);
    if (!IMAGE.includes(file.mime)) throw new HttpError(400, `The ${label} must be a PNG or JPG.`);
    if (file.bytes.length > MAX_IMAGE) throw new HttpError(413, `The ${label} can be up to 512 KB.`);
    return [await app.blobs.put(file.data, "branding"), file.mime];
  };

  router.put("/api/admin/certificate-design", { perm: "performance.manage" }, async ({ user, companyId, body, send, audit }) => {
    const b = await body(3_000_000);
    const title = string(b.title, "Heading", 80);
    const message = string(b.message, "Wording", 200);
    const style = oneOf(b.style, "Style", ["heritage", "prestige", "executive", "sovereign", "horizon"]);
    const color = string(b.color, "Colour", 7).toLowerCase();
    if (!HEX.test(color)) throw new HttpError(400, "Colour must be like #c8102e.");
    if (contrast(color, "#ffffff") < 3) throw new HttpError(400, "That colour is too light to read on white paper. Choose a darker one.");
    const old = await db
      .prepare("SELECT * FROM certificate_designs WHERE company_id=? ORDER BY id DESC LIMIT 1")
      .get(companyId);
    const [signature, signatureMime] = await pickImage(b.signature, "signature", old?.signature ?? null, old?.signature_mime ?? null);
    const [seal, sealMime] = await pickImage(b.seal, "seal", old?.seal ?? null, old?.seal_mime ?? null);
    await db
      .prepare(
        "INSERT INTO certificate_designs(company_id,title,message,style,color,signatory_name,signatory_title,signature,signature_mime,seal,seal_mime,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        companyId, title, message, style, color,
        optionalString(b.signatory_name, "Signatory name", 100) || null,
        optionalString(b.signatory_title, "Signatory designation", 100) || null,
        signature, signatureMime, seal, sealMime, user.id, new Date(clock()).toISOString(),
      );
    await audit("certificate_design_saved", { style, signature: Boolean(signature), seal: Boolean(seal) });
    return send(200, await designFor(app, await companyOf(companyId), null));
  });

  // Signed-in staff of the company only: a signature must not be open to the whole internet.
  router.get("/api/certificate-design/:id/:which", async ({ user, params, res, headers }) => {
    const which = oneOf(params.which, "Image", ["signature", "seal"]);
    const row = await db
      .prepare("SELECT * FROM certificate_designs WHERE id=? AND company_id=?")
      .get(integer(Number(params.id)), user.company_id);
    if (!row?.[which]) throw new HttpError(404, "No image.");
    res.writeHead(200, { ...headers, "Content-Type": row[`${which}_mime`], "Cache-Control": "private, max-age=86400" });
    res.end(await app.blobs.bytes(row[which]));
  });
}
