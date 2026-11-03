import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { contrast, palette } from "../server/brand.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]).toString("base64");

test("shades worked out from one colour stay readable", () => {
  const p = palette("#0b5cad");
  assert.equal(p.primary, "#0b5cad");
  assert.ok(contrast(p.nightText, "#12141c") >= 4.5);
  assert.equal(palette("nonsense").primary, "#c8102e");
});

test("admin sets colours and logo; the portal and app read them; everyone can set their photo", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, type: res.headers.get("content-type"), data: text.startsWith("{") ? JSON.parse(text) : text };
  };
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;

  // Default: Laxmi red.
  assert.equal((await call("/branding")).data.palette.primary, "#c8102e");
  // Too light for white text: refused.
  assert.equal((await call("/admin/branding", { primary: "#ffd400" }, owner, "PUT")).status, 400);
  const saved = await call("/admin/branding", { primary: "#0B5CAD", accent: null }, owner, "PUT");
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const pub = (await call("/branding")).data;
  assert.equal(pub.primary, "#0b5cad");
  const css = await call("/branding.css");
  assert.match(css.type, /text\/css/);
  assert.match(css.data, /--red: #0b5cad;/);
  assert.equal((await call("/me", undefined, owner)).data.company.branding.primary, "#0b5cad");

  // Logo.
  assert.equal((await call("/admin/branding/logo", { mime: "application/pdf", data: Buffer.from("%PDF-1").toString("base64") }, owner, "PUT")).status, 400);
  assert.equal((await call("/admin/branding/logo", { mime: "image/png", data: PNG }, owner, "PUT")).status, 200);
  const logoUrl = (await call("/branding")).data.logo_url;
  assert.ok(logoUrl);
  const logo = await fetch(`http://127.0.0.1:${server.address().port}${logoUrl}`);
  assert.equal(logo.headers.get("content-type"), "image/png");

  // Photo.
  assert.equal((await call("/me", undefined, owner)).data.user.photo_at, null);
  assert.equal((await call("/profile/photo", { mime: "image/png", data: PNG }, owner, "PUT")).status, 200);
  const me = (await call("/me", undefined, owner)).data.user;
  assert.ok(me.photo_at);
  const photo = await call(`/people/${me.id}/photo`, undefined, owner);
  assert.equal(photo.status, 200);
  assert.equal(photo.type, "image/png");
  assert.equal((await call("/profile/photo", undefined, owner, "DELETE")).status, 200);
  assert.equal((await call(`/people/${me.id}/photo`, undefined, owner)).status, 404);
});
