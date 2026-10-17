import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  openDatabase,
  openConfiguredDatabase,
  createAdmin,
  passwordHash,
  passwordMatches,
  tokenHash,
} from "./db.js";
import { checkLocation, HttpError } from "./geo.js";
import { assessPunch, parseSignals } from "./risk.js";
import { loadPolicy, evaluatePunchIn, halfDayReasons } from "./policy.js";
const publicDir = new URL("../public/", import.meta.url);
const dummyHash = passwordHash("unused-password-for-timing");
const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  workplace_id: u.workplace_id,
  active: Boolean(u.active),
  must_change_password: Boolean(u.must_change_password),
});
function string(value, label, max = 150) {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new HttpError(
      400,
      `${label} is required (maximum ${max} characters).`,
    );
  return value.trim();
}
function password(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    throw new HttpError(400, "Password must contain 12–128 characters.");
  return value;
}
function number(value, label, min, max) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new HttpError(400, `${label} must be between ${min} and ${max}.`);
  return value;
}
function integer(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new HttpError(400, "Invalid identifier.");
  return value;
}
async function readBody(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 16384) throw new HttpError(413, "Request is too large.");
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
function csvCell(value) {
  let s = String(value ?? "");
  if (/^[=+\-@\t\r\n]/.test(s)) s = `'${s}`;
  return `"${s.replaceAll('"', '""')}"`;
}
export function createApp({
  db = openDatabase(process.env.DATABASE_PATH || "./data/hrms.sqlite"),
  production = process.env.NODE_ENV === "production",
  company = process.env.COMPANY_NAME || "Laxmi India Finance Ltd.",
  timezone = process.env.REPORT_TIMEZONE || "Asia/Kolkata",
  policy = loadPolicy(),
  clock = Date.now,
} = {}) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const dayOf = (iso) => formatter.format(new Date(iso));
  const limits = new Map();
  function rateLimit(key, max, window = 900000) {
    const now = Date.now();
    for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    const limit = limits.get(key) || {
      count: 0,
      until: now + window,
    };
    limit.count++;
    limits.set(key, limit);
    if (limit.count > max)
      throw new HttpError(
        429,
        "Too many attempts. Please wait 15 minutes and retry.",
      );
  }
  const audit = async (actor, action, detail) =>
    await db
      .prepare(
        "INSERT INTO audit(actor_id,action,detail,created_at) VALUES(?,?,?,?)",
      )
      .run(actor, action, JSON.stringify(detail), new Date().toISOString());
  const transaction = (fn) => db.transaction(fn);

  const deviceText = (value, max) =>
    typeof value === "string" && value.trim()
      ? value.trim().slice(0, max)
      : null;
  const secretMatches = (secret, hash) =>
    typeof secret === "string" &&
    secret.length <= 128 &&
    timingSafeEqual(Buffer.from(tokenHash(secret)), Buffer.from(hash));
  // Binds an employee's phone to their account. New phones wait for an
  // administrator's approval before they can record attendance.
  async function bindDevice(user, input) {
    const id = input && typeof input === "object" ? input.id : null;
    if (typeof id !== "string" || !/^[A-Za-z0-9-]{16,64}$/.test(id))
      throw new HttpError(
        400,
        "Update the mobile app to sign in as an employee.",
        "device_required",
      );
    const platform = deviceText(input.platform, 20),
      model = deviceText(input.model, 60);
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
          await audit(user.id, "device_conflict", { platform, model });
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
        await audit(user.id, "device_registered", { platform, model });
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
  const deviceFromHeaders = async (user, req) => {
    const id = req.headers["x-device-id"],
      secret = req.headers["x-device-secret"];
    if (typeof id !== "string" || typeof secret !== "string") return null;
    const row = await db
      .prepare("SELECT * FROM devices WHERE user_id=? AND device_id=?")
      .get(user.id, id.slice(0, 64));
    return row && secretMatches(secret, row.secret_hash) ? row : null;
  };
  async function recordPunchEvent(user, event) {
    const finite = (n) => (Number.isFinite(n) ? n : null);
    await db
      .prepare(
        "INSERT INTO punch_events(user_id,shift_id,action,outcome,reason,flags,device_row_id,latitude,longitude,accuracy,signals,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        user.id,
        event.shiftId ?? null,
        event.action,
        event.outcome,
        event.reason ?? null,
        JSON.stringify(event.flags || []),
        event.deviceId ?? null,
        finite(event.location?.latitude),
        finite(event.location?.longitude),
        finite(event.location?.accuracy),
        JSON.stringify(event.signals || {}),
        new Date(clock()).toISOString(),
      );
  }
  const handle = async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
    };
    if (production) headers["Strict-Transport-Security"] = "max-age=31536000";
    const send = (status, data, extra = {}) => {
      res.writeHead(status, {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        ...extra,
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, "http://localhost");
      const path = url.pathname;
      const method = req.method;
      if (path === "/health" && method === "GET") {
        await db.prepare("SELECT 1").get();
        return send(200, {
          ok: true,
        });
      }
      if (!path.startsWith("/api/")) {
        if (method !== "GET") throw new HttpError(405, "Method not allowed.");
        const files = {
          "/": ["index.html", "text/html"],
          "/app.js": ["app.js", "text/javascript"],
          "/styles.css": ["styles.css", "text/css"],
        };
        if (!files[path]) throw new HttpError(404, "Not found.");
        const [file, type] = files[path];
        const content = await readFile(new URL(file, publicDir));
        res.writeHead(200, {
          ...headers,
          "Content-Type": `${type}; charset=utf-8`,
        });
        return res.end(content);
      }
      if (!["GET", "POST", "PATCH"].includes(method))
        throw new HttpError(405, "Method not allowed.");
      // Browser requests must be same-origin. Native requests do not carry Origin.
      if (req.headers.origin) {
        const expected = process.env.PUBLIC_URL
          ? new URL(process.env.PUBLIC_URL).origin
          : `${production ? "https" : "http"}://${req.headers.host}`;
        if (req.headers.origin !== expected)
          throw new HttpError(403, "Cross-origin request rejected.");
      }
      if (
        method !== "GET" &&
        !req.headers["content-type"]?.startsWith("application/json")
      )
        throw new HttpError(415, "Use application/json.");
      if (path === "/api/config" && method === "GET")
        return send(200, {
          company,
          timezone,
          setupRequired:
            Boolean(process.env.SETUP_TOKEN) &&
            !(await db
              .prepare("SELECT id FROM users WHERE role='admin'")
              .get()),
        });
      if (path === "/api/setup" && method === "POST") {
        rateLimit(`setup:${req.socket.remoteAddress}`, 10);
        const body = await readBody(req);
        if (
          !process.env.SETUP_TOKEN ||
          typeof body.setupToken !== "string" ||
          !timingSafeEqual(
            Buffer.from(tokenHash(body.setupToken)),
            Buffer.from(tokenHash(process.env.SETUP_TOKEN)),
          )
        )
          throw new HttpError(403, "Invalid setup code.");
        if (await db.prepare("SELECT id FROM users WHERE role='admin'").get())
          throw new HttpError(409, "Administrator setup is already complete.");
        const name = string(body.name, "Name");
        const email = string(body.email, "Email", 254).toLowerCase();
        const pw = password(body.password);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new HttpError(400, "Enter a valid email.");
        await transaction(async () => {
          await createAdmin(db, {
            name,
            email,
            password: pw,
          });
          await audit(null, "administrator_created", {});
        });
        return send(201, {
          ok: true,
        });
      }
      if (path === "/api/login" && method === "POST") {
        const body = await readBody(req);
        const email = string(body.email, "Email", 254).toLowerCase();
        const pw =
          typeof body.password === "string" && body.password.length <= 128
            ? body.password
            : "";
        rateLimit(`ip:${req.socket.remoteAddress}`, 100);
        rateLimit(`email:${email}`, 10);
        const user = await db
          .prepare("SELECT * FROM users WHERE email=?")
          .get(email);
        const valid = passwordMatches(pw, user?.password_hash || dummyHash);
        if (!valid || !user?.active)
          throw new HttpError(401, "Email or password is incorrect.");
        const device =
          body.native === true && user.role === "employee"
            ? await bindDevice(user, body.device)
            : null;
        const token = randomBytes(32).toString("hex");
        await db
          .prepare("DELETE FROM sessions WHERE expires_at < ?")
          .run(Date.now());
        await db
          .prepare("INSERT INTO sessions VALUES(?,?,?)")
          .run(tokenHash(token), user.id, Date.now() + 86400000);
        await audit(user.id, "login", {});
        return send(
          200,
          {
            user: safeUser(user),
            ...(body.native === true
              ? {
                  token,
                }
              : {}),
            ...(device
              ? {
                  device: { status: device.status },
                  ...(device.secret ? { deviceSecret: device.secret } : {}),
                }
              : {}),
          },
          {
            "Set-Cookie": `hrms_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400${production ? "; Secure" : ""}`,
          },
        );
      }
      const token = req.headers.authorization?.startsWith("Bearer ")
        ? req.headers.authorization.slice(7)
        : /(?:^|;\s*)hrms_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
      const user =
        token &&
        (await db
          .prepare(
            "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1",
          )
          .get(tokenHash(token), Date.now()));
      if (!user) throw new HttpError(401, "Please sign in again.");
      if (path === "/api/logout" && method === "POST") {
        await db
          .prepare("DELETE FROM sessions WHERE token_hash=?")
          .run(tokenHash(token));
        return send(
          200,
          {
            ok: true,
          },
          {
            "Set-Cookie": `hrms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`,
          },
        );
      }
      if (path === "/api/me" && method === "GET") {
        return send(200, {
          user: safeUser(user),
          workplace: user.workplace_id
            ? await db
                .prepare("SELECT * FROM workplaces WHERE id=?")
                .get(user.workplace_id)
            : null,
          openShift:
            (await db
              .prepare(
                "SELECT * FROM shifts WHERE user_id=? AND out_at IS NULL",
              )
              .get(user.id)) || null,
          device: await deviceFromHeaders(user, req).then((d) =>
            d ? { status: d.status } : null,
          ),
        });
      }
      if (path === "/api/password" && method === "POST") {
        rateLimit(`password:${user.id}`, 10);
        const body = await readBody(req);
        const next = password(body.newPassword);
        if (
          typeof body.currentPassword !== "string" ||
          body.currentPassword.length > 128 ||
          !passwordMatches(body.currentPassword, user.password_hash)
        )
          throw new HttpError(400, "Current password is incorrect.");
        if (body.currentPassword === next)
          throw new HttpError(400, "Choose a different password.");
        await transaction(async () => {
          await db
            .prepare(
              "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
            )
            .run(passwordHash(next), user.id);
          await db
            .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
            .run(user.id, tokenHash(token));
          await audit(user.id, "password_changed", {});
        });
        return send(200, {
          ok: true,
        });
      }
      if (user.must_change_password)
        throw new HttpError(
          403,
          "Change your temporary password before continuing.",
        );
      if (path === "/api/shifts" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT * FROM shifts WHERE user_id=? ORDER BY id DESC LIMIT 100",
            )
            .all(user.id),
        );
      if (path === "/api/punch" && method === "POST") {
        if (user.role !== "employee")
          throw new HttpError(403, "Only employees can punch attendance.");
        rateLimit(`punch:${user.id}`, 60);
        const body = await readBody(req);
        if (!["in", "out"].includes(body.action))
          throw new HttpError(400, "Choose punch-in or punch-out.");
        const signals = parseSignals(body.signals);
        let device = null;
        try {
          if (!req.headers.authorization?.startsWith("Bearer "))
            throw new HttpError(
              403,
              "Attendance can only be recorded from the company mobile app.",
              "web_punch_blocked",
            );
          device = await deviceFromHeaders(user, req);
          if (!device)
            throw new HttpError(
              403,
              "This phone is not registered. Sign in again from the company app.",
              "device_unknown",
            );
          if (device.status !== "approved")
            throw new HttpError(
              403,
              device.status === "pending"
                ? "Your phone is waiting for administrator approval."
                : "This phone is no longer authorised. Contact your administrator.",
              `device_${device.status}`,
            );
          const result = await transaction(async () => {
            const open = await db
              .prepare(
                "SELECT * FROM shifts WHERE user_id=? AND out_at IS NULL",
              )
              .get(user.id);
            if (body.action === "in" && open)
              throw new HttpError(409, "You already have an active shift.");
            if (body.action === "out" && !open)
              throw new HttpError(409, "There is no active shift to end.");
            const site = open
              ? {
                  id: open.workplace_id,
                  name: open.workplace_name,
                  latitude: open.site_latitude,
                  longitude: open.site_longitude,
                  radius: open.radius,
                  max_accuracy: open.max_accuracy,
                }
              : await db
                  .prepare("SELECT * FROM workplaces WHERE id=?")
                  .get(user.workplace_id ?? -1);
            if (!site)
              throw new HttpError(
                422,
                "Ask your administrator to assign a workplace.",
              );
            const nowMs = clock();
            checkLocation(body.location, site, nowMs);
            const { latitude, longitude, accuracy } = body.location;
            const risk = assessPunch({
              signals,
              location: body.location,
              now: nowMs,
              previous: await db
                .prepare(
                  "SELECT latitude,longitude,created_at FROM punch_events WHERE user_id=? AND outcome='accepted' ORDER BY id DESC LIMIT 3",
                )
                .all(user.id),
            });
            if (risk.reject)
              throw Object.assign(
                new HttpError(422, risk.reject, risk.flags[0]),
                {
                  flags: risk.flags,
                },
              );
            const now = new Date(nowMs).toISOString();
            let id = open?.id;
            const rules =
              body.action === "in"
                ? evaluatePunchIn(policy, nowMs, timezone)
                : null;
            if (body.action === "in")
              id = Number(
                (
                  await db
                    .prepare(
                      "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,required_out_at,day_type,half_day_reasons) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    )
                    .run(
                      user.id,
                      site.id,
                      site.name,
                      site.latitude,
                      site.longitude,
                      site.radius,
                      site.max_accuracy,
                      now,
                      latitude,
                      longitude,
                      accuracy,
                      rules.requiredOutAt,
                      rules.late ? "half_day" : null,
                      JSON.stringify(
                        halfDayReasons({
                          late: rules.late,
                          requiredOutAt: rules.requiredOutAt,
                        }),
                      ),
                    )
                ).lastInsertRowid,
              );
            else {
              const reasons = halfDayReasons({
                late: JSON.parse(open.half_day_reasons || "[]").includes(
                  "late_in",
                ),
                requiredOutAt: open.required_out_at || open.in_at,
                outMs: nowMs,
              });
              await db
                .prepare(
                  "UPDATE shifts SET out_at=?,out_latitude=?,out_longitude=?,out_accuracy=?,day_type=?,half_day_reasons=? WHERE id=?",
                )
                .run(
                  now,
                  latitude,
                  longitude,
                  accuracy,
                  reasons.length ? "half_day" : "full_day",
                  JSON.stringify(reasons),
                  id,
                );
            }
            await recordPunchEvent(user, {
              action: body.action,
              outcome: "accepted",
              shiftId: id,
              flags: risk.flags,
              deviceId: device.id,
              location: body.location,
              signals,
            });
            await db
              .prepare("UPDATE devices SET last_seen_at=? WHERE id=?")
              .run(now, device.id);
            await audit(user.id, `punch_${body.action}`, {
              shiftId: id,
              workplaceId: site.id,
              flags: risk.flags,
            });
            return await db.prepare("SELECT * FROM shifts WHERE id=?").get(id);
          });
          return send(200, result);
        } catch (e) {
          // Keep evidence of refused attempts; conflicts are ordinary state errors.
          if (e instanceof HttpError && [400, 403, 422].includes(e.status))
            await recordPunchEvent(user, {
              action: body.action,
              outcome: "rejected",
              reason: e.message,
              flags: e.flags || (e.code ? [e.code] : []),
              deviceId: device?.id,
              location: body.location,
              signals,
            }).catch((err) => console.error(err));
          throw e;
        }
      }
      if (!path.startsWith("/api/admin/"))
        throw new HttpError(404, "Not found.");
      if (user.role !== "admin")
        throw new HttpError(403, "Administrator access required.");
      if (path === "/api/admin/workplaces" && method === "GET")
        return send(
          200,
          await db.prepare("SELECT * FROM workplaces ORDER BY name").all(),
        );
      if (path === "/api/admin/workplaces" && method === "POST") {
        const b = await readBody(req);
        const name = string(b.name, "Workplace name");
        const lat = number(b.latitude, "Latitude", -90, 90);
        const lon = number(b.longitude, "Longitude", -180, 180);
        const radius = number(b.radius, "Radius", 25, 2000);
        const accuracy = number(
          b.max_accuracy,
          "Maximum GPS uncertainty",
          5,
          Math.min(radius, 100),
        );
        const id = await transaction(async () => {
          const id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO workplaces(name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?)",
                )
                .run(name, lat, lon, radius, accuracy)
            ).lastInsertRowid,
          );
          await audit(user.id, "workplace_created", {
            id,
            name,
          });
          return id;
        });
        return send(201, {
          id,
        });
      }
      if (path === "/api/admin/employees" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT u.id,u.name,u.email,u.workplace_id,u.active,u.must_change_password,w.name workplace_name FROM users u LEFT JOIN workplaces w ON w.id=u.workplace_id WHERE u.role='employee' ORDER BY u.name",
            )
            .all(),
        );
      if (path === "/api/admin/employees" && method === "POST") {
        const b = await readBody(req);
        const name = string(b.name, "Name");
        const email = string(b.email, "Email", 254).toLowerCase();
        const pw = password(b.password);
        const siteId = integer(b.workplace_id);
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
          throw new HttpError(400, "Enter a valid email.");
        if (
          !(await db
            .prepare("SELECT id FROM workplaces WHERE id=?")
            .get(siteId))
        )
          throw new HttpError(400, "Select an existing workplace.");
        if (await db.prepare("SELECT id FROM users WHERE email=?").get(email))
          throw new HttpError(409, "That email is already registered.");
        const id = await transaction(async () => {
          const id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO users(name,email,password_hash,role,workplace_id,must_change_password,created_at) VALUES(?,?,?,?,?,1,?)",
                )
                .run(
                  name,
                  email,
                  passwordHash(pw),
                  "employee",
                  siteId,
                  new Date().toISOString(),
                )
            ).lastInsertRowid,
          );
          await audit(user.id, "employee_created", {
            id,
            name,
            workplaceId: siteId,
          });
          return id;
        });
        return send(201, {
          id,
        });
      }
      const employeeMatch = /^\/api\/admin\/employees\/(\d+)$/.exec(path);
      if (employeeMatch && method === "PATCH") {
        const id = integer(Number(employeeMatch[1]));
        const b = await readBody(req);
        const employee = await db
          .prepare("SELECT * FROM users WHERE id=? AND role='employee'")
          .get(id);
        if (!employee) throw new HttpError(404, "Employee not found.");
        if (typeof b.active !== "boolean")
          throw new HttpError(400, "Active must be true or false.");
        const siteId = integer(b.workplace_id);
        if (
          !(await db
            .prepare("SELECT id FROM workplaces WHERE id=?")
            .get(siteId))
        )
          throw new HttpError(400, "Select an existing workplace.");
        if (
          (!b.active || siteId !== employee.workplace_id) &&
          (await db
            .prepare("SELECT id FROM shifts WHERE user_id=? AND out_at IS NULL")
            .get(id))
        )
          throw new HttpError(
            409,
            "Employee must punch out before deactivation or reassignment.",
          );
        if (b.password !== undefined) password(b.password);
        await transaction(async () => {
          await db
            .prepare("UPDATE users SET active=?,workplace_id=? WHERE id=?")
            .run(Number(b.active), siteId, id);
          if (b.password !== undefined)
            await db
              .prepare(
                "UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?",
              )
              .run(passwordHash(b.password), id);
          if (!b.active || b.password !== undefined)
            await db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
          await audit(user.id, "employee_updated", {
            id,
            active: b.active,
            workplaceId: siteId,
            passwordReset: b.password !== undefined,
          });
        });
        return send(200, {
          ok: true,
        });
      }
      if (path === "/api/admin/overview" && method === "GET") {
        const today = dayOf(new Date().toISOString());
        const shifts = (
          await db
            .prepare("SELECT * FROM shifts WHERE in_at>=?")
            .all(new Date(Date.now() - 172800000).toISOString())
        ).filter((s) => dayOf(s.in_at) === today);
        return send(200, {
          today,
          employees: (
            await db
              .prepare(
                "SELECT COUNT(*) n FROM users WHERE role='employee' AND active=1",
              )
              .get()
          ).n,
          active: (
            await db
              .prepare("SELECT COUNT(*) n FROM shifts WHERE out_at IS NULL")
              .get()
          ).n,
          attended: new Set(shifts.map((s) => s.user_id)).size,
          hours: shifts.reduce(
            (sum, s) =>
              sum +
              ((s.out_at ? Date.parse(s.out_at) : Date.now()) -
                Date.parse(s.in_at)) /
                3600000,
            0,
          ),
          workplaces: (
            await db.prepare("SELECT COUNT(*) n FROM workplaces").get()
          ).n,
        });
      }
      if (
        (path === "/api/admin/attendance" || path === "/api/admin/export") &&
        method === "GET"
      ) {
        const from =
          url.searchParams.get("from") || dayOf(new Date().toISOString());
        const to = url.searchParams.get("to") || from;
        const validDate = (s) =>
          /^\d{4}-\d{2}-\d{2}$/.test(s) &&
          !Number.isNaN(Date.parse(s)) &&
          new Date(s).toISOString().slice(0, 10) === s;
        if (
          !validDate(from) ||
          !validDate(to) ||
          from > to ||
          Date.parse(to) - Date.parse(from) > 93 * 86400000
        )
          throw new HttpError(
            400,
            "Choose a valid date range of at most 93 days.",
          );
        const rows = (
          await db
            .prepare(
              "SELECT s.*,u.name employee_name,u.email FROM shifts s JOIN users u ON u.id=s.user_id WHERE s.in_at>=? AND s.in_at<? ORDER BY s.in_at DESC",
            )
            .all(
              new Date(Date.parse(from) - 86400000).toISOString(),
              new Date(Date.parse(to) + 172800000).toISOString(),
            )
        )
          .filter((s) => {
            const d = dayOf(s.in_at);
            return d >= from && d <= to;
          })
          .map((s) => ({
            ...s,
            hours:
              ((s.out_at ? Date.parse(s.out_at) : Date.now()) -
                Date.parse(s.in_at)) /
              3600000,
          }));
        if (path.endsWith("export")) {
          const cols = [
            "employee_name",
            "email",
            "workplace_name",
            "in_at",
            "out_at",
            "hours",
            "day_type",
            "half_day_reasons",
            "required_out_at",
            "in_latitude",
            "in_longitude",
            "in_accuracy",
            "out_latitude",
            "out_longitude",
            "out_accuracy",
          ];
          res.writeHead(200, {
            ...headers,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": 'attachment; filename="attendance.csv"',
          });
          return res.end(
            "\uFEFF" +
              [
                cols.join(","),
                ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")),
              ].join("\r\n"),
          );
        }
        return send(200, rows);
      }
      if (path === "/api/admin/active" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT s.*,u.name employee_name,u.email FROM shifts s JOIN users u ON u.id=s.user_id WHERE out_at IS NULL ORDER BY in_at DESC",
            )
            .all(),
        );
      if (path === "/api/admin/audit" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT a.*,u.name actor_name FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 100",
            )
            .all(),
        );
      if (path === "/api/admin/devices" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT d.id,d.user_id,u.name employee_name,u.email,d.platform,d.model,d.status,d.registered_at,d.last_seen_at FROM devices d JOIN users u ON u.id=d.user_id ORDER BY CASE d.status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, d.id DESC",
            )
            .all(),
        );
      const deviceMatch = /^\/api\/admin\/devices\/(\d+)$/.exec(path);
      if (deviceMatch && method === "PATCH") {
        const id = integer(Number(deviceMatch[1]));
        const b = await readBody(req);
        if (!["approved", "revoked"].includes(b.status))
          throw new HttpError(400, "Status must be approved or revoked.");
        const row = await db
          .prepare("SELECT * FROM devices WHERE id=?")
          .get(id);
        if (!row) throw new HttpError(404, "Device not found.");
        await transaction(async () => {
          const now = new Date().toISOString();
          if (b.status === "approved")
            await db
              .prepare(
                "UPDATE devices SET status='revoked',decided_by=?,decided_at=? WHERE user_id=? AND status='approved' AND id<>?",
              )
              .run(user.id, now, row.user_id, id);
          await db
            .prepare(
              "UPDATE devices SET status=?,decided_by=?,decided_at=? WHERE id=?",
            )
            .run(b.status, user.id, now, id);
          await audit(user.id, `device_${b.status}`, {
            deviceId: id,
            employeeId: row.user_id,
          });
        });
        return send(200, { ok: true });
      }
      if (path === "/api/admin/security-events" && method === "GET")
        return send(
          200,
          await db
            .prepare(
              "SELECT e.id,e.action,e.outcome,e.reason,e.flags,e.latitude,e.longitude,e.accuracy,e.created_at,u.name employee_name FROM punch_events e JOIN users u ON u.id=e.user_id WHERE e.outcome='rejected' OR e.flags<>'[]' ORDER BY e.id DESC LIMIT 100",
            )
            .all(),
        );
      throw new HttpError(404, "Not found.");
    } catch (e) {
      if (!e.status) console.error(e);
      if (!res.headersSent)
        send(e.status || 500, {
          error: e.status
            ? e.message
            : "Unexpected server error. Please retry.",
        });
    }
  };
  const server = http.createServer((req, res) => {
    req.setTimeout(20000, () => req.destroy());
    void db
      .serialized(() => handle(req, res))
      .catch(() => {
        if (!res.headersSent)
          res.writeHead(500, {
            "Content-Type": "application/json",
          });
        res.end(
          JSON.stringify({
            error: "Unable to complete request.",
          }),
        );
      });
  });
  return {
    server,
    db,
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, db } = createApp({
    db: await openConfiguredDatabase(),
  });
  server.listen(Number(process.env.PORT) || 3000, "0.0.0.0", () =>
    console.log(`HRMS listening on port ${process.env.PORT || 3000}`),
  );
  for (const signal of ["SIGTERM", "SIGINT"])
    process.on(signal, () =>
      server.close(async () => {
        await db.close();
        process.exit(0);
      }),
    );
}
