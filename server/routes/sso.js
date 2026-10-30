import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { HttpError, clientIp } from "../http.js";
import { tokenHash } from "../db.js";
import { ipAllowed, isStaff, loadRole, policyOf } from "../security-policy.js";

// Single sign-on for the web portal with Google Workspace or Microsoft 365 (OpenID Connect,
// authorization code with PKCE). Only people who already exist in the HRMS, with an email
// in SSO_ALLOWED_DOMAINS, can sign in; nobody is created. The ID token's signature (RS256,
// from the provider's published keys), issuer, audience, expiry and nonce are all checked.
//
//   SSO_ALLOWED_DOMAINS          lifc.in (comma-separated; required)
//   SSO_GOOGLE_CLIENT_ID / _SECRET
//   SSO_MICROSOFT_CLIENT_ID / _SECRET, SSO_MICROSOFT_TENANT (your tenant ID)
//   PUBLIC_URL                   https://hrms.example.com (redirect URI: /api/sso/<provider>/callback)
const PROVIDERS = {
  google: {
    label: "Google",
    discovery: () => "https://accounts.google.com/.well-known/openid-configuration",
  },
  microsoft: {
    label: "Microsoft",
    discovery: (env) =>
      `https://login.microsoftonline.com/${encodeURIComponent(env.SSO_MICROSOFT_TENANT || "organizations")}/v2.0/.well-known/openid-configuration`,
  },
};
const STATE_TTL = 10 * 60000;
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (s) => createHash("sha256").update(s).digest();

const settings = (env, id) => {
  const key = id.toUpperCase();
  const clientId = env[`SSO_${key}_CLIENT_ID`],
    secret = env[`SSO_${key}_CLIENT_SECRET`];
  const domains = String(env.SSO_ALLOWED_DOMAINS || "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (!PROVIDERS[id] || !clientId || !secret || !domains.length) return null;
  return { clientId, secret, domains, discovery: env[`SSO_${key}_DISCOVERY`] || PROVIDERS[id].discovery(env) };
};

/** Verifies an RS256 JWT against a JWKS; returns its claims or throws. */
export function verifyJwt(token, jwks) {
  const parts = String(token).split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  if (header.alg !== "RS256") throw new Error("unexpected algorithm");
  const jwk = (jwks.keys ?? []).find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!jwk) throw new Error("unknown signing key");
  const ok = verify(
    "RSA-SHA256",
    Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: "jwk" }),
    Buffer.from(parts[2], "base64url"),
  );
  if (!ok) throw new Error("bad signature");
  return JSON.parse(Buffer.from(parts[1], "base64url").toString());
}

export function registerSso(router, app, env = process.env, fetchFn = (...a) => fetch(...a)) {
  const { db, production, rateLimit } = app;
  const cache = new Map();
  const cached = async (url, ms) => {
    const hit = cache.get(url);
    if (hit && hit.until > Date.now()) return hit.value;
    const res = await fetchFn(url);
    if (!res.ok) throw new Error(`${url} answered ${res.status}`);
    const value = await res.json();
    cache.set(url, { value, until: Date.now() + ms });
    return value;
  };
  const base = (req) =>
    (env.PUBLIC_URL ? new URL(env.PUBLIC_URL).origin : `${production ? "https" : "http"}://${req.headers.host}`);
  const redirect = (res, headers, to, cookies = []) => {
    res.writeHead(302, { ...headers, Location: to, ...(cookies.length ? { "Set-Cookie": cookies } : {}) });
    res.end();
  };
  const fail = (res, headers, code) =>
    redirect(res, headers, `/?sso_error=${encodeURIComponent(code)}`, [
      `hrms_sso=; HttpOnly; SameSite=Lax; Path=/api/sso; Max-Age=0${production ? "; Secure" : ""}`,
    ]);

  router.get("/api/sso/providers", { public: true }, async ({ send }) =>
    send(200, Object.entries(PROVIDERS).filter(([id]) => settings(env, id)).map(([id, p]) => ({ id, label: p.label }))),
  );

  router.get("/api/sso/:provider/start", { public: true }, async ({ req, res, params, headers }) => {
    rateLimit(`sso:${clientIp(req)}`, 60);
    const cfg = settings(env, params.provider);
    if (!cfg) throw new HttpError(404, "This sign-in option is not set up.");
    const meta = await cached(cfg.discovery, 3600000);
    const state = b64url(randomBytes(24)),
      nonce = b64url(randomBytes(24)),
      verifier = b64url(randomBytes(32));
    await db.prepare("DELETE FROM sso_states WHERE created_at<?").run(Date.now() - STATE_TTL);
    await db
      .prepare("INSERT INTO sso_states(state_hash,provider,nonce,verifier,created_at) VALUES(?,?,?,?,?)")
      .run(tokenHash(state), params.provider, nonce, verifier, Date.now());
    const url = new URL(meta.authorization_endpoint);
    for (const [k, v] of Object.entries({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: `${base(req)}/api/sso/${params.provider}/callback`,
      scope: "openid email profile",
      state,
      nonce,
      code_challenge: b64url(sha256(verifier)),
      code_challenge_method: "S256",
      prompt: "select_account",
    }))
      url.searchParams.set(k, v);
    // The state is also tied to this browser, so a sign-in link cannot be replayed in another.
    redirect(res, headers, url.toString(), [
      `hrms_sso=${state}; HttpOnly; SameSite=Lax; Path=/api/sso; Max-Age=600${production ? "; Secure" : ""}`,
    ]);
  });

  router.get("/api/sso/:provider/callback", { public: true }, async ({ req, res, params, query, headers }) => {
    rateLimit(`sso:${clientIp(req)}`, 60);
    const cfg = settings(env, params.provider);
    if (!cfg) return fail(res, headers, "not_set_up");
    const state = String(query.get("state") ?? "");
    const cookie = /(?:^|;\s*)hrms_sso=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    if (query.get("error")) return fail(res, headers, "cancelled");
    if (!state || state !== cookie) return fail(res, headers, "expired");
    // One use only: taking the row out makes a second callback with the same state fail.
    const row = await db.prepare("SELECT * FROM sso_states WHERE state_hash=?").get(tokenHash(state));
    await db.prepare("DELETE FROM sso_states WHERE state_hash=?").run(tokenHash(state));
    if (!row || row.provider !== params.provider || Date.now() - Number(row.created_at) > STATE_TTL) return fail(res, headers, "expired");
    let claims;
    try {
      const meta = await cached(cfg.discovery, 3600000);
      const tokenRes = await fetchFn(meta.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: String(query.get("code") ?? ""),
          redirect_uri: `${base(req)}/api/sso/${params.provider}/callback`,
          client_id: cfg.clientId,
          client_secret: cfg.secret,
          code_verifier: row.verifier,
        }),
      });
      if (!tokenRes.ok) throw new Error(`token endpoint answered ${tokenRes.status}`);
      const tokens = await tokenRes.json();
      claims = verifyJwt(tokens.id_token, await cached(meta.jwks_uri, 3600000));
      // Microsoft's multi-tenant issuer has a {tenantid} placeholder.
      const issuer = String(meta.issuer).replace("{tenantid}", claims.tid ?? "");
      const now = Math.floor(Date.now() / 1000);
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (claims.iss !== issuer) throw new Error("wrong issuer");
      if (!aud.includes(cfg.clientId)) throw new Error("wrong audience");
      if (!(claims.exp > now) || (claims.iat && claims.iat > now + 300)) throw new Error("expired token");
      if (claims.nonce !== row.nonce) throw new Error("nonce mismatch");
      if (params.provider === "google" && claims.email_verified !== true) throw new Error("email not verified");
    } catch (e) {
      console.error(`SSO ${params.provider} sign-in refused: ${e.message}`);
      return fail(res, headers, "failed");
    }
    const email = String(claims.email || claims.preferred_username || "").trim().toLowerCase();
    if (!cfg.domains.includes(email.split("@")[1] ?? "")) return fail(res, headers, "domain");
    const user = await db
      .prepare("SELECT u.* FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? AND u.active=1 AND c.active=1")
      .get(email);
    if (!user) return fail(res, headers, "no_account");
    await loadRole(db, user);
    const policy = policyOf(await db.prepare("SELECT staff_ip_allowlist FROM companies WHERE id=?").get(user.company_id));
    if (isStaff(user) && !ipAllowed(clientIp(req), policy.staff_ip_allowlist)) {
      await app.audit(user, "login_blocked_ip", { ip: clientIp(req), via: params.provider });
      return fail(res, headers, "office_only");
    }
    const token = randomBytes(32).toString("hex");
    await db
      .prepare("INSERT INTO sessions(token_hash,user_id,expires_at,created_at,ip,agent,native,last_seen_at,via) VALUES(?,?,?,?,?,?,0,?,?)")
      .run(
        tokenHash(token),
        user.id,
        Date.now() + 86400000,
        new Date(app.clock()).toISOString(),
        clientIp(req),
        String(req.headers["user-agent"] ?? "").slice(0, 200),
        app.clock(),
        `sso:${params.provider}`,
      );
    await app.audit(user, "login", { via: params.provider });
    // A page that moves on to the portal itself: arriving straight from the provider's
    // site, the browser would not send the new (SameSite=Strict) session cookie yet.
    res.writeHead(200, {
      ...headers,
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": [
        `hrms_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${production ? "; Secure" : ""}`,
        `hrms_sso=; HttpOnly; SameSite=Lax; Path=/api/sso; Max-Age=0${production ? "; Secure" : ""}`,
      ],
    });
    res.end('<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/"><title>Signing in</title><p>Signing you in… <a href="/">Continue</a></p>');
  });
}
