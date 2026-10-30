import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { createBlobStore, signRequest } from "../server/blob-store.js";
import { purgeOldSelfies } from "../server/retention.js";

const sha = (b) => createHash("sha256").update(b).digest("hex");

test("request signing matches the AWS Signature Version 4 example", () => {
  const h = signRequest({
    method: "GET",
    host: "examplebucket.s3.amazonaws.com",
    path: "/test.txt",
    headers: { Range: "bytes=0-9" },
    region: "us-east-1",
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.match(h.Authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
});

test("with object storage set up, selfies and documents are kept there and the database keeps a reference", async (t) => {
  // A stand-in for R2/S3: keeps objects in memory and checks each request is signed for its body.
  const objects = new Map();
  const s3 = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const signed = /^AWS4-HMAC-SHA256 Credential=test-key\//.test(req.headers.authorization ?? "");
    if (!signed || req.headers["x-amz-content-sha256"] !== sha(body)) return res.writeHead(403).end();
    if (req.method === "PUT") objects.set(req.url, body);
    else if (req.method === "DELETE") objects.delete(req.url);
    else if (!objects.has(req.url)) return res.writeHead(404).end();
    res.writeHead(200).end(req.method === "GET" ? objects.get(req.url) : undefined);
  });
  await new Promise((r) => s3.listen(0, "127.0.0.1", r));
  const blobs = createBlobStore({
    S3_ENDPOINT: `http://127.0.0.1:${s3.address().port}`,
    S3_BUCKET: "hrms-files",
    S3_ACCESS_KEY_ID: "test-key",
    S3_SECRET_ACCESS_KEY: "test-secret",
  });
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, blobs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    s3.close();
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, headers = {}, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const admin = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, admin)).data.id;
  const id = (await call("/admin/employees", { name: "Emp", email: "emp@example.test", password: "Temporary-pass-123", workplace_id: site }, admin)).data.id;
  await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
  const device = { id: "emp-device-00000001", platform: "android", model: "Pixel" };
  const reg = await call("/login", { email: "emp@example.test", password: "Temporary-pass-123", native: true, device });
  const row = (await call("/admin/devices", undefined, admin)).data[0];
  await call(`/admin/devices/${row.id}`, { status: "approved" }, admin, {}, "PATCH");
  const headers = { "X-Device-Id": device.id, "X-Device-Secret": reg.data.deviceSecret };

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20000, 9)]);
  const punch = await call(
    "/punch",
    { action: "in", selfie: jpeg.toString("base64"), location: { latitude: 26.9124, longitude: 75.7873, accuracy: 10, timestamp: Date.now() }, signals: {} },
    reg.data.token,
    headers,
  );
  assert.equal(punch.status, 200, JSON.stringify(punch.data));
  const photo = await db.prepare("SELECT data FROM punch_photos WHERE shift_id=?").get(punch.data.id);
  assert.match(photo.data, /^s3:selfies\/\d{4}-\d{2}\/[0-9a-f]{32}$/, "only a reference in the database");
  assert.equal(objects.size, 1);
  const view = await call(`/admin/shifts/${punch.data.id}/selfie?kind=in`, undefined, admin);
  assert.equal(view.status, 200);
  assert.ok(view.data.equals(jpeg), "the same bytes come back");

  // Documents go the same way; an old row still holding base64 is read as before.
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
  const up = await call("/documents", { kind: "other", name: "Offer.pdf", mime: "application/pdf", data: pdf.toString("base64") }, reg.data.token, headers);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  assert.match((await db.prepare("SELECT data FROM documents WHERE id=?").get(up.data.id)).data, /^s3:documents\//);
  assert.ok((await call(`/documents/${up.data.id}/file`, undefined, reg.data.token, headers)).data.equals(pdf));
  await db.prepare("UPDATE documents SET data=? WHERE id=?").run(pdf.toString("base64"), up.data.id);
  assert.ok((await call(`/documents/${up.data.id}/file`, undefined, reg.data.token, headers)).data.equals(pdf));

  // Retention removes the stored selfie as well as its row.
  assert.equal(await purgeOldSelfies(db, 90, Date.now() + 91 * 86400000, blobs), 1);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM punch_photos").get()).n, 0);
  assert.equal([...objects.keys()].filter((k) => k.includes("/selfies/")).length, 0);
});
