import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openConfiguredDatabase, tokenHash } from "./db.js";
import { HttpError, readBody } from "./http.js";
import { createRouter } from "./router.js";
import { can } from "./rbac.js";
import { loadPolicy } from "./policy.js";
import { registerAuth } from "./routes/auth.js";
import { registerAttendance } from "./routes/attendance.js";
import { registerOrg } from "./routes/org.js";
import { registerEmployees } from "./routes/employees.js";
import { registerReports } from "./routes/reports.js";
import { registerAdmin } from "./routes/admin.js";
import { registerTeam } from "./routes/team.js";
import { registerLeave } from "./routes/leave.js";
import { registerRegularization } from "./routes/regularization.js";
import { registerSummary } from "./routes/summary.js";
import { registerPayrollSetup } from "./routes/payroll-setup.js";
import { registerPayrollRuns } from "./routes/payroll-runs.js";
import { registerPayrollExtras } from "./routes/payroll-extras.js";
import { registerRecruitment } from "./routes/recruitment.js";
import { registerExit } from "./routes/exit.js";
import { registerDocuments } from "./routes/documents.js";
import { registerPerformance } from "./routes/performance.js";
import { registerShiftPolicies } from "./routes/shift-policies.js";
import { registerAttendanceImport } from "./routes/attendance-import.js";
import { registerPerformanceExtras } from "./routes/performance-extras.js";
import { registerBulk } from "./routes/bulk.js";
import { registerPeople } from "./routes/people.js";
import { registerSecurity } from "./routes/security.js";
import { registerEngagement } from "./routes/engagement.js";
import { registerInsights } from "./routes/insights.js";
import { registerRoles } from "./routes/roles.js";
import { scheduleRetention } from "./retention.js";
import {
  registerLearning,
  scheduleLearningReminders,
} from "./routes/learning.js";
import { registerCompOff, scheduleCompOffExpiry } from "./routes/compoff.js";
import { registerTaxDeclarations } from "./routes/tax-declarations.js";
import { registerPayrollReports } from "./routes/payroll-reports.js";
import { registerChat } from "./routes/chat.js";
import { registerBot } from "./routes/bot.js";
import { createLlm } from "./bot.js";
import { registerEssPlus } from "./routes/ess-plus.js";
import { registerPeoplePlus } from "./routes/people-plus.js";
import { registerOnboardingPlus } from "./routes/onboarding-plus.js";
import { registerCredit } from "./routes/credit.js";
import { registerInterviewsPlus } from "./routes/interviews-plus.js";
import { registerRecruitmentPlus } from "./routes/recruitment-plus.js";
import { registerPreboarding } from "./routes/preboarding.js";
import {
  registerProbation,
  scheduleProbationReminders,
} from "./routes/probation.js";
import { createPush } from "./push.js";
import { createNotifier, notifyFromAudit } from "./notify.js";

const publicDir = new URL("../public/", import.meta.url);
const STATIC = {
  "/": ["index.html", "text/html"],
  "/app.js": ["app.js", "text/javascript"],
  "/timeoff.js": ["timeoff.js", "text/javascript"],
  "/payroll.js": ["payroll.js", "text/javascript"],
  "/payroll-more.js": ["payroll-more.js", "text/javascript"],
  "/payroll-plus.js": ["payroll-plus.js", "text/javascript"],
  "/hiring.js": ["hiring.js", "text/javascript"],
  "/engage.js": ["engage.js", "text/javascript"],
  "/more.js": ["more.js", "text/javascript"],
  "/people.js": ["people.js", "text/javascript"],
  "/bulk.js": ["bulk.js", "text/javascript"],
  "/learning.js": ["learning.js", "text/javascript"],
  "/recruit.js": ["recruit.js", "text/javascript"],
  "/profile360.js": ["profile360.js", "text/javascript"],
  "/timeplus.js": ["timeplus.js", "text/javascript"],
  "/ess-plus.js": ["ess-plus.js", "text/javascript"],
  "/chat.js": ["chat.js", "text/javascript"],
  "/join.html": ["join.html", "text/html"],
  "/join.js": ["join.js", "text/javascript"],
  "/careers.html": ["careers.html", "text/html"],
  "/careers.js": ["careers.js", "text/javascript"],
  "/letter.html": ["letter.html", "text/html"],
  "/letter.js": ["letter.js", "text/javascript"],
  "/payslip.html": ["payslip.html", "text/html"],
  "/payslip.js": ["payslip.js", "text/javascript"],
  "/styles.css": ["styles.css", "text/css"],
};

export function createApp({
  db,
  production = process.env.NODE_ENV === "production",
  company = process.env.COMPANY_NAME || "Company",
  timezone = process.env.REPORT_TIMEZONE || "Asia/Kolkata",
  policy = loadPolicy(),
  clock = Date.now,
} = {}) {
  if (!db) throw new Error("createApp requires a database.");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const limits = new Map();
  const app = {
    db,
    production,
    company,
    timezone,
    policy,
    clock,
    dayOf: (iso) => formatter.format(new Date(iso)),
    transaction: (fn) => db.transaction(fn),
    rateLimit(key, max, window = 900000) {
      const now = Date.now();
      for (const [k, v] of limits) if (v.until < now) limits.delete(k);
      const limit = limits.get(key) || { count: 0, until: now + window };
      limit.count++;
      limits.set(key, limit);
      if (limit.count > max)
        throw new HttpError(
          429,
          "Too many attempts. Please wait 15 minutes and retry.",
        );
    },
    // actor is a user row (or null); the entry is filed under their company
    // unless one is given.
    audit: (actor, action, detail, companyId = actor?.company_id ?? null) =>
      db
        .prepare(
          "INSERT INTO audit(actor_id,action,detail,created_at,company_id) VALUES(?,?,?,?,?)",
        )
        .run(
          actor?.id ?? null,
          action,
          JSON.stringify(detail),
          new Date(clock()).toISOString(),
          companyId,
        ),
  };
  app.notify = createNotifier(app);
  // Laxmi's free-text fallback; null unless ANTHROPIC_API_KEY is set (tests replace it).
  app.botLlm = createLlm();
  app.push = createPush(app);
  const writeAudit = app.audit;
  app.audit = async (
    actor,
    action,
    detail,
    companyId = actor?.company_id ?? null,
  ) => {
    const result = await writeAudit(actor, action, detail, companyId);
    try {
      await notifyFromAudit(app, actor, action, detail, companyId);
    } catch (e) {
      console.error("notification failed:", e.message);
    }
    return result;
  };
  const router = createRouter();
  for (const register of [
    registerAuth,
    registerAttendance,
    registerOrg,
    registerEmployees,
    registerReports,
    registerAdmin,
    registerTeam,
    registerLeave,
    registerRegularization,
    registerSummary,
    registerPayrollSetup,
    registerPayrollReports, // before the payslip :runId route, so /payslips/ytd is not read as an id
    registerPayrollRuns,
    registerPayrollExtras,
    registerRecruitment,
    registerRecruitmentPlus,
    registerInterviewsPlus,
    registerCredit,
    registerOnboardingPlus,
    registerPeoplePlus,
    registerCompOff,
    registerTaxDeclarations,
    registerEssPlus,
    registerChat,
    registerBot,
    registerPreboarding,
    registerProbation,
    registerLearning,
    registerExit,
    registerEngagement,
    registerSecurity,
    registerPeople,
    registerBulk,
    registerPerformanceExtras,
    registerAttendanceImport,
    registerShiftPolicies,
    registerDocuments,
    registerPerformance,
    registerInsights,
    registerRoles,
  ])
    register(router, app);

  async function authenticate(req) {
    const token = req.headers.authorization?.startsWith("Bearer ")
      ? req.headers.authorization.slice(7)
      : /(?:^|;\s*)hrms_session=([^;]+)/.exec(req.headers.cookie || "")?.[1];
    const user =
      token &&
      (await db
        .prepare(
          "SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id JOIN companies c ON c.id=u.company_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1 AND c.active=1",
        )
        .get(tokenHash(token), Date.now()));
    if (!user) throw new HttpError(401, "Please sign in again.");
    if (user.role === "custom") {
      const role = await db
        .prepare(
          "SELECT name,permissions FROM custom_roles WHERE id=? AND company_id=?",
        )
        .get(user.custom_role_id, user.company_id);
      user.custom_role_name = role?.name ?? null;
      user.custom_permissions = role ? JSON.parse(role.permissions) : [];
    }
    return { user, token };
  }
  // Super administrators may act inside another company by naming it.
  async function companyScope(user, req) {
    const wanted = req.headers["x-company-id"];
    if (user.role !== "super_admin" || !wanted) return user.company_id;
    const id = Number(wanted);
    if (
      !Number.isSafeInteger(id) ||
      !(await db.prepare("SELECT id FROM companies WHERE id=?").get(id))
    )
      throw new HttpError(400, "Unknown company.");
    return id;
  }

  const handle = async (req, res) => {
    const headers = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
      "Permissions-Policy": "geolocation=(self)",
      "Content-Security-Policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; object-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
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
        return send(200, { ok: true });
      }
      if (!path.startsWith("/api/")) {
        if (method !== "GET") throw new HttpError(405, "Method not allowed.");
        if (path === "/favicon.ico") {
          res.writeHead(204, headers);
          return res.end();
        }
        if (!STATIC[path]) throw new HttpError(404, "Not found.");
        const [file, type] = STATIC[path];
        const content = await readFile(new URL(file, publicDir));
        res.writeHead(200, {
          ...headers,
          "Content-Type": `${type}; charset=utf-8`,
        });
        return res.end(content);
      }
      if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method))
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
        method !== "DELETE" &&
        !req.headers["content-type"]?.startsWith("application/json")
      )
        throw new HttpError(415, "Use application/json.");
      const { route, params, pathMatched } = router.match(method, path);
      if (!route)
        throw new HttpError(
          pathMatched ? 405 : 404,
          pathMatched ? "Method not allowed." : "Not found.",
        );
      const c = {
        req,
        res,
        url,
        params,
        query: url.searchParams,
        send,
        headers,
        app,
        body: (limit) => readBody(req, limit),
      };
      if (!route.options.public) {
        Object.assign(c, await authenticate(req));
        if (c.user.must_change_password && !route.options.allowTemp)
          throw new HttpError(
            403,
            "Change your temporary password before continuing.",
          );
        c.companyId = await companyScope(c.user, req);
        if (route.options.perm && !can(c.user, route.options.perm))
          throw new HttpError(
            403,
            "You do not have permission for this action.",
          );
        c.audit = (action, detail) =>
          app.audit(c.user, action, detail, c.companyId);
      }
      return await route.handler(c);
    } catch (e) {
      // Unique-constraint violations from the database become a clean conflict.
      if (e?.code === "23505")
        e = new HttpError(409, "That value is already in use.");
      if (!e.status) console.error(e);
      if (!res.headersSent)
        send(e.status || 500, {
          error: e.status
            ? e.message
            : "Unexpected server error. Please retry.",
          ...(e.status && e.code ? { code: e.code } : {}),
        });
    }
  };
  // One log line for slow or failing requests, so problems show up in Render's
  // logs without logging every request.
  const timed = async (req, res, fn) => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const ms = Date.now() - started;
      if (ms > 1000 || res.statusCode >= 500)
        console.warn(
          JSON.stringify({
            status: res.statusCode,
            ms,
            method: req.method,
            path: req.url.split("?")[0],
          }),
        );
    }
  };
  const server = http.createServer((req, res) => {
    req.setTimeout(20000, () => req.destroy());
    void db
      .serialized(() => timed(req, res, () => handle(req, res)), {
        // GETs, and routes marked { concurrent: true } (slow, self-contained work
        // such as the assistant's fallback), do not wait behind other writes.
        concurrent:
          req.method === "GET" ||
          Boolean(
            router.match(req.method, (req.url || "/").split("?")[0]).route
              ?.options.concurrent,
          ),
      })
      .catch(() => {
        if (!res.headersSent)
          res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unable to complete request." }));
      });
  });
  return { server, db, app };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { server, db, app } = createApp({
    db: await openConfiguredDatabase(),
  });
  scheduleRetention(db);
  scheduleProbationReminders(app);
  scheduleLearningReminders(app);
  scheduleCompOffExpiry(app);
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
