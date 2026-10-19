import { createHash, randomBytes } from "node:crypto";
import { HttpError, integer, string } from "../http.js";
import { passwordMatches, tokenHash } from "../db.js";
import { decryptJson, encryptJson, encryptionKey } from "../crypto-store.js";
import { newSecret, otpauthUri, verify } from "../totp.js";

const sha = (s) => createHash("sha256").update(s).digest("hex");

export function registerSecurity(router, app) {
  const { db, transaction, clock } = app;
  const key = () => {
    const k = encryptionKey();
    if (!k)
      throw new HttpError(
        503,
        "Two-factor login needs DATA_ENCRYPTION_KEY to be set on the server.",
      );
    return k;
  };

  router.get("/api/2fa", async ({ user, send }) =>
    send(200, {
      enabled: Boolean(user.totp_enabled),
      recovery_codes_left: user.totp_recovery
        ? JSON.parse(user.totp_recovery).length
        : 0,
      available: Boolean(encryptionKey()),
    }),
  );
  // Step 1: a secret to add to the authenticator app. Nothing changes until a code is confirmed.
  router.post("/api/2fa/setup", async ({ user, send }) => {
    if (user.totp_enabled)
      throw new HttpError(409, "Two-factor login is already on.");
    const secret = newSecret();
    await db
      .prepare("UPDATE users SET totp_pending=? WHERE id=?")
      .run(encryptJson(secret, key()), user.id);
    return send(200, { secret, uri: otpauthUri(secret, user.email, "HRMS") });
  });
  // Step 2: confirm a code, switch it on and hand over one-time recovery codes.
  router.post("/api/2fa/enable", async ({ user, body, send, audit }) => {
    if (!user.totp_pending) throw new HttpError(409, "Start the setup first.");
    const secret = decryptJson(user.totp_pending, key());
    const step = verify(secret, (await body()).code, clock());
    if (step === null)
      throw new HttpError(
        400,
        "That code is not right. Check the time on your phone and try again.",
      );
    const codes = Array.from({ length: 8 }, () =>
      randomBytes(5).toString("hex"),
    );
    await transaction(async () => {
      await db
        .prepare(
          "UPDATE users SET totp_secret=?,totp_pending=NULL,totp_enabled=1,totp_recovery=?,totp_last_step=? WHERE id=?",
        )
        .run(user.totp_pending, JSON.stringify(codes.map(sha)), step, user.id);
      await audit("2fa_enabled", {});
    });
    return send(200, { recovery_codes: codes });
  });
  router.post("/api/2fa/disable", async ({ user, body, send, audit }) => {
    if (!user.totp_enabled)
      throw new HttpError(409, "Two-factor login is not on.");
    const b = await body();
    app.rateLimit(`password:${user.id}`, 10);
    if (!passwordMatches(String(b.password ?? ""), user.password_hash))
      throw new HttpError(403, "Password is incorrect.");
    await db
      .prepare(
        "UPDATE users SET totp_secret=NULL,totp_pending=NULL,totp_enabled=0,totp_recovery=NULL,totp_last_step=NULL WHERE id=?",
      )
      .run(user.id);
    await audit("2fa_disabled", {});
    return send(200, { ok: true });
  });
  // An administrator can switch it off for someone who lost their phone.
  router.post(
    "/api/admin/employees/:id/2fa-reset",
    { perm: "roles.assign" },
    async ({ params, companyId, send, audit }) => {
      const id = integer(Number(params.id));
      const p = await db
        .prepare("SELECT id FROM users WHERE id=? AND company_id=?")
        .get(id, companyId);
      if (!p) throw new HttpError(404, "Employee not found.");
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE users SET totp_secret=NULL,totp_pending=NULL,totp_enabled=0,totp_recovery=NULL,totp_last_step=NULL WHERE id=?",
          )
          .run(id);
        await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
        await audit("2fa_reset", { employeeId: id });
      });
      return send(200, { ok: true });
    },
  );

  // ---- sessions -------------------------------------------------------------------------------------
  router.get("/api/sessions", async ({ user, token, send }) => {
    const rows = await db
      .prepare(
        "SELECT id,token_hash,created_at,ip,agent,expires_at FROM sessions WHERE user_id=? AND expires_at>? ORDER BY id DESC",
      )
      .all(user.id, Date.now());
    const mine = tokenHash(token);
    return send(
      200,
      rows.map((r) => ({
        id: r.id,
        created_at: r.created_at,
        ip: r.ip,
        agent: r.agent,
        current: r.token_hash === mine,
      })),
    );
  });
  router.delete("/api/sessions/:id", async ({ user, params, send, audit }) => {
    await db
      .prepare("DELETE FROM sessions WHERE id=? AND user_id=?")
      .run(integer(Number(params.id)), user.id);
    await audit("session_revoked", {});
    return send(200, { ok: true });
  });
  router.post(
    "/api/sessions/revoke-others",
    async ({ user, token, send, audit }) => {
      await db
        .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
        .run(user.id, tokenHash(token));
      await audit("sessions_revoked_others", {});
      return send(200, { ok: true });
    },
  );
}

/** For login: returns true if the supplied code is valid, consuming a recovery code or time step. */
export async function checkSecondFactor(app, user, code) {
  const c = String(code ?? "")
    .trim()
    .toLowerCase();
  if (!c) return false;
  const k = encryptionKey();
  if (!k || !user.totp_secret) return false;
  if (/^\d{6}$/.test(c)) {
    const step = verify(decryptJson(user.totp_secret, k), c, app.clock());
    if (step === null || step <= (user.totp_last_step ?? 0)) return false; // a code works once
    await app.db
      .prepare("UPDATE users SET totp_last_step=? WHERE id=?")
      .run(step, user.id);
    return true;
  }
  const codes = JSON.parse(user.totp_recovery ?? "[]");
  const hit = codes.indexOf(sha(c));
  if (hit < 0) return false;
  codes.splice(hit, 1);
  await app.db
    .prepare("UPDATE users SET totp_recovery=? WHERE id=?")
    .run(JSON.stringify(codes), user.id);
  return true;
}
