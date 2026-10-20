import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  let nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const { server, app } = createApp({ db, clock: () => nowMs });
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
  const call = async (path, body, token, method = "POST") => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
    };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
      .padEnd(16, "0")
      .slice(0, 64);
    const r = await call("/login", {
      email,
      password,
      native: true,
      device: { id, platform: "android", model: "T", secret: secrets.get(id) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (
    await call(
      "/admin/workplaces",
      {
        name: "Office",
        latitude: 26.9,
        longitude: 75.8,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email: `${key}@example.test`,
        password: PW,
        workplace_id: site,
        date_of_joining: "2026-01-01",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("pay", { role: "payroll" });
  await add("mgr");
  await add("emp");
  return {
    db,
    call,
    owner,
    people,
    site,
    add,
    signIn,
    app,
    setNow: (iso) => (nowMs = Date.parse(iso)),
  };
}

import http from "node:http";

test("credit check: consent, manual and bureau lookups, risk bands, audit and hire gate", async (t) => {
  const prevKey = process.env.DATA_ENCRYPTION_KEY;
  const prevAllow = process.env.CREDIT_ALLOW_PRIVATE;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.CREDIT_ALLOW_PRIVATE = "1";
  t.after(() => {
    for (const [k, v] of [
      ["DATA_ENCRYPTION_KEY", prevKey],
      ["CREDIT_ALLOW_PRIVATE", prevAllow],
    ])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  // A stand-in for the bureau's API.
  const seen = [];
  let mode = "ok";
  const bureau = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      seen.push({ key: req.headers["x-api-key"], body: raw });
      if (mode === "down") {
        res.writeHead(500);
        return res.end("oops");
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          data: { cibil: { score: mode === "low" ? 590 : 712 } },
          name: "x",
        }),
      );
    });
  });
  await new Promise((r) => bureau.listen(0, "127.0.0.1", r));
  t.after(() => bureau.close());

  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token;
  const cid = (
    await call(
      "/admin/candidates",
      { name: "Riya Jain", email: "riya@example.test", phone: "9876500001" },
      hr,
    )
  ).data.id;

  // Only HR and admin: payroll and employees are refused.
  for (const who of ["emp", "pay"])
    assert.equal(
      (await call("/admin/credit/settings", undefined, people[who].token))
        .status,
      403,
    );
  const s0 = (await call("/admin/credit/settings", undefined, hr)).data;
  assert.equal(s0.enabled, false);
  assert.match(s0.consent_text, /credit information/);

  // Nothing can run until it is switched on and the candidate consents.
  assert.equal(
    (
      await call(
        `/admin/candidates/${cid}/credit-check`,
        { manual_score: 700 },
        hr,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/credit/settings",
        { enabled: true, medium_min: 800, low_min: 750 },
        hr,
        "PUT",
      )
    ).status,
    400,
  );
  const save = await call(
    "/admin/credit/settings",
    {
      enabled: true,
      required_before_hire: true,
      url: `http://127.0.0.1:${bureau.address().port}/score`,
      auth_header: "X-Api-Key",
      api_key: "secret-key-1",
      score_path: "data.cibil.score",
      body_template: '{"pan":"{{pan}}","name":"{{name}}"}',
    },
    hr,
    "PUT",
  );
  assert.equal(save.status, 200, JSON.stringify(save.data));
  const shown = (await call("/admin/credit/settings", undefined, hr)).data;
  assert.equal(shown.api_key_set, true);
  assert.equal(JSON.stringify(shown).includes("secret-key-1"), false);
  assert.ok(
    !(
      await db.prepare("SELECT api_key_enc FROM credit_settings").get()
    ).api_key_enc.includes("secret-key-1"),
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${cid}/credit-check`,
        { manual_score: 700 },
        hr,
      )
    ).status,
    409,
  );

  // Offer, joining link, candidate consent on the portal.
  const offer = await call(
    `/admin/candidates/${cid}/offers`,
    { designation: "Clerk", monthly_gross: 20000, joining_date: "2026-12-01" },
    hr,
  );
  const sent = await call(
    `/admin/offers/${offer.data.id}/status`,
    { status: "sent" },
    hr,
  );
  const jt = new URL(sent.data.link, "http://x").searchParams.get("t");
  const page = await call(`/join/${jt}`);
  assert.match(page.data.credit.text, /credit information/);
  assert.equal(page.data.credit.given_at, null);
  assert.equal(
    (
      await call(`/join/${jt}/credit-consent`, {
        full_name: "Riya Jain",
        agree: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/join/${jt}/credit-consent`, {
        full_name: "Someone",
        agree: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/join/${jt}/credit-consent`, {
        full_name: "riya  JAIN",
        agree: true,
      })
    ).status,
    200,
  );
  assert.ok((await call(`/join/${jt}`)).data.credit.given_at);
  const dash0 = (await call("/admin/credit-checks", undefined, hr)).data;
  assert.equal(dash0.summary.not_checked, 1);

  // The bureau lookup needs a PAN; it is sent with the key and filled template.
  assert.equal(
    (await call(`/admin/candidates/${cid}/credit-check`, {}, hr)).status,
    400,
  );
  assert.equal(
    (await call(`/admin/candidates/${cid}/credit-check`, { pan: "bad" }, hr))
      .status,
    400,
  );
  const ok = await call(
    `/admin/candidates/${cid}/credit-check`,
    { pan: "abcde1234f" },
    hr,
  );
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.equal(ok.data.score, 712);
  assert.equal(ok.data.risk, "medium");
  assert.equal(ok.data.pan_last4, "234F");
  assert.equal(seen[0].key, "secret-key-1");
  assert.deepEqual(JSON.parse(seen[0].body), {
    pan: "ABCDE1234F",
    name: "Riya Jain",
  });
  const row = await db
    .prepare("SELECT * FROM credit_checks WHERE id=?")
    .get(ok.data.id);
  assert.ok(row.report_enc && !row.report_enc.includes("712"));
  const rep = await call(
    `/admin/credit-checks/${ok.data.id}/report`,
    undefined,
    hr,
  );
  assert.equal(rep.data.data.cibil.score, 712);

  // Failures are recorded, not hidden.
  mode = "down";
  const bad = await call(
    `/admin/candidates/${cid}/credit-check`,
    { pan: "ABCDE1234F" },
    hr,
  );
  assert.equal(bad.status, 502);
  assert.equal(bad.data.status, "failed");
  assert.match(bad.data.error, /status 500/);
  // High risk from the bureau, then the hire gate.
  mode = "low";
  const low = await call(
    `/admin/candidates/${cid}/credit-check`,
    { pan: "ABCDE1234F" },
    hr,
  );
  assert.equal(low.data.risk, "high");
  await call(`/join/${jt}/accept`, { full_name: "Riya Jain" });
  const hire = (body) =>
    call(`/admin/candidates/${cid}/hire`, { password: PW, ...body }, hr);
  const refused = await hire({});
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /high risk/);
  assert.equal(
    (await hire({ credit_override_note: "Approved by the HR head" })).status,
    201,
  );

  // Manual entry uses the same bands; the audit log shows who did what.
  const c2 = (
    await call(
      "/admin/candidates",
      { name: "Dev Kumar", email: "dev@example.test" },
      hr,
    )
  ).data.id;
  assert.equal(
    (await call(`/admin/candidates/${c2}/credit-consent`, { note: "" }, hr))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${c2}/credit-consent`,
        { note: "Signed form on file" },
        hr,
      )
    ).status,
    201,
  );
  const m = await call(
    `/admin/candidates/${c2}/credit-check`,
    { manual_score: 800, note: "From bureau PDF" },
    hr,
  );
  assert.deepEqual([m.data.status, m.data.risk], ["manual", "low"]);
  assert.equal(
    (
      await call(
        `/admin/candidates/${c2}/credit-check`,
        { manual_score: 100 },
        hr,
      )
    ).status,
    400,
  );
  const detail = (await call(`/admin/candidates/${c2}/credit`, undefined, hr))
    .data;
  assert.equal(detail.consent.source, "hr_recorded");
  assert.equal(detail.checks[0].score, 800);
  const dash = (await call("/admin/credit-checks", undefined, hr)).data;
  assert.equal(dash.summary.low, 1);
  assert.equal(dash.summary.high, 1);
  const log = (await call("/admin/credit/audit", undefined, hr)).data.map(
    (a) => a.action,
  );
  for (const a of [
    "credit_settings_saved",
    "credit_consent_given",
    "credit_check_run",
    "credit_report_viewed",
    "credit_consent_recorded",
  ])
    assert.ok(log.includes(a), a);
});

test("the bureau address must be a public https website", async () => {
  const { assertPublicHttps, pick, fillTemplate } =
    await import("../server/credit.js");
  const env = {};
  for (const bad of [
    "http://example.com/x",
    "https://localhost/x",
    "https://127.0.0.1/x",
    "https://10.1.2.3/x",
    "https://192.168.0.5/x",
    "https://169.254.169.254/x",
    "https://[::1]/x",
    "not a url",
  ])
    await assert.rejects(assertPublicHttps(bad, env), undefined, bad);
  await assertPublicHttps("https://8.8.8.8/score", env);
  assert.equal(pick({ a: { b: [{ c: 5 }] } }, "a.b[0].c"), 5);
  assert.equal(
    fillTemplate('{"n":"{{name}}"}', { name: 'A"B' }),
    '{"n":"A\\"B"}',
  );
});
