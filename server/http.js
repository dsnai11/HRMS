export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function string(value, label, max = 150) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      `${label} is required (maximum ${max} characters).`,
    );
  return value.trim();
}
// Optional text: undefined/null/"" mean "not provided" and return null.
export function optionalString(value, label, max = 150) {
  if (value === undefined || value === null || value === "") return null;
  return string(value, label, max);
}
export function password(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    throw new HttpError(400, "Password must contain 12–128 characters.");
  return value;
}
export function number(value, label, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
export function integer(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, "Invalid identifier.");
  return value;
}
export function optionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, `${label} is invalid.`);
  return value;
}
export function email(value) {
  const e = string(value, "Email", 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    throw new HttpError(400, "Enter a valid email.");
  return e;
}
export function isoDate(value, label) {
  const v = optionalString(value, label, 10);
  if (v === null) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(v) ||
    Number.isNaN(Date.parse(v)) ||
    new Date(v).toISOString().slice(0, 10) !== v
  )
    throw new HttpError(400, `${label} must be a valid date (YYYY-MM-DD).`);
  return v;
}
export function oneOf(value, label, allowed) {
  if (!allowed.includes(value))
    throw new HttpError(400, `${label} must be one of: ${allowed.join(", ")}.`);
  return value;
}
export async function readBody(req, limit = 16384) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > limit) throw new HttpError(413, "Request is too large.");
  }
  let parsed;
  try {
    parsed = JSON.parse(body || "{}");
  } catch {
    throw new HttpError(400, "Invalid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpError(400, "Expected a JSON object.");
  return parsed;
}
export function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}

// The caller's address for rate limiting. Behind a reverse proxy the socket
// address is the proxy's, so read X-Forwarded-For, trusting only the last
// `hops` entries that our own proxies appended (earlier ones are client-supplied).
export function clientIp(req, env = process.env) {
  const hops = Number(env.TRUST_PROXY_HOPS ?? (env.RENDER ? 1 : 0));
  if (hops > 0) {
    const chain = String(req.headers["x-forwarded-for"] || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean);
    const ip = chain[chain.length - hops];
    if (ip) return ip;
  }
  return req.socket.remoteAddress;
}
