import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { runFieldForce } from "../server/field-force/index.js";

const IST = (local) => Date.parse(`${local}+05:30`);
const PW = "Temporary-pass-123";

// Stand-ins for Meta's WhatsApp API and for the company's calling provider.
test("Field Force escalation: WhatsApp messages and buttons, IVR and AI calls, provider callbacks", async (t) => {
  const sent = { whatsapp: [], calls: [] };
  const outside = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    const json = body ? JSON.parse(body) : {};
    if (req.url.endsWith("/messages")) {
      if (req.headers.authorization !== "Bearer wa-token") return res.writeHead(401).end("{}");
      sent.whatsapp.push(json);
      return res.end(JSON.stringify({ messages: [{ id: `wamid.${sent.whatsapp.length}` }] }));
    }
    if (req.url === "/call") {
      if (req.headers.authorization !== "Bearer call-secret") return res.writeHead(401).end("{}");
      sent.calls.push(json);
      if (json.to === "+919876500003") return res.writeHead(503).end(JSON.stringify({ error: "Line busy" }));
      return res.end(JSON.stringify({ call_id: `prov-${sent.calls.length}` }));
    }
    res.writeHead(404).end("{}");
  });
  await new Promise((r) => outside.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${outside.address().port}`;
  const saved = { ...process.env };
  Object.assign(process.env, {
    WHATSAPP_TOKEN: "wa-token",
    WHATSAPP_APP_SECRET: "app-secret",
    WHATSAPP_VERIFY_TOKEN: "verify-me-please",
    WHATSAPP_GRAPH: origin,
    FF_WHATSAPP_PHONE_ID: "555000",
    FF_CALL_URL: `${origin}/call`,
    FF_CALL_TOKEN: "call-secret",
    APP_URL: "https://hrms.example.test",
  });
  let nowMs = IST("2026-11-09T07:00:00"); // a Monday
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        outside.close();
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method, headers = {}) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const person = async (name, phone, extra = {}) => {
    const id = (await call("/admin/employees", { name, email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.test`, password: PW, phone, ...extra }, admin)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    return id;
  };
  const boss = await person("Boss", "9876511111");
  const ravi = await person("Ravi Kumar", "98765 43210", { manager_id: boss }); // taps a WhatsApp button
  const sita = await person("Sita", "+91 98765 00001", { manager_id: boss }); // presses 2 on the IVR call
  const tara = await person("Tara", "9876500002", { manager_id: boss }); // misses the IVR, answers the AI call
  const veer = await person("Veer", "9876500003", { manager_id: boss }); // the provider cannot reach him
  const noor = await person("Noor", "", { manager_id: boss }); // no mobile number
  await call("/field-force/staff", { team: "collection", user_ids: [ravi, sita, tara, veer, noor] }, admin, "PATCH");

  // Setup: the outside services are ready; the calls must sit between reminder and report.
  assert.deepEqual((await call("/field-force/channels", undefined, admin)).data, {
    whatsapp_ready: true,
    calls_ready: true,
    push_ready: false,
    email_ready: false,
  });
  assert.equal((await call("/field-force/settings", { on: true, ivr: "09:45" }, admin, "PATCH")).status, 400);
  assert.equal((await call("/field-force/settings", { on: true, wa_nudge_template: "Bad Name" }, admin, "PATCH")).status, 400);
  const clock = (await call("/field-force/settings", { on: true, whatsapp: true, ivr: "10:30", ai: "11:00" }, admin, "PATCH")).data;
  assert.equal(clock.ivr, "10:30");
  const at = async (local) => {
    nowMs = IST(local);
    await runFieldForce(app);
  };

  // 8:30: the morning template by WhatsApp, addressed by first name; Noor has no number.
  await at("2026-11-09T08:30:00");
  assert.equal(sent.whatsapp.length, 4);
  const first = sent.whatsapp.find((m) => m.to === "919876543210");
  assert.equal(first.template.name, "ff_morning_activation");
  assert.equal(first.template.components[0].parameters[0].text, "Ravi");
  const skipped = await db.prepare("SELECT status,detail FROM ff_contacts WHERE user_id=?").get(noor);
  assert.deepEqual(skipped, { status: "skipped", detail: "No valid mobile number" });

  // 10:00: the reason template, with four buttons carrying the reasons.
  await at("2026-11-09T10:00:00");
  const reminder = sent.whatsapp.at(-1);
  assert.equal(reminder.template.name, "ff_activation_reason");
  assert.deepEqual(
    reminder.template.components.filter((c) => c.type === "button").map((c) => c.parameters[0].payload),
    ["ff:on_the_way", "ff:on_leave", "ff:app_issue", "ff:call_me"],
  );

  // Ravi taps "On the way" in WhatsApp; a stranger tapping the same button changes nothing.
  const webhook = async (from, payload) => {
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { metadata: { phone_number_id: "555000" }, messages: [{ id: `in-${from}`, from, type: "button", button: { payload, text: "x" } }] } }] }],
    });
    const res = await fetch(`${base}/whatsapp/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Hub-Signature-256": `sha256=${createHmac("sha256", "app-secret").update(raw).digest("hex")}` },
      body: raw,
    });
    return res.json();
  };
  assert.deepEqual((await webhook("919876543210", "ff:on_the_way")).outcome, ["handled"]);
  assert.match(sent.whatsapp.at(-1).text.body, /Your manager can see: On the way/);
  await webhook("919999999999", "ff:on_leave");
  const day = (await call("/field-force/day?date=2026-11-09", undefined, admin)).data;
  const raviDay = day.people.find((p) => p.id === ravi);
  assert.equal(raviDay.reason, "on_the_way");
  assert.equal(raviDay.reason_via, "whatsapp");
  assert.equal(day.counts.reason, 1, "the stranger's tap was ignored");

  // 10:30: IVR calls to everyone still without a reason; Ravi is not called, Noor cannot be.
  await at("2026-11-09T10:30:00");
  assert.deepEqual(sent.calls.map((c) => c.to).sort(), ["+919876500001", "+919876500002", "+919876500003"]);
  const ivr = sent.calls.find((c) => c.to === "+919876500001");
  assert.equal(ivr.kind, "ivr");
  assert.equal(ivr.callback_url, "https://hrms.example.test/api/field-force/calls/callback");
  assert.deepEqual(ivr.options.map((o) => o.key + o.reason), ["1on_the_way", "2on_leave", "3app_issue", "4call_me"]);
  assert.match(ivr.script, /Press 1 if you are on the way/);
  await at("2026-11-09T10:45:00");
  assert.equal(sent.calls.length, 3, "one IVR call each");
  assert.equal(
    (await db.prepare("SELECT status FROM ff_contacts WHERE user_id=? AND channel='ivr'").get(veer)).status,
    "failed",
    "the provider could not take Veer's call",
  );

  // The provider reports back: only with the shared secret, only for our calls.
  const callback = (b, token = "call-secret") =>
    call("/field-force/calls/callback", b, token);
  const ivrId = (u) => db.prepare("SELECT id FROM ff_contacts WHERE user_id=? AND channel='ivr'").get(u);
  assert.equal((await callback({ id: `ff-${(await ivrId(sita)).id}`, status: "answered", key: "2" }, "wrong")).status, 401);
  assert.equal((await callback({ id: "ff-999999", status: "answered", key: "2" })).status, 404);
  assert.equal((await callback({ id: `ff-${(await ivrId(sita)).id}`, status: "answered", key: "2" })).status, 200);
  assert.equal((await callback({ id: `ff-${(await ivrId(tara)).id}`, status: "no_answer" })).status, 200);

  // 11:00: AI calls to those still without a reason: Tara and Veer (Sita pressed 2).
  await at("2026-11-09T11:00:00");
  const ai = sent.calls.slice(3);
  assert.deepEqual(ai.map((c) => c.to).sort(), ["+919876500002", "+919876500003"]);
  assert.ok(ai.every((c) => c.kind === "ai"));
  const aiTara = await db.prepare("SELECT id FROM ff_contacts WHERE user_id=? AND channel='ai'").get(tara);
  await callback({ id: `ff-${aiTara.id}`, status: "answered", reason: "call_me" });
  const toBoss = await db
    .prepare("SELECT title FROM notifications WHERE user_id=? AND kind='activation' ORDER BY id DESC LIMIT 1")
    .get(boss);
  assert.match(toBoss.title, /Tara has not started and asked to be called/);

  // The day shows each person's reason, where it came from, and every contact.
  const view = (await call("/field-force/day?date=2026-11-09", undefined, admin)).data;
  const of = (id) => view.people.find((p) => p.id === id);
  assert.deepEqual([of(sita).reason, of(sita).reason_via], ["on_leave", "ivr"]);
  assert.deepEqual([of(tara).reason, of(tara).reason_via], ["call_me", "ai"]);
  assert.deepEqual(
    of(tara).contacts.map((c) => `${c.channel}:${c.step}:${c.status}`),
    ["whatsapp:nudge:sent", "whatsapp:remind:sent", "ivr:ivr:no_answer", "ai:ai:answered"],
  );
  assert.equal(of(veer).status, "no_reply");

  // A punch-in always wins: a late "on leave" from a call does not overwrite a punched-in day.
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, admin)).data.id;
  await db
    .prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,0,0,100,50,?,0,0,10)")
    .run(veer, site, "HO", new Date(IST("2026-11-09T11:05:00")).toISOString());
  const aiVeer = await db.prepare("SELECT id FROM ff_contacts WHERE user_id=? AND channel='ai'").get(veer);
  await callback({ id: `ff-${aiVeer.id}`, status: "answered", key: "2" });
  assert.equal((await call("/field-force/day?date=2026-11-09", undefined, admin)).data.people.find((p) => p.id === veer).status, "late");

  // After the report time, no more calls.
  const calls = sent.calls.length;
  await at("2026-11-09T12:30:00");
  assert.equal(sent.calls.length, calls);
});
