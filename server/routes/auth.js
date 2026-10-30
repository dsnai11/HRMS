import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAdmin,
  passwordHash,
  passwordMatches,
  passwordMatchesAsync,
  tokenHash,
} from "../db.js";
import { HttpError, string, password, email, clientIp } from "../http.js";
import { permissionsOf } from "../rbac.js";
import { ipAllowed, isStaff, loadRole, outsideOffice, policyOf } from "../security-policy.js";
import { odAllowed } from "./od-visits.js";
import { bindDevice, deviceFromHeaders } from "../devices.js";
import { closeStaleShifts, finishedToday } from "./attendance.js";
import { pendingApprovals } from "../approval.js";
import { checkSecondFactor } from "./security.js";

const dummyHash = passwordHash("unused-password-for-timing");
// Roles that record attendance from a phone must register it.
const PHONE_ROLES = ["employee", "hr", "custom"];

export const safeUser = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  company_id: u.company_id,
  workplace_id: u.workplace_id,
  employee_code: u.employee_code,
  active: Boolean(u.active),
  must_change_password: Boolean(u.must_change_password),
  od_punch: Boolean(u.od_punch),
  ...(u.role === "custom" ? { role_name: u.custom_role_name ?? null } : {}),
});

export function registerAuth(router, app) {
  const { db, production, transaction, rateLimit, clock } = app;

  router.get("/api/config", { public: true }, async ({ send }) =>
    send(200, {
      company: app.company,
      timezone: app.timezone,
      setupRequired:
        Boolean(process.env.SETUP_TOKEN) &&
        !(await db
          .prepare("SELECT id FROM users WHERE role IN ('admin','super_admin')")
          .get()),
    }),
  );

  router.post("/api/setup", { public: true }, async ({ req, body, send }) => {
    rateLimit(`setup:${clientIp(req)}`, 10);
    const b = await body();
    if (
      !process.env.SETUP_TOKEN ||
      typeof b.setupToken !== "string" ||
      !timingSafeEqual(
        Buffer.from(tokenHash(b.setupToken)),
        Buffer.from(tokenHash(process.env.SETUP_TOKEN)),
      )
    )
      throw new HttpError(403, "Invalid setup code.");
    if (
      await db
        .prepare("SELECT id FROM users WHERE role IN ('admin','super_admin')")
        .get()
    )
      throw new HttpError(409, "Administrator setup is already complete.");
    const name = string(b.name, "Name");
    const mail = email(b.email);
    const pw = password(b.password);
    await transaction(async () => {
      await createAdmin(db, {
        name,
        email: mail,
        password: pw,
        companyName: app.company,
      });
      await app.audit(null, "administrator_created", {});
    });
    return send(201, { ok: true });
  });

  router.post("/api/login", { public: true }, async ({ req, body, send }) => {
    const b = await body();
    const mail = string(b.email, "Email", 254).toLowerCase();
    const pw =
      typeof b.password === "string" && b.password.length <= 128
        ? b.password
        : "";
    // Per-address limit is generous (offices share one address); the per-email limit is the tight one.
    rateLimit(
      `ip:${clientIp(req)}`,
      Number(process.env.LOGIN_IP_LIMIT) || 5000,
    );
    rateLimit(`email:${mail}`, 10);
    const user = await db
      .prepare(
        "SELECT u.* FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? AND c.active=1",
      )
      .get(mail);
    const valid = await passwordMatchesAsync(
      pw,
      user?.password_hash || dummyHash,
    );
    if (!valid || !user?.active)
      throw new HttpError(401, "Email or password is incorrect.");
    // Company security policy: office addresses for staff on the web, password expiry.
    await loadRole(db, user);
    const policy = policyOf(
      await db
        .prepare("SELECT staff_ip_allowlist,password_max_days FROM companies WHERE id=?")
        .get(user.company_id),
    );
    if (b.native !== true && isStaff(user) && !ipAllowed(clientIp(req), policy.staff_ip_allowlist)) {
      await app.audit(user, "login_blocked_ip", { ip: clientIp(req) });
      throw outsideOffice();
    }
    if (policy.password_max_days && !user.must_change_password) {
      const changed = Date.parse(user.password_changed_at ?? "");
      if (!changed)
        await db
          .prepare("UPDATE users SET password_changed_at=? WHERE id=?")
          .run(new Date(clock()).toISOString(), user.id);
      else if (clock() - changed > policy.password_max_days * 86400000) {
        await db.prepare("UPDATE users SET must_change_password=1 WHERE id=?").run(user.id);
        user.must_change_password = 1;
        await app.audit(user, "password_expired", { days: policy.password_max_days });
      }
    }
    if (b.native === true && !b.device && PHONE_ROLES.includes(user.role))
      throw new HttpError(
        400,
        "Update the mobile app to sign in.",
        "device_required",
      );
    // Browser sign-ins need a second factor once it is switched on; phones are protected by the approved device.
    if (user.totp_enabled && b.native !== true) {
      if (!b.code)
        throw new HttpError(
          401,
          "Enter the code from your authenticator app.",
          "totp_required",
        );
      rateLimit(`totp:${user.id}`, 10);
      if (!(await checkSecondFactor(app, user, b.code)))
        throw new HttpError(401, "That code is not right.", "totp_required");
    }
    const device =
      b.native === true && b.device
        ? await bindDevice(app, user, b.device)
        : null;
    const token = randomBytes(32).toString("hex");
    await db
      .prepare("DELETE FROM sessions WHERE expires_at < ?")
      .run(Date.now());
    await db
      .prepare(
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,ip,agent,native,last_seen_at) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(
        tokenHash(token),
        user.id,
        // Phones are bound to an approved device and keep the session for 30 days, so
        // the morning rush is not a rush of sign-ins; browsers stay at 24 hours.
        Date.now() + (b.native === true ? 30 * 86400000 : 86400000),
        new Date(clock()).toISOString(),
        clientIp(req),
        String(req.headers["user-agent"] ?? "").slice(0, 200),
        b.native === true ? 1 : 0,
        clock(),
      );
    await app.audit(user, "login", {});
    return send(
      200,
      {
        user: safeUser(user),
        ...(b.native === true ? { token } : {}),
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
  });

  router.post("/api/logout", { allowTemp: true }, async ({ token, send }) => {
    await db
      .prepare("DELETE FROM sessions WHERE token_hash=?")
      .run(tokenHash(token));
    return send(
      200,
      { ok: true },
      {
        "Set-Cookie": `hrms_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${production ? "; Secure" : ""}`,
      },
    );
  });

  router.get(
    "/api/me",
    { allowTemp: true },
    async ({ req, user, companyId, send }) => {
      const company = await db
        .prepare(
          "SELECT id,name,require_selfie,labels FROM companies WHERE id=?",
        )
        .get(companyId);
      const job = await db
        .prepare(
          "SELECT g.name designation FROM users u LEFT JOIN designations g ON g.id=u.designation_id WHERE u.id=?",
        )
        .get(user.id);
      return send(200, {
        user: { ...safeUser(user), designation: job?.designation ?? null },
        ...(user.needs_2fa ? { needs_2fa: true } : {}),
        company: company && {
          ...company,
          require_selfie: Boolean(company.require_selfie),
          labels: JSON.parse(company.labels || "{}"),
        },
        permissions: permissionsOf(user),
        is_manager: Boolean(
          await db
            .prepare(
              "SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1",
            )
            .get(user.id),
        ),
        approvals_pending: await pendingApprovals(app, user),
        workplace: user.workplace_id
          ? await db
              .prepare("SELECT * FROM workplaces WHERE id=?")
              .get(user.workplace_id)
          : null,
        openShift:
          (await closeStaleShifts(app, user.id),
          await db
            .prepare("SELECT * FROM shifts WHERE user_id=? AND out_at IS NULL")
            .get(user.id)) || null,
        todayShift: await finishedToday(app, user.id, clock()),
        // An OD trip out of the office in the open shift, if any.
        openTrip:
          (await db
            .prepare("SELECT id,purpose,out_at FROM od_visits WHERE user_id=? AND status='open'")
            .get(user.id)) || null,
        od_allowed: await odAllowed(app, user),
        device: await deviceFromHeaders(app, user, req).then((d) =>
          d ? { status: d.status } : null,
        ),
      });
    },
  );

  router.post(
    "/api/password",
    { allowTemp: true },
    async ({ user, token, body, send, audit }) => {
      rateLimit(`password:${user.id}`, 10);
      const b = await body();
      const next = password(b.newPassword);
      if (
        typeof b.currentPassword !== "string" ||
        b.currentPassword.length > 128 ||
        !passwordMatches(b.currentPassword, user.password_hash)
      )
        throw new HttpError(400, "Current password is incorrect.");
      if (b.currentPassword === next)
        throw new HttpError(400, "Choose a different password.");
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE users SET password_hash=?,must_change_password=0,password_changed_at=? WHERE id=?",
          )
          .run(passwordHash(next), new Date(clock()).toISOString(), user.id);
        await db
          .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
          .run(user.id, tokenHash(token));
        await audit("password_changed", {});
      });
      return send(200, { ok: true });
    },
  );
}
