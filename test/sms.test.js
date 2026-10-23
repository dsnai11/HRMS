import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { createNotifier } from "../server/notify.js";
import { e164, smsConfigured } from "../server/sms.js";

test("phone numbers are sent in +91 form", () => {
  assert.equal(e164("98290 12345"), "+919829012345");
  assert.equal(e164("09829012345"), "+919829012345");
  assert.equal(e164("919829012345"), "+919829012345");
  assert.equal(e164("+44 7700 900123"), "+447700900123");
  assert.equal(e164("12345"), null);
  assert.equal(smsConfigured({}), false);
  assert.equal(smsConfigured({ SMS_PROVIDER: "webhook" }), false);
  assert.equal(smsConfigured({ SMS_PROVIDER: "webhook", SMS_WEBHOOK_URL: "http://x" }), true);
});

test("alerts that matter go out by SMS through the configured gateway", async (t) => {
  const got = [];
  const gateway = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      got.push({ auth: req.headers.authorization, ...JSON.parse(body) });
      res.end("{}");
    });
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "o@example.test", password: "Owner-password-123", companyName: "Alpha" });
  const { server, app } = createApp({ db });
  t.after(async () => {
    gateway.close();
    server.close();
    await db.close();
  });
  const env = {
    SMS_PROVIDER: "webhook",
    SMS_WEBHOOK_URL: `http://127.0.0.1:${gateway.address().port}/send`,
    SMS_WEBHOOK_TOKEN: "test-token",
  };
  const notify = createNotifier(app, env);
  const owner = (await db.prepare("SELECT id FROM users").get()).id;
  await db.prepare("UPDATE users SET phone='98290 12345' WHERE id=?").run(owner);

  await notify([owner], { companyId: 1, kind: "leave", title: "Your leave request was approved" });
  await notify([owner], { companyId: 1, kind: "announcement", title: "Not by SMS" });
  await notify([owner], { companyId: 1, kind: "approval", title: "Escalated", sms: true });
  const sent = async () =>
    (await db.prepare("SELECT COUNT(*) n FROM sms_outbox WHERE status<>'queued'").get()).n;
  for (let i = 0; i < 100 && (await sent()) < 2; i++) await new Promise((r) => setTimeout(r, 20));

  assert.deepEqual(
    got.map((g) => [g.to, g.message.split(".")[0], g.auth]).sort(),
    [
      ["+919829012345", "Escalated", "Bearer test-token"],
      ["+919829012345", "Your leave request was approved", "Bearer test-token"],
    ],
  );
  const log = await db.prepare("SELECT status FROM sms_outbox ORDER BY id").all();
  assert.deepEqual(log.map((r) => r.status), ["sent", "sent"]);
});
