import { createSign } from "node:crypto";

// Sends phone notifications through Firebase Cloud Messaging (HTTP v1). Switched on by
// setting FCM_SERVICE_ACCOUNT to the Firebase service-account key (the JSON, as text).
// Without it nothing is sent and nothing breaks.
const b64 = (v) =>
  Buffer.from(typeof v === "string" ? v : JSON.stringify(v)).toString(
    "base64url",
  );

export function createPush(
  app,
  env = process.env,
  fetchFn = (...a) => fetch(...a),
) {
  const { db } = app;
  let account = null;
  try {
    account = env.FCM_SERVICE_ACCOUNT
      ? JSON.parse(env.FCM_SERVICE_ACCOUNT)
      : null;
  } catch {
    console.error(
      "FCM_SERVICE_ACCOUNT is not valid JSON; push notifications are off.",
    );
  }
  if (
    account &&
    !(account.client_email && account.private_key && account.project_id)
  ) {
    console.error(
      "FCM_SERVICE_ACCOUNT is missing client_email, private_key or project_id; push is off.",
    );
    account = null;
  }
  let cached = { token: null, until: 0 };

  async function accessToken() {
    if (cached.token && Date.now() < cached.until) return cached.token;
    const now = Math.floor(Date.now() / 1000);
    const claim = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({
      iss: account.client_email,
      scope: "https://www.googleapis.com/auth/firebase.messaging",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign("RSA-SHA256")
      .update(claim)
      .sign(account.private_key, "base64url");
    const res = await fetchFn("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${claim}.${signature}`,
      }),
    });
    if (!res.ok) throw new Error(`Google sign-in answered ${res.status}`);
    const data = await res.json();
    cached = {
      token: data.access_token,
      until: Date.now() + (data.expires_in - 120) * 1000,
    };
    return cached.token;
  }

  /** Push to every phone a person has registered. Failures are logged, never thrown. */
  return async function push(userIds, { title, body, link }) {
    if (!account || !userIds.length) return 0;
    try {
      const rows = await db
        .prepare(
          `SELECT id,token FROM push_tokens WHERE user_id IN (${userIds.map(() => "?").join(",")})`,
        )
        .all(...userIds);
      if (!rows.length) return 0;
      const bearer = await accessToken();
      let sent = 0;
      for (const row of rows) {
        const res = await fetchFn(
          `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              message: {
                token: row.token,
                notification: {
                  title: String(title).slice(0, 100),
                  ...(body ? { body: String(body).slice(0, 200) } : {}),
                },
                data: { link: link ?? "" },
                android: {
                  priority: "HIGH",
                  notification: { channel_id: "default" },
                },
              },
            }),
          },
        );
        if (res.ok) sent++;
        // A phone that uninstalled the app or changed token: forget it.
        else if ([404, 400].includes(res.status)) {
          const detail = await res.text();
          if (/UNREGISTERED|NOT_FOUND|INVALID_ARGUMENT/.test(detail))
            await db.prepare("DELETE FROM push_tokens WHERE id=?").run(row.id);
        }
      }
      return sent;
    } catch (e) {
      console.error("push failed:", e.message);
      return 0;
    }
  };
}
