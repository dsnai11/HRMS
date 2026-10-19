import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Field-level encryption for sensitive personal data (bank account, PAN, UAN).
// AES-256-GCM with a key from DATA_ENCRYPTION_KEY (32 bytes, base64). Without a
// key the data is simply not stored; there is no plaintext fallback.
export function encryptionKey(env = process.env) {
  const raw = env.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32)
    throw new Error(
      "DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32).",
    );
  return key;
}

export function encryptJson(value, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return ["v1", iv, cipher.getAuthTag(), body]
    .map((p) => (Buffer.isBuffer(p) ? p.toString("base64url") : p))
    .join(".");
}

export function decryptJson(text, key) {
  const [version, iv, tag, body] = text.split(".");
  if (version !== "v1") throw new Error("Unknown encryption format.");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(iv, "base64url"),
  );
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(body, "base64url")),
      decipher.final(),
    ]).toString("utf8"),
  );
}

export const mask = (value) =>
  typeof value === "string" && value.length > 4
    ? `${"•".repeat(value.length - 4)}${value.slice(-4)}`
    : value
      ? "••••"
      : "";
