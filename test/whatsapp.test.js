import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

// A stand-in for Meta's Graph API: media lookups, downloads, and the replies we send.
test("WhatsApp resumes: signed webhooks only, the file goes to RMS once, the candidate gets a reply", async (t) => {
  const replies = [];
  const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n");
  const graph = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    if (req.headers.authorization !== "Bearer wa-token") return res.writeHead(401).end("{}");
    const origin = `http://127.0.0.1:${graph.address().port}`;
    if (req.url === "/media-1") return res.end(JSON.stringify({ url: `${origin}/download/1`, mime_type: "application/pdf", file_size: pdf.length }));
    if (req.url === "/media-2") return res.end(JSON.stringify({ url: `${origin}/download/2`, mime_type: "video/mp4", file_size: 10 }));
    if (req.url === "/download/1") return res.end(pdf);
    if (req.url.endsWith("/messages")) {
      replies.push(JSON.parse(body));
      return res.end("{}");
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => graph.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_APP_SECRET: "app-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-me-please",
    WHATSAPP_GRAPH: `http://127.0.0.1:${graph.address().port}`,
  });
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    graph.close();
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
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const job = (await call("/admin/openings", { title: "Collection Officer", positions: 3 }, owner)).data.id;
  const other = (await call("/admin/openings", { title: "Teller", positions: 1 }, owner)).data.id;
  const src = (await call("/admin/rms/sources", { kind: "whatsapp" }, owner)).data;
  assert.equal((await call(`/admin/rms/sources/${src.id}/costs`, { default_opening_id: job }, owner, "PATCH")).status, 200);

  // Meta's one-time check.
  const hook = `${base}/whatsapp/webhook`;
  assert.equal(await (await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=12345`)).text(), "12345");
  assert.equal((await fetch(`${hook}?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`)).status, 403);

  const send = (payload, secret = "app-secret") => {
    const raw = JSON.stringify(payload);
    return fetch(hook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}` },
      body: raw,
    });
  };
  const message = (m) => ({
    entry: [{ changes: [{ value: { metadata: { phone_number_id: "555" }, contacts: [{ wa_id: "919876543210", profile: { name: "Ravi Meena" } }], messages: [m] } }] }],
  });
  const doc = message({ id: "wamid.1", from: "919876543210", type: "document", document: { id: "media-1", mime_type: "application/pdf", filename: "Ravi CV.pdf", caption: `For J${other} please` } });

  assert.equal((await send(doc, "not-the-secret")).status, 401, "unsigned or wrongly signed calls are refused");
  const first = await send(doc);
  assert.deepEqual((await first.json()).outcome, ["taken"]);
  const c = await db.prepare("SELECT * FROM candidates WHERE phone='9876543210'").get();
  assert.deepEqual([c.name, c.opening_id, c.source], ["Ravi Meena", other, "WhatsApp"], "the job code in the message wins over the default");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM candidate_files WHERE candidate_id=?").get(c.id)).n, 1);
  assert.match(replies.at(-1).text.body, new RegExp(`J${other}`));
  // Meta resends the same message: taken once.
  assert.deepEqual((await (await send(doc)).json()).outcome, ["duplicate"]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM candidates").get()).n, 1);
  // No code: the source's default job. A video is refused politely; a text gets instructions.
  const plain = message({ id: "wamid.2", from: "919811111111", type: "document", document: { id: "media-1", mime_type: "application/pdf", filename: "cv.pdf" } });
  assert.deepEqual((await (await send(plain)).json()).outcome, ["taken"]);
  assert.equal((await db.prepare("SELECT opening_id FROM candidates WHERE phone='9811111111'").get()).opening_id, job);
  const video = message({ id: "wamid.3", from: "919822222222", type: "document", document: { id: "media-2", mime_type: "video/mp4" } });
  assert.deepEqual((await (await send(video)).json()).outcome, ["wrong_type"]);
  const hello = message({ id: "wamid.4", from: "919833333333", type: "text", text: { body: "hi" } });
  assert.deepEqual((await (await send(hello)).json()).outcome, ["ignored"]);
  assert.match(replies.at(-1).text.body, /job code/);
});
