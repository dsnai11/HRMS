import { createHmac, randomBytes } from "node:crypto";

// RFC 6238 time-based one-time passwords (SHA-1, 6 digits, 30 seconds), as used
// by Google Authenticator, Microsoft Authenticator and similar apps.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const newSecret = () => base32(randomBytes(20));
export function base32(buf) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}
function unbase32(text) {
  let bits = 0,
    value = 0;
  const out = [];
  for (const c of text.replace(/=+$/, "").toUpperCase()) {
    const i = ALPHABET.indexOf(c);
    if (i < 0) throw new Error("Invalid secret.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
export function hotp(secret, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  const code =
    ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1000000).padStart(6, "0");
}
export const stepOf = (nowMs) => Math.floor(nowMs / 30000);
/** Returns the matching time step (so it can be refused if replayed), or null. */
export function verify(secret, code, nowMs, window = 1) {
  if (!/^\d{6}$/.test(String(code ?? ""))) return null;
  const step = stepOf(nowMs);
  for (let d = -window; d <= window; d++)
    if (hotp(secret, step + d) === code) return step + d;
  return null;
}
export const otpauthUri = (secret, account, issuer) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&digits=6&period=30`;
