import { randomBytes, timingSafeEqual } from "node:crypto";
import { tokenHash } from "./db.js";
import { HttpError } from "./http.js";

const text = (value, max) =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const secretMatches = (secret, hash) =>
  typeof secret === "string" &&
  secret.length <= 128 &&
  timingSafeEqual(Buffer.from(tokenHash(secret)), Buffer.from(hash));

// Binds a person's phone to their account. New phones wait for an
// administrator's approval before they can record attendance.
export async function bindDevice(app, user, input) {
  const { db, audit, transaction } = app;
  const id = input && typeof input === "object" ? input.id : null;
  if (typeof id !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(id))
    throw new HttpError(
      400,
      "Update the mobile app to sign in.",
      "device_required",
    );
  const platform = text(input.platform, 20),
    model = text(input.model, 60);
  return await transaction(async () => {
    const row = await db
      .prepare("SELECT * FROM devices WHERE user_id=? AND device_id=?")
      .get(user.id, id);
    const now = new Date().toISOString();
    if (!row || row.status === "revoked") {
      if (
        await db
          .prepare(
            "SELECT id FROM devices WHERE device_id=? AND user_id<>? AND status<>'revoked'",
          )
          .get(id, user.id)
      ) {
        await audit(user, "device_conflict", { platform, model });
        throw new HttpError(
          409,
          "This phone is registered to another account. Contact your administrator.",
          "device_conflict",
        );
      }
      const secret = randomBytes(32).toString("hex");
      if (row)
        await db
          .prepare(
            "UPDATE devices SET secret_hash=?,status='pending',platform=?,model=?,registered_at=?,last_seen_at=?,decided_by=NULL,decided_at=NULL WHERE id=?",
          )
          .run(tokenHash(secret), platform, model, now, now, row.id);
      else
        await db
          .prepare(
            "INSERT INTO devices(user_id,device_id,platform,model,secret_hash,status,registered_at,last_seen_at) VALUES(?,?,?,?,?,'pending',?,?)",
          )
          .run(user.id, id, platform, model, tokenHash(secret), now, now);
      await audit(user, "device_registered", { platform, model });
      return { status: "pending", secret };
    }
    if (!secretMatches(input.secret, row.secret_hash))
      throw new HttpError(
        409,
        "This phone's registration key is missing. Ask your administrator to remove the device so you can register it again.",
        "device_key_missing",
      );
    await db
      .prepare("UPDATE devices SET last_seen_at=? WHERE id=?")
      .run(now, row.id);
    return { status: row.status };
  });
}

export async function deviceFromHeaders(app, user, req) {
  const id = req.headers["x-device-id"],
    secret = req.headers["x-device-secret"];
  if (typeof id !== "string" || typeof secret !== "string") return null;
  const row = await app.db
    .prepare("SELECT * FROM devices WHERE user_id=? AND device_id=?")
    .get(user.id, id.slice(0, 64));
  return row && secretMatches(secret, row.secret_hash) ? row : null;
}
