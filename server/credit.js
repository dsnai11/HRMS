import dns from "node:dns/promises";
import net from "node:net";

export const RISK_LABEL = {
  low: "Low risk",
  medium: "Medium risk",
  high: "High risk",
};
export const DEFAULT_CONSENT =
  "I authorise the company and its credit-information partner to obtain my credit information report and score from a credit bureau (such as CIBIL) for the purpose of assessing my suitability for employment. I understand the report will be used only for this purpose and that I may ask HR how it was used.";

export const riskOf = (score, s) =>
  score >= s.low_min ? "low" : score >= s.medium_min ? "medium" : "high";

const privateAddress = (ip) => {
  if (net.isIPv6(ip))
    return /^(::1?$|f[cd]|fe[89ab]|::ffff:(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.))/i.test(
      ip,
    );
  const [a, b] = ip.split(".").map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127)
  );
};

/** The provider URL is set by an administrator, but must still be a public https address. */
export async function assertPublicHttps(urlText, env = process.env) {
  let u;
  try {
    u = new URL(urlText);
  } catch {
    throw new Error("The provider address is not a valid web address.");
  }
  if (env.CREDIT_ALLOW_PRIVATE === "1") return u;
  if (u.protocol !== "https:")
    throw new Error("The provider address must start with https://.");
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    throw new Error("The provider address must be a public website.");
  const addrs = net.isIP(host)
    ? [{ address: host }]
    : await dns.lookup(host, { all: true }).catch(() => {
        throw new Error("The provider address could not be found.");
      });
  if (addrs.some((a) => privateAddress(a.address)))
    throw new Error("The provider address must be a public website.");
  return u;
}

/** Reads a value from a JSON object by a path like "data.cibil.score" or "reports[0].score". */
export function pick(obj, path) {
  return path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean)
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

/** Fills {{pan}}, {{name}}, {{dob}}, {{phone}}, {{email}} into a JSON template safely. */
export function fillTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
    JSON.stringify(String(vars[k] ?? "")).slice(1, -1),
  );
}

export async function callProvider(settings, apiKey, vars, fetchImpl = fetch) {
  const u = await assertPublicHttps(settings.url);
  const method = settings.method === "GET" ? "GET" : "POST";
  const headers = { Accept: "application/json" };
  if (apiKey) headers[settings.auth_header || "Authorization"] = apiKey;
  const init = {
    method,
    headers,
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    init.body = fillTemplate(
      settings.body_template || '{"pan":"{{pan}}"}',
      vars,
    );
  } else {
    for (const [k, v] of Object.entries(vars)) if (v) u.searchParams.set(k, v);
  }
  const res = await fetchImpl(u, init);
  const text = await res.text();
  if (!res.ok)
    throw new Error(`The bureau answered with status ${res.status}.`);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The bureau's answer was not JSON.");
  }
  const raw = pick(json, settings.score_path || "score");
  const score = Number(raw);
  if (!Number.isFinite(score) || score < 0 || score > 900)
    throw new Error(
      "The bureau's answer did not contain a credit score where expected.",
    );
  return { score: Math.round(score), json };
}
