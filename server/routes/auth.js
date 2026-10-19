import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createAdmin,
  passwordHash,
  passwordMatches,
  tokenHash,
} from "../db.js";
import { HttpError, string, password, email, clientIp } from "../http.js";
import { permissionsFor } from "../rbac.js";
import { bindDevice, deviceFromHeaders } from "../devices.js";
import { finishedToday } from "./attendance.js";
import { pendingApprovals } from "../approval.js";
import { checkSecondFactor } from "./security.js";

const dummyHash = passwordHash("unused-password-for-timing");
// Roles that record attendance from a phone must register it.
const PHONE_ROLES = ["employee", "hr"];

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
    rateLimit(`ip:${clientIp(req)}`, 1000);
    rateLimit(`email:${mail}`, 10);
    const user = await db
      .prepare(
        "SELECT u.* FROM users u JOIN companies c ON c.id=u.company_id WHERE u.email=? AND c.active=1",
      )
      .get(mail);
    const valid = passwordMatches(pw, user?.password_hash || dummyHash);
    if (!valid || !user?.active)
      throw new HttpError(401, "Email or password is incorrect.");
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
        "INSERT INTO sessions(token_hash,user_id,expires_at,created_at,ip,agent) VALUES(?,?,?,?,?,?)",
      )
      .run(
        tokenHash(token),
        user.id,
        Date.now() + 86400000,
        new Date(clock()).toISOString(),
        clientIp(req),
        String(req.headers["user-agent"] ?? "").slice(0, 200),
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
        .prepare("SELECT id,name FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        user: safeUser(user),
        company,
        permissions: permissionsFor(user.role),
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
          (await db
            .prepare("SELECT * FROM shifts WHERE user_id=? AND out_at IS NULL")
            .get(user.id)) || null,
        todayShift: await finishedToday(app, user.id, clock()),
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
            "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
          )
          .run(passwordHash(next), user.id);
        await db
          .prepare("DELETE FROM sessions WHERE user_id=? AND token_hash<>?")
          .run(user.id, tokenHash(token));
        await audit("password_changed", {});
      });
      return send(200, { ok: true });
    },
  );
}
