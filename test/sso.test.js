import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { createServer } from "node:http";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

// A stand-in identity provider (discovery, keys, token endpoint) that signs ID tokens with
// its own RSA key, and lets each step of the test change what it signs.
test("single sign-on: only real, signed, fresh tokens for known people in allowed domains", async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };
  let claimsFor = () => ({});
  let signWith = privateKey;
  let lastVerifier = null;
  const idp = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const origin = `http://127.0.0.1:${idp.address().port}`;
    if (url.pathname === "/.well-known/openid-configuration")
      return res.end(JSON.stringify({ issuer: origin, authorization_endpoint: `${origin}/auth`, token_endpoint: `${origin}/token`, jwks_uri: `${origin}/jwks` }));
    if (url.pathname === "/jwks") return res.end(JSON.stringify({ keys: [jwk] }));
    if (url.pathname === "/token") {
      let body = "";
      for await (const c of req) body += c;
      const p = new URLSearchParams(body);
      lastVerifier = p.get("code_verifier");
      if (p.get("client_secret") !== "secret-1") return res.writeHead(401).end("{}");
      const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
      const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
      const payload = enc({ iss: origin, aud: "client-1", exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email_verified: true, ...claimsFor(p) });
      const sig = sign("RSA-SHA256", Buffer.from(`${head}.${payload}`), signWith).toString("base64url");
      return res.end(JSON.stringify({ id_token: `${head}.${payload}.${sig}`, access_token: "x" }));
    }
    res.writeHead(404).end();
  });
  await new Promise((r) => idp.listen(0, "127.0.0.1", r));
  const saved = { ...process.env };
  Object.assign(process.env, {
    SSO_GOOGLE_CLIENT_ID: "client-1",
    SSO_GOOGLE_CLIENT_SECRET: "secret-1",
    SSO_GOOGLE_DISCOVERY: `http://127.0.0.1:${idp.address().port}/.well-known/openid-configuration`,
    SSO_ALLOWED_DOMAINS: "example.test",
  });
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    idp.close();
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const admin = (await (await fetch(`${origin}/api/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "Owner-password-123", native: true }) })).json()).token;
  const made = await fetch(`${origin}/api/admin/employees`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` }, body: JSON.stringify({ name: "Hr Person", email: "hr@example.test", password: "Temporary-pass-123", role: "hr" }) });
  assert.equal(made.status, 201);

  assert.deepEqual(await (await fetch(`${origin}/api/sso/providers`)).json(), [{ id: "google", label: "Google" }]);
  // One sign-in: start (state in a cookie), then the provider sends the browser back.
  const signIn = async (claims, { cookie = true, replay = null } = {}) => {
    claimsFor = () => claims;
    const start = await fetch(`${origin}/api/sso/google/start`, { redirect: "manual" });
    assert.equal(start.status, 302);
    const to = new URL(start.headers.get("location"));
    const state = to.searchParams.get("state");
    const c = start.headers.get("set-cookie").split(";")[0];
    const nonce = to.searchParams.get("nonce");
    claimsFor = () => ({ nonce, ...claims });
    const back = await fetch(`${origin}/api/sso/google/callback?code=abc&state=${replay ?? state}`, { redirect: "manual", headers: cookie ? { Cookie: replay ? `hrms_sso=${replay}` : c } : {} });
    return { back, state, challenge: to.searchParams.get("code_challenge"), to };
  };
  const errorOf = (r) => new URL(r.back.headers.get("location") ?? "http://x/", origin).searchParams.get("sso_error");

  const ok = await signIn({ email: "HR@example.test", sub: "1" });
  assert.equal(ok.back.status, 200, await ok.back.clone().text());
  assert.equal(ok.to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(createHash("sha256").update(lastVerifier).digest("base64url"), ok.challenge, "PKCE verifier matches the challenge");
  const session = ok.back.headers.getSetCookie().find((x) => x.startsWith("hrms_session=")).split(";")[0];
  const me = await (await fetch(`${origin}/api/me`, { headers: { Cookie: session } })).json();
  assert.equal(me.user.email, "hr@example.test");
  // Required two-factor login is met by the company account's sign-in.
  await db.prepare("UPDATE companies SET require_staff_2fa=1").run();
  assert.equal((await (await fetch(`${origin}/api/me`, { headers: { Cookie: session } })).json()).needs_2fa, undefined);
  await db.prepare("UPDATE companies SET require_staff_2fa=0").run();
  assert.equal((await db.prepare("SELECT via FROM sessions WHERE via<>'password'").get()).via, "sso:google");

  // A used state cannot be used again, and a state needs its own browser's cookie.
  assert.equal(errorOf(await signIn({ email: "hr@example.test" }, { replay: ok.state })), "expired");
  assert.equal(errorOf(await signIn({ email: "hr@example.test" }, { cookie: false })), "expired");
  // Tokens that are not right are refused.
  assert.equal(errorOf(await signIn({ email: "hr@example.test", aud: "someone-else" })), "failed");
  assert.equal(errorOf(await signIn({ email: "hr@example.test", exp: Math.floor(Date.now() / 1000) - 10 })), "failed");
  assert.equal(errorOf(await signIn({ email: "hr@example.test", email_verified: false })), "failed");
  signWith = other;
  assert.equal(errorOf(await signIn({ email: "hr@example.test" })), "failed", "signed with a key the provider does not publish");
  signWith = privateKey;
  claimsFor = () => ({ email: "hr@example.test", nonce: "not-the-one" });
  {
    const start = await fetch(`${origin}/api/sso/google/start`, { redirect: "manual" });
    const state = new URL(start.headers.get("location")).searchParams.get("state");
    const back = await fetch(`${origin}/api/sso/google/callback?code=abc&state=${state}`, { redirect: "manual", headers: { Cookie: start.headers.get("set-cookie").split(";")[0] } });
    assert.equal(new URL(back.headers.get("location"), origin).searchParams.get("sso_error"), "failed", "nonce must match");
  }
  // Only allowed domains, and only people already in the HRMS.
  assert.equal(errorOf(await signIn({ email: "hr@gmail.com" })), "domain");
  assert.equal(errorOf(await signIn({ email: "stranger@example.test" })), "no_account");
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users WHERE email='stranger@example.test'").get()).n, 0);
  // Office-only rule for staff applies to single sign-on too.
  await db.prepare(`UPDATE companies SET staff_ip_allowlist='["10.0.0.0/8"]'`).run();
  assert.equal(errorOf(await signIn({ email: "hr@example.test" })), "office_only");
});
