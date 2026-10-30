import { createHash, createHmac, randomBytes } from "node:crypto";

// Files (punch selfies, documents, resumes, chat files, photos) go to S3-compatible object
// storage when it is configured, so the database stays small: Cloudflare R2, AWS S3,
// Backblaze B2 or similar. The database column then holds "s3:<key>" instead of the
// file's base64. Without configuration everything stays in the database as before, and
// rows written either way are read the same way.
//
//   S3_ENDPOINT           https://<account>.r2.cloudflarestorage.com (or https://s3.ap-south-1.amazonaws.com)
//   S3_BUCKET             bucket name
//   S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY
//   S3_REGION             "auto" for R2 (default), e.g. ap-south-1 for AWS

const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// RFC 3986 encoding, as AWS signing expects (each path segment separately).
const encode = (s) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** AWS Signature Version 4 for one request; returns the headers to send. */
export function signRequest({ method, host, path, headers = {}, body = "", region, accessKeyId, secretAccessKey, now = new Date() }) {
  const amzDate = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const day = amzDate.slice(0, 8);
  const payloadHash = sha256(body);
  const all = { ...headers, host, "x-amz-content-sha256": payloadHash, "x-amz-date": amzDate };
  const names = Object.keys(all).map((k) => k.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const signedHeaders = names.join(";");
  const canonical = [method, path, "", names.map((n) => `${n}:${lower[n]}`).join("\n") + "\n", signedHeaders, payloadHash].join("\n");
  const scope = `${day}/${region}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), "s3"), "aws4_request");
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return {
    ...Object.fromEntries(Object.entries(all).filter(([k]) => k !== "host")),
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

export function createBlobStore(env = process.env, fetchFn = (...a) => fetch(...a)) {
  const configured = Boolean(env.S3_ENDPOINT && env.S3_BUCKET && env.S3_ACCESS_KEY_ID && env.S3_SECRET_ACCESS_KEY);
  const endpoint = configured ? new URL(env.S3_ENDPOINT) : null;
  const region = env.S3_REGION || "auto";

  async function request(method, key, body) {
    // Path-style addressing (https://endpoint/bucket/key) works with R2, S3 and B2.
    const path = `${endpoint.pathname.replace(/\/$/, "")}/${encode(env.S3_BUCKET)}/${key.split("/").map(encode).join("/")}`;
    const headers = signRequest({
      method,
      host: endpoint.host,
      path,
      headers: body ? { "content-type": "application/octet-stream" } : {},
      body: body ?? "",
      region,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    });
    const res = await fetchFn(`${endpoint.origin}${path}`, { method, headers, ...(body ? { body } : {}) });
    if (!res.ok && !(method === "DELETE" && res.status === 404))
      throw new Error(`File storage answered ${res.status} for ${method}`);
    return res;
  }

  return {
    configured,
    /** Stores a base64 file; returns what to keep in the database column. */
    async put(base64, prefix = "files") {
      if (!configured) return base64;
      const key = `${prefix}/${new Date().toISOString().slice(0, 7)}/${randomBytes(16).toString("hex")}`;
      await request("PUT", key, Buffer.from(base64, "base64"));
      return `s3:${key}`;
    },
    /** The file's bytes, wherever it is kept. */
    async bytes(data) {
      if (typeof data !== "string" || !data.startsWith("s3:")) return Buffer.from(data ?? "", "base64");
      if (!configured) throw new Error("This file is in file storage, but S3_* settings are missing.");
      return Buffer.from(await (await request("GET", data.slice(3))).arrayBuffer());
    },
    async remove(data) {
      if (configured && typeof data === "string" && data.startsWith("s3:")) await request("DELETE", data.slice(3));
    },
  };
}
