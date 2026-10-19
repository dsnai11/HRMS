import {
  HttpError,
  string,
  optionalString,
  number,
  integer,
  isoDate,
  oneOf,
  optionalId,
} from "../http.js";
import { can } from "../rbac.js";
import { requireOwned } from "../scope.js";
import { mayDecide } from "../approval.js";
import { eachDay, daysBetween, leaveYearOf } from "../calendar.js";
import {
  companySettings,
  holidayMap,
  dayKind,
  balances,
  ensureAccruals,
  yearBalance,
  addEntry,
  round2,
} from "../leave-ledger.js";

const now = (app) => new Date(app.clock()).toISOString();
const bool = (v, label) => {
  if (typeof v !== "boolean")
    throw new HttpError(400, `${label} must be true or false.`);
  return v;
};
const intList = (v, label, min, max) => {
  if (
    !Array.isArray(v) ||
    v.length > 7 ||
    !v.every((n) => Number.isInteger(n) && n >= min && n <= max)
  )
    throw new HttpError(400, `${label} is invalid.`);
  return [...new Set(v)].sort((a, b) => a - b);
};

// Standard Indian leave types, offered as a starting point.
const DEFAULT_TYPES = [
  { code: "CL", name: "Casual Leave", quota: 12, carry: 0 },
  { code: "SL", name: "Sick Leave", quota: 7, carry: 0 },
  { code: "EL", name: "Earned Leave", quota: 15, carry: 30 },
  {
    code: "ML",
    name: "Maternity Leave",
    quota: 182,
    carry: 0,
    accrual: "yearly",
    gender: "female",
    half: 0,
  },
  {
    code: "LWP",
    name: "Leave Without Pay",
    quota: 0,
    carry: 0,
    paid: 0,
    unlimited: 1,
  },
];

export function registerLeave(router, app) {
  const { db, transaction, clock, dayOf } = app;
  const today = () => dayOf(now(app));

  // ---- company calendar settings --------------------------------------------
  const settingsView = async (companyId) => {
    const s = await companySettings(db, companyId);
    return {
      leave_year_start_month: s.leaveYearStartMonth,
      leave_start_year: s.leaveStartYear,
      attendance_start_date: s.attendanceStartSet,
      attendance_counted_from: s.attendanceStart,
      weekly_off_days: s.weekOff.days,
      weekly_off_saturdays: s.weekOff.saturdays,
      regularization_window_days: s.regularizationWindowDays,
      regularization_monthly_limit: s.regularizationMonthlyLimit,
    };
  };
  router.get(
    "/api/admin/leave-settings",
    { perm: "leave.manage" },
    async ({ companyId, send }) => send(200, await settingsView(companyId)),
  );
  router.get("/api/leave/settings", async ({ companyId, send }) =>
    send(200, await settingsView(companyId)),
  );
  router.patch(
    "/api/admin/leave-settings",
    { perm: "leave.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const set = {};
      if (b.leave_year_start_month !== undefined) {
        const m = number(
          b.leave_year_start_month,
          "Leave year start month",
          1,
          12,
        );
        if (!Number.isInteger(m))
          throw new HttpError(400, "Leave year start month is invalid.");
        const current = (await companySettings(db, companyId))
          .leaveYearStartMonth;
        if (
          m !== current &&
          (await db
            .prepare("SELECT id FROM leave_ledger WHERE company_id=? LIMIT 1")
            .get(companyId))
        )
          throw new HttpError(
            409,
            "The leave year cannot change once balances exist.",
          );
        set.leave_year_start_month = m;
      }
      if (b.leave_start_year !== undefined)
        set.leave_start_year =
          b.leave_start_year === null
            ? null
            : number(b.leave_start_year, "Leave start year", 2000, 2100);
      if (b.attendance_start_date !== undefined)
        set.attendance_start_date =
          b.attendance_start_date === null || b.attendance_start_date === ""
            ? null
            : isoDate(b.attendance_start_date, "Attendance start date");
      if (b.weekly_off_days !== undefined)
        set.weekly_off_days = JSON.stringify(
          intList(b.weekly_off_days, "Weekly off days", 0, 6),
        );
      if (b.weekly_off_saturdays !== undefined)
        set.weekly_off_saturdays = JSON.stringify(
          intList(b.weekly_off_saturdays, "Saturday offs", 1, 5),
        );
      if (b.regularization_window_days !== undefined)
        set.regularization_window_days = number(
          b.regularization_window_days,
          "Correction window",
          0,
          90,
        );
      if (b.regularization_monthly_limit !== undefined)
        set.regularization_monthly_limit = number(
          b.regularization_monthly_limit,
          "Monthly correction limit",
          0,
          31,
        );
      const keys = Object.keys(set);
      if (!keys.length) throw new HttpError(400, "Nothing to update.");
      await transaction(async () => {
        await db
          .prepare(
            `UPDATE companies SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`,
          )
          .run(...keys.map((k) => set[k]), companyId);
        await audit("leave_settings_updated", set);
      });
      return send(200, await settingsView(companyId));
    },
  );

  // ---- leave types ----------------------------------------------------------
  const typeRow = (b, existing = {}) => {
    const pick = (k, f) => (b[k] === undefined ? existing[k] : f(b[k]));
    const unlimited = pick("unlimited", (v) => Number(bool(v, "Unlimited")));
    return {
      name: pick("name", (v) => string(v, "Name", 60)),
      paid: pick("paid", (v) => Number(bool(v, "Paid"))),
      unlimited,
      quota_per_year: unlimited
        ? 0
        : pick("quota_per_year", (v) => number(v, "Yearly quota", 0, 366)),
      accrual: pick("accrual", (v) =>
        oneOf(v, "Accrual", ["monthly", "yearly"]),
      ),
      carry_forward_max: pick("carry_forward_max", (v) =>
        number(v, "Carry-forward limit", 0, 366),
      ),
      allow_half_day: pick("allow_half_day", (v) =>
        Number(bool(v, "Half days")),
      ),
      encashable: pick("encashable", (v) => Number(bool(v, "Encashable"))),
      applicable_gender: pick("applicable_gender", (v) =>
        v === null || v === ""
          ? null
          : oneOf(v, "Applicable gender", ["male", "female", "other"]),
      ),
      max_days_per_request: pick("max_days_per_request", (v) =>
        v === null || v === ""
          ? null
          : number(v, "Maximum days per request", 0.5, 366),
      ),
      active: pick("active", (v) => Number(bool(v, "Active"))),
    };
  };
  const markStartYear = async (companyId) =>
    db
      .prepare(
        "UPDATE companies SET leave_start_year=? WHERE id=? AND leave_start_year IS NULL",
      )
      .run(
        leaveYearOf(
          today(),
          (await companySettings(db, companyId)).leaveYearStartMonth,
        ),
        companyId,
      );

  router.get(
    "/api/admin/leave-types",
    { perm: "leave.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare("SELECT * FROM leave_types WHERE company_id=? ORDER BY name")
          .all(companyId),
      ),
  );
  router.post(
    "/api/admin/leave-types",
    { perm: "leave.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const code = string(b.code, "Code", 10).toUpperCase();
      if (!/^[A-Z0-9]{2,10}$/.test(code))
        throw new HttpError(400, "Code must be 2–10 letters or digits.");
      const t = typeRow({
        paid: true,
        unlimited: false,
        quota_per_year: 0,
        accrual: "monthly",
        carry_forward_max: 0,
        allow_half_day: true,
        encashable: false,
        applicable_gender: null,
        max_days_per_request: null,
        active: true,
        ...b,
      });
      const id = await transaction(async () => {
        const id = Number(
          (
            await db
              .prepare(
                "INSERT INTO leave_types(company_id,name,code,paid,unlimited,quota_per_year,accrual,carry_forward_max,allow_half_day,applicable_gender,max_days_per_request,active,encashable,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
              )
              .run(
                companyId,
                t.name,
                code,
                t.paid,
                t.unlimited,
                t.quota_per_year,
                t.accrual,
                t.carry_forward_max,
                t.allow_half_day,
                t.applicable_gender,
                t.max_days_per_request,
                t.active,
                t.encashable,
                now(app),
              )
          ).lastInsertRowid,
        );
        await markStartYear(companyId);
        await audit("leave_type_created", { id, code });
        return id;
      });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/leave-types/:id",
    { perm: "leave.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const id = integer(Number(params.id));
      const row = await requireOwned(
        db,
        "leave_types",
        id,
        companyId,
        "leave type",
      );
      const t = typeRow(await body(), row);
      await transaction(async () => {
        await db
          .prepare(
            "UPDATE leave_types SET name=?,paid=?,unlimited=?,quota_per_year=?,accrual=?,carry_forward_max=?,allow_half_day=?,applicable_gender=?,max_days_per_request=?,active=?,encashable=? WHERE id=?",
          )
          .run(
            t.name,
            t.paid,
            t.unlimited,
            t.quota_per_year,
            t.accrual,
            t.carry_forward_max,
            t.allow_half_day,
            t.applicable_gender,
            t.max_days_per_request,
            t.active,
            t.encashable,
            id,
          );
        await audit("leave_type_updated", { id, ...t });
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/admin/leave-types/seed-defaults",
    { perm: "leave.manage" },
    async ({ companyId, send, audit }) => {
      let created = 0;
      await transaction(async () => {
        for (const d of DEFAULT_TYPES) {
          if (
            await db
              .prepare(
                "SELECT id FROM leave_types WHERE company_id=? AND upper(code)=?",
              )
              .get(companyId, d.code)
          )
            continue;
          await db
            .prepare(
              "INSERT INTO leave_types(company_id,name,code,paid,unlimited,quota_per_year,accrual,carry_forward_max,allow_half_day,applicable_gender,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              d.name,
              d.code,
              d.paid ?? 1,
              d.unlimited ?? 0,
              d.quota,
              d.accrual ?? "monthly",
              d.carry,
              d.half ?? 1,
              d.gender ?? null,
              now(app),
            );
          created++;
        }
        await markStartYear(companyId);
        await audit("leave_types_seeded", { created });
      });
      return send(201, { created });
    },
  );

  // ---- holidays -------------------------------------------------------------
  const yearParam = (query) => {
    const y = query.get("year")
      ? Number(query.get("year"))
      : Number(today().slice(0, 4));
    if (!Number.isInteger(y) || y < 2000 || y > 2100)
      throw new HttpError(400, "Choose a valid year.");
    return y;
  };
  router.get("/api/holidays", async ({ user, query, send }) => {
    const y = yearParam(query);
    const map = await holidayMap(
      db,
      user.company_id,
      user.branch_id,
      `${y}-01-01`,
      `${y}-12-31`,
    );
    return send(
      200,
      [...map].map(([date, name]) => ({ date, name })),
    );
  });
  router.get(
    "/api/admin/holidays",
    { perm: "leave.manage" },
    async ({ companyId, query, send }) => {
      const y = yearParam(query);
      return send(
        200,
        await db
          .prepare(
            "SELECT h.*,b.name branch_name FROM holidays h LEFT JOIN branches b ON b.id=h.branch_id WHERE h.company_id=? AND h.date>=? AND h.date<=? ORDER BY h.date",
          )
          .all(companyId, `${y}-01-01`, `${y}-12-31`),
      );
    },
  );
  router.post(
    "/api/admin/holidays",
    { perm: "leave.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const items = Array.isArray(b.items) ? b.items : [b];
      if (!items.length || items.length > 60)
        throw new HttpError(400, "Add between 1 and 60 holidays at a time.");
      const branchId = optionalId(b.branch_id, "Branch");
      await requireOwned(db, "branches", branchId, companyId, "branch");
      const clean = items.map((i) => ({
        date:
          isoDate(i?.date, "Date") ??
          (() => {
            throw new HttpError(400, "Date is required.");
          })(),
        name: string(i?.name, "Holiday name", 100),
      }));
      await transaction(async () => {
        for (const h of clean)
          await db
            .prepare(
              "INSERT INTO holidays(company_id,branch_id,date,name,created_at) VALUES(?,?,?,?,?)",
            )
            .run(companyId, branchId, h.date, h.name, now(app));
        await audit("holidays_added", { count: clean.length, branchId });
      });
      return send(201, { created: clean.length });
    },
  );
  router.delete(
    "/api/admin/holidays/:id",
    { perm: "leave.manage" },
    async ({ params, companyId, send, audit }) => {
      const id = integer(Number(params.id));
      const row = await requireOwned(db, "holidays", id, companyId, "holiday");
      await db.prepare("DELETE FROM holidays WHERE id=?").run(id);
      await audit("holiday_deleted", { id, date: row.date });
      return send(200, { ok: true });
    },
  );

  // ---- balances -------------------------------------------------------------
  router.get("/api/leave/balances", async ({ user, send }) =>
    send(200, await balances(app, user, today())),
  );
  router.get(
    "/api/admin/employees/:id/leave",
    { perm: "leave.read" },
    async ({ params, companyId, send }) => {
      const person = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      const ledger = await db
        .prepare(
          "SELECT l.id,l.kind,l.days,l.period,l.leave_year,l.note,l.created_at,t.code FROM leave_ledger l JOIN leave_types t ON t.id=l.leave_type_id WHERE l.user_id=? ORDER BY l.id DESC LIMIT 100",
        )
        .all(person.id);
      return send(200, {
        balances: await balances(app, person, today()),
        ledger,
      });
    },
  );
  router.post(
    "/api/admin/leave/accrue",
    { perm: "leave.manage" },
    async ({ companyId, send, audit }) => {
      const people = await db
        .prepare("SELECT * FROM users WHERE company_id=? AND active=1")
        .all(companyId);
      for (const p of people) await ensureAccruals(app, p, today());
      await audit("leave_accrual_run", { employees: people.length });
      return send(200, { employees: people.length });
    },
  );
  router.post(
    "/api/admin/leave/adjust",
    { perm: "leave.manage" },
    async ({ companyId, body, send, audit, user }) => {
      const b = await body();
      const person = await requireOwned(
        db,
        "users",
        integer(b.user_id),
        companyId,
        "employee",
      );
      const type = await requireOwned(
        db,
        "leave_types",
        integer(b.leave_type_id),
        companyId,
        "leave type",
      );
      const days = number(b.days, "Days", -366, 366);
      if (days === 0) throw new HttpError(400, "Days must not be zero.");
      const note = string(b.note, "Reason", 300);
      const settings = await ensureAccruals(app, person, today());
      const year = leaveYearOf(today(), settings.leaveYearStartMonth);
      await transaction(async () => {
        await addEntry(
          app,
          person,
          type,
          year,
          "adjustment",
          round2(days),
          null,
          note,
          user.id,
        );
        await audit("leave_adjusted", {
          employeeId: person.id,
          type: type.code,
          days,
          note,
        });
      });
      return send(200, { ok: true });
    },
  );

  // ---- applying for leave ---------------------------------------------------
  router.post("/api/leave/requests", async ({ user, body, send, audit }) => {
    const b = await body();
    const type = await requireOwned(
      db,
      "leave_types",
      integer(b.leave_type_id),
      user.company_id,
      "leave type",
    );
    if (!type.active)
      throw new HttpError(400, "That leave type is not available.");
    if (type.applicable_gender && type.applicable_gender !== user.gender)
      throw new HttpError(403, "That leave type does not apply to you.");
    const from = isoDate(b.from_date, "From date");
    const to = isoDate(b.to_date ?? b.from_date, "To date");
    if (!from || !to || to < from)
      throw new HttpError(400, "Choose a valid date range.");
    if (daysBetween(from, to) > 365)
      throw new HttpError(400, "A request can cover at most one year.");
    const half =
      b.half_day === undefined || b.half_day === null || b.half_day === ""
        ? null
        : oneOf(b.half_day, "Half day", ["first", "second"]);
    if (half && (from !== to || !type.allow_half_day))
      throw new HttpError(
        400,
        "Half days apply to a single day of a leave type that allows them.",
      );
    const reason = optionalString(b.reason, "Reason", 500);
    const settings = await ensureAccruals(app, user, today());
    const year = leaveYearOf(from, settings.leaveYearStartMonth);
    if (year !== leaveYearOf(to, settings.leaveYearStartMonth))
      throw new HttpError(
        400,
        "That range crosses into the next leave year. Split it into two requests.",
      );
    const hol = await holidayMap(db, user.company_id, user.branch_id, from, to);
    const slots = [];
    for (const day of eachDay(from, to)) {
      if (dayKind(day, settings, hol)) continue;
      for (const session of half ? [half] : ["first", "second"])
        slots.push({ day, session });
    }
    if (!slots.length)
      throw new HttpError(
        400,
        "Those dates are all holidays or weekly offs; no leave is needed.",
      );
    const days = slots.length / 2;
    if (type.max_days_per_request && days > type.max_days_per_request)
      throw new HttpError(
        422,
        `${type.name} allows at most ${type.max_days_per_request} days per request.`,
      );
    const id = await transaction(async () => {
      if (!type.unlimited) {
        const pending = (
          await db
            .prepare(
              "SELECT COALESCE(SUM(days),0) n FROM leave_requests WHERE user_id=? AND leave_type_id=? AND leave_year=? AND status='pending'",
            )
            .get(user.id, type.id, year)
        ).n;
        const available =
          (await yearBalance(db, user.id, type.id, year)) - pending;
        if (days > available + 1e-9)
          throw new HttpError(
            422,
            `Not enough ${type.name} balance: ${round2(available)} day(s) available, ${days} requested.`,
          );
      }
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO leave_requests(company_id,user_id,leave_type_id,from_date,to_date,half_day,days,leave_year,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              type.id,
              from,
              to,
              half,
              days,
              year,
              reason,
              now(app),
            )
        ).lastInsertRowid,
      );
      try {
        for (const s of slots)
          await db
            .prepare(
              "INSERT INTO leave_days(request_id,user_id,day,session,paid) VALUES(?,?,?,?,?)",
            )
            .run(id, user.id, s.day, s.session, type.paid);
      } catch (e) {
        if (e?.code === "23505")
          throw new HttpError(
            409,
            "You already have leave on some of those dates.",
          );
        throw e;
      }
      await audit("leave_requested", { id, type: type.code, from, to, days });
      return id;
    });
    return send(201, { id, days });
  });

  const SELECT_REQ = `SELECT r.*,t.name type_name,t.code type_code,t.paid,u.name employee_name,u.employee_code FROM leave_requests r
    JOIN leave_types t ON t.id=r.leave_type_id JOIN users u ON u.id=r.user_id`;
  router.get("/api/leave/requests", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          `${SELECT_REQ} WHERE r.user_id=? ORDER BY r.from_date DESC,r.id DESC LIMIT 100`,
        )
        .all(user.id),
    ),
  );
  router.get(
    "/api/admin/leave/requests",
    { perm: "leave.read" },
    async ({ companyId, query, send }) => {
      const where = ["r.company_id=?"],
        params = [companyId];
      if (query.get("status")) {
        where.push("r.status=?");
        params.push(
          oneOf(query.get("status"), "Status", [
            "pending",
            "approved",
            "rejected",
            "cancelled",
          ]),
        );
      }
      if (query.get("from")) {
        where.push("r.to_date>=?");
        params.push(isoDate(query.get("from"), "From"));
      }
      if (query.get("to")) {
        where.push("r.from_date<=?");
        params.push(isoDate(query.get("to"), "To"));
      }
      if (query.get("user_id")) {
        where.push("r.user_id=?");
        params.push(integer(Number(query.get("user_id"))));
      }
      const limit = Math.min(
          Math.max(Number(query.get("limit")) || 50, 1),
          200,
        ),
        offset = Math.max(Number(query.get("offset")) || 0, 0);
      const clause = where.join(" AND ");
      const total = (
        await db
          .prepare(`SELECT COUNT(*) n FROM leave_requests r WHERE ${clause}`)
          .get(...params)
      ).n;
      const items = await db
        .prepare(
          `${SELECT_REQ} WHERE ${clause} ORDER BY r.from_date DESC,r.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...params, limit, offset);
      return send(200, { items, total, limit, offset });
    },
  );

  async function loadRequest(id, companyId) {
    const r = await db
      .prepare(
        "SELECT r.*,t.unlimited,t.name type_name FROM leave_requests r JOIN leave_types t ON t.id=r.leave_type_id WHERE r.id=? AND r.company_id=?",
      )
      .get(id, companyId);
    if (!r) throw new HttpError(404, "Leave request not found.");
    return r;
  }
  router.post(
    "/api/leave/requests/:id/decision",
    async ({ params, user, companyId, body, send }) => {
      const r = await loadRequest(integer(Number(params.id)), companyId);
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 300);
      if (!(await mayDecide(app, user, r.user_id)))
        throw new HttpError(403, "You cannot decide this request.");
      await transaction(async () => {
        const fresh = await db
          .prepare("SELECT status FROM leave_requests WHERE id=?")
          .get(r.id);
        if (fresh.status !== "pending")
          throw new HttpError(409, `This request is already ${fresh.status}.`);
        if (decision === "approved") {
          if (
            !r.unlimited &&
            r.days >
              (await yearBalance(
                db,
                r.user_id,
                r.leave_type_id,
                r.leave_year,
              )) +
                1e-9
          )
            throw new HttpError(
              409,
              "The balance is no longer enough for this request.",
            );
          await db
            .prepare(
              "INSERT INTO leave_ledger(company_id,user_id,leave_type_id,leave_year,kind,days,ref_id,created_by,created_at) VALUES(?,?,?,?,'used',?,?,?,?)",
            )
            .run(
              r.company_id,
              r.user_id,
              r.leave_type_id,
              r.leave_year,
              -r.days,
              r.id,
              user.id,
              now(app),
            );
        } else
          await db
            .prepare("DELETE FROM leave_days WHERE request_id=?")
            .run(r.id);
        await db
          .prepare(
            "UPDATE leave_requests SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?",
          )
          .run(decision, user.id, now(app), note, r.id);
        await app.audit(
          user,
          `leave_${decision}`,
          { id: r.id, employeeId: r.user_id, days: r.days },
          companyId,
        );
      });
      return send(200, { ok: true });
    },
  );
  router.post(
    "/api/leave/requests/:id/cancel",
    async ({ params, user, companyId, send }) => {
      const r = await loadRequest(integer(Number(params.id)), companyId);
      const hr = can(user, "leave.approve") && r.user_id !== user.id;
      if (r.user_id !== user.id && !hr)
        throw new HttpError(403, "You cannot cancel this request.");
      if (!["pending", "approved"].includes(r.status))
        throw new HttpError(409, `This request is already ${r.status}.`);
      if (r.status === "approved" && r.from_date <= today() && !hr)
        throw new HttpError(
          409,
          "Leave that has started can only be cancelled by HR.",
        );
      await transaction(async () => {
        if (r.status === "approved")
          await db
            .prepare(
              "INSERT INTO leave_ledger(company_id,user_id,leave_type_id,leave_year,kind,days,ref_id,created_by,created_at) VALUES(?,?,?,?,'reversal',?,?,?,?)",
            )
            .run(
              r.company_id,
              r.user_id,
              r.leave_type_id,
              r.leave_year,
              r.days,
              r.id,
              user.id,
              now(app),
            );
        await db.prepare("DELETE FROM leave_days WHERE request_id=?").run(r.id);
        await db
          .prepare(
            "UPDATE leave_requests SET status='cancelled',decided_by=?,decided_at=? WHERE id=?",
          )
          .run(user.id, now(app), r.id);
        await app.audit(
          user,
          "leave_cancelled",
          { id: r.id, employeeId: r.user_id },
          companyId,
        );
      });
      return send(200, { ok: true });
    },
  );
}
