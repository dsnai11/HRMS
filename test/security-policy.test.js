import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { ipAllowed, parseAllowlist } from "../server/security-policy.js";

test("office address lists accept single addresses and ranges, IPv4 and IPv6", () => {
  const list = parseAllowlist(["203.0.113.0/24", " 198.51.100.7 ", "2001:db8::/32", ""]);
  assert.deepEqual(list, ["203.0.113.0/24", "198.51.100.7", "2001:db8::/32"]);
  assert.ok(ipAllowed("203.0.113.99", list));
  assert.ok(ipAllowed("::ffff:198.51.100.7", list));
  assert.ok(ipAllowed("2001:db8:1::5", list));
  assert.ok(!ipAllowed("198.51.100.8", list));
  assert.ok(ipAllowed("1.2.3.4", []), "an empty list allows anywhere");
  for (const bad of ["300.1.1.1", "10.0.0.0/33", "office", "1.2.3.4/8/1"])
    assert.throws(() => parseAllowlist([bad]), /not an address/);
});

test("security policy: office-only staff, idle sign-out, password expiry and required two-factor login", async (t) => {
  const original = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  t.after(() =>
    original === undefined ? delete process.env.DATA_ENCRYPTION_KEY : (process.env.DATA_ENCRYPTION_KEY = original),
  );
  let nowMs = Date.parse("2026-11-02T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, auth = {}, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(auth.token ? { Authorization: `Bearer ${auth.token}` } : {}),
        ...(auth.cookie ? { Cookie: auth.cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json(), cookie: res.headers.get("set-cookie")?.split(";")[0] };
  };
  // A browser sign-in: the session is a cookie.
  const web = async (email, password) => {
    const r = await call("/login", { email, password });
    return { ...r, cookie: r.cookie };
  };
  const owner = await web("owner@example.test", "Owner-password-123");
  assert.equal(owner.status, 200);
  const admin = { cookie: owner.cookie };
  const add = async (name, role) => {
    const r = await call("/admin/employees", { name, email: `${name}@example.test`, password: "Temporary-pass-123", role }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return r.data.id;
  };
  await add("hr", "hr");
  await add("emp", "employee");
  const PW = "Temporary-pass-123";

  // An admin cannot save a list that would lock themselves out. (The first account is a
  // super administrator, which the list never limits, so the company cannot be locked out.)
  await add("boss", "admin");
  const boss = { cookie: (await web("boss@example.test", "Temporary-pass-123")).cookie };
  const lock = await call("/admin/security-policy", { staff_ip_allowlist: ["10.0.0.0/8"] }, boss, "PATCH");
  assert.equal(lock.status, 400);
  assert.match(lock.data.error, /Your own address/);
  assert.equal((await call("/admin/security-policy", { staff_ip_allowlist: ["127.0.0.1", "10.0.0.0/8"] }, admin, "PATCH")).status, 200);
  assert.equal((await web("hr@example.test", PW)).status, 200, "inside the office list");
  const hrSession = await web("hr@example.test", PW);

  // Outside the office (as if the office moved): staff are refused on the web, employees and phones are not.
  await db.prepare(`UPDATE companies SET staff_ip_allowlist='["10.0.0.0/8"]'`).run();
  const blocked = await web("hr@example.test", PW);
  assert.deepEqual([blocked.status, blocked.data.code], [403, "ip_blocked"]);
  assert.equal((await call("/me", undefined, { cookie: hrSession.cookie })).status, 403, "an open browser session is stopped too");
  assert.equal((await web("emp@example.test", PW)).status, 200);
  const phone = await call("/login", { email: "hr@example.test", password: PW, native: true, device: { id: "hr-phone-000000001", platform: "android", model: "T" } });
  assert.equal(phone.status, 200);
  assert.equal((await call("/me", undefined, { token: phone.data.token })).status, 200);
  await db.prepare(`UPDATE companies SET staff_ip_allowlist='[]'`).run();

  // Idle browsers are signed out; activity keeps a session alive.
  assert.equal((await call("/admin/security-policy", { idle_minutes: 3 }, admin, "PATCH")).status, 400);
  assert.equal((await call("/admin/security-policy", { idle_minutes: 15 }, admin, "PATCH")).status, 200);
  const emp = await web("emp@example.test", PW);
  nowMs += 10 * 60000;
  assert.equal((await call("/me", undefined, { cookie: emp.cookie })).status, 200);
  nowMs += 10 * 60000;
  assert.equal((await call("/me", undefined, { cookie: emp.cookie })).status, 200, "10 minutes after the last activity");
  nowMs += 16 * 60000;
  const idle = await call("/me", undefined, { cookie: emp.cookie });
  assert.deepEqual([idle.status, idle.data.code], [401, "idle"]);
  assert.equal((await call("/me", undefined, { cookie: emp.cookie })).status, 401, "the session is gone");
  assert.equal((await call("/me", undefined, { token: phone.data.token })).status, 200, "phones are not signed out");
  await call("/admin/security-policy", { idle_minutes: 0 }, { cookie: (await web("owner@example.test", "Owner-password-123")).cookie }, "PATCH");

  // Passwords expire: the first sign-in starts the clock, a later one asks for a new password.
  const fresh = { cookie: (await web("owner@example.test", "Owner-password-123")).cookie };
  assert.equal((await call("/admin/security-policy", { password_max_days: 30 }, fresh, "PATCH")).status, 200);
  assert.equal((await web("emp@example.test", PW)).data.user.must_change_password, false);
  nowMs += 31 * 86400000;
  const expired = await web("emp@example.test", PW);
  assert.equal(expired.data.user.must_change_password, true);
  const changed = await call("/password", { currentPassword: PW, newPassword: "Brand-new-pass-456" }, { cookie: expired.cookie });
  assert.equal(changed.status, 200, JSON.stringify(changed.data));
  assert.equal((await web("emp@example.test", "Brand-new-pass-456")).data.user.must_change_password, false);

  // Required two-factor login: staff can only set it up until it is on; employees are not affected.
  const admin2 = { cookie: (await web("owner@example.test", "Owner-password-123")).cookie };
  assert.equal((await call("/admin/security-policy", { password_max_days: 0, require_staff_2fa: true }, admin2, "PATCH")).status, 200);
  const hr = { cookie: (await web("hr@example.test", PW)).cookie };
  assert.equal((await call("/me", undefined, hr)).data.needs_2fa, true);
  const stopped = await call("/admin/employees", undefined, hr);
  assert.deepEqual([stopped.status, stopped.data.code], [403, "totp_setup_required"]);
  assert.equal((await call("/2fa/setup", {}, hr)).status, 200);
  const empNow = { cookie: (await web("emp@example.test", "Brand-new-pass-456")).cookie };
  assert.equal((await call("/me", undefined, empNow)).data.needs_2fa, undefined);
  assert.equal((await call("/admin/security-policy", undefined, admin2)).data.require_staff_2fa, true);
});
