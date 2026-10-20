import { HttpError, integer, isoDate, number, oneOf, string } from "../http.js";
import { requireOwned } from "../scope.js";
import { mayDecide, inboxScope } from "../approval.js";
import { leaveYearOf } from "../calendar.js";
import {
  addEntry,
  balances,
  companySettings,
  dayKind,
  ensureAccruals,
  holidayMap,
  round2,
  yearBalance,
} from "../leave-ledger.js";

const plusDays = (d, n) => {
  const x = new Date(`${d}T00:00:00Z`);
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};

/** The compensatory-off leave type, created on first use. */
export async function compOffType(db, companyId, nowIso) {
  const t = await db
    .prepare("SELECT * FROM leave_types WHERE company_id=? AND code='CO'")
    .get(companyId);
  if (t) return t;
  await db
    .prepare(
      "INSERT INTO leave_types(company_id,name,code,paid,unlimited,quota_per_year,accrual,carry_forward_max,allow_half_day,active,encashable,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      companyId,
      "Compensatory Off",
      "CO",
      1,
      0,
      0,
      "yearly",
      30,
      1,
      1,
      0,
      nowIso,
    );
  // Like creating any leave type, this starts the company's leave calendar if it had not started.
  await db
    .prepare(
      "UPDATE companies SET leave_start_year=? WHERE id=? AND leave_start_year IS NULL",
    )
    .run(
      leaveYearOf(
        nowIso.slice(0, 10),
        (await companySettings(db, companyId)).leaveYearStartMonth,
      ),
      companyId,
    );
  return db
    .prepare("SELECT * FROM leave_types WHERE company_id=? AND code='CO'")
    .get(companyId);
}

export function registerCompOff(router, app) {
  const { db, transaction, clock, dayOf } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => dayOf(nowIso());

  const VIEW = `SELECT c.*,u.name employee_name,u.employee_code,d.name decided_by_name FROM comp_off_credits c JOIN users u ON u.id=c.user_id LEFT JOIN users d ON d.id=c.decided_by`;

  router.post("/api/comp-off", async ({ user, body, send, audit }) => {
    const b = await body();
    const day = isoDate(b.worked_on, "Day worked");
    if (!day) throw new HttpError(400, "Choose the day you worked.");
    const t = today();
    if (day > t) throw new HttpError(400, "That day has not happened yet.");
    if (day < plusDays(t, -30))
      throw new HttpError(
        400,
        "Comp-off can be claimed within 30 days of the day worked.",
      );
    const days = Number(b.days ?? 1);
    if (![0.5, 1].includes(days))
      throw new HttpError(400, "Claim half a day or one day.");
    const reason = string(b.reason, "Reason", 300);
    // The day must be one the person was not rostered to work, and they must have worked it.
    const settings = await companySettings(db, user.company_id);
    const holidays = await holidayMap(
      db,
      user.company_id,
      user.branch_id,
      day,
      day,
    );
    const off = await db
      .prepare(
        "SELECT 1 x FROM roster_entries WHERE user_id=? AND date=? AND off=1",
      )
      .get(user.id, day);
    if (!dayKind(day, settings, holidays) && !off)
      throw new HttpError(
        409,
        "That was an ordinary working day. Comp-off is for holidays and weekly offs.",
      );
    const worked = (
      await db
        .prepare(
          "SELECT in_at,day_type FROM shifts WHERE user_id=? AND out_at IS NOT NULL AND in_at>=? AND in_at<=?",
        )
        .all(user.id, plusDays(day, -1), plusDays(day, 2))
    ).filter((s) => dayOf(s.in_at) === day);
    if (!worked.length)
      throw new HttpError(
        409,
        "There is no completed attendance for you on that day.",
      );
    if (days === 1 && !worked.some((s) => s.day_type === "full_day"))
      throw new HttpError(
        409,
        "Only a half day was recorded for that day. Claim half a day.",
      );
    if (
      await db
        .prepare(
          "SELECT id FROM comp_off_credits WHERE user_id=? AND worked_on=? AND status IN ('pending','approved')",
        )
        .get(user.id, day)
    )
      throw new HttpError(
        409,
        "You have already claimed comp-off for that day.",
      );
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO comp_off_credits(company_id,user_id,worked_on,days,reason,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(user.company_id, user.id, day, days, reason, nowIso())
      ).lastInsertRowid,
    );
    await audit("comp_off_requested", { id, day });
    return send(201, { id });
  });
  router.get("/api/comp-off/mine", async ({ user, send }) => {
    const co = await db
      .prepare("SELECT id FROM leave_types WHERE company_id=? AND code='CO'")
      .get(user.company_id);
    const bal = co
      ? (await balances(app, user, today())).find((x) => x.code === "CO")
      : null;
    const c = await db
      .prepare("SELECT comp_off_valid_days v FROM companies WHERE id=?")
      .get(user.company_id);
    return send(200, {
      balance: bal?.balance ?? 0,
      valid_days: c.v,
      credits: await db
        .prepare(`${VIEW} WHERE c.user_id=? ORDER BY c.id DESC LIMIT 50`)
        .all(user.id),
    });
  });
  router.post(
    "/api/comp-off/:id/cancel",
    async ({ user, params, send, audit }) => {
      const c = await requireOwned(
        db,
        "comp_off_credits",
        integer(Number(params.id)),
        user.company_id,
        "claim",
      );
      if (c.user_id !== user.id || c.status !== "pending")
        throw new HttpError(
          409,
          "Only your own pending claims can be cancelled.",
        );
      await db
        .prepare("UPDATE comp_off_credits SET status='cancelled' WHERE id=?")
        .run(c.id);
      await audit("comp_off_cancelled", { id: c.id });
      return send(200, { ok: true });
    },
  );
  router.get("/api/comp-off/pending", async ({ user, send }) => {
    const scope = await inboxScope(app, user);
    if (!scope) return send(200, []);
    return send(
      200,
      await db
        .prepare(
          `SELECT r.*,u.name employee_name,u.employee_code FROM comp_off_credits r JOIN users u ON u.id=r.user_id WHERE r.company_id=? AND r.status='pending' AND r.user_id<>?${scope.sql} ORDER BY r.created_at LIMIT 200`,
        )
        .all(user.company_id, user.id, ...scope.params),
    );
  });
  router.post(
    "/api/comp-off/:id/decision",
    async ({ user, params, body, send, audit }) => {
      const c = await requireOwned(
        db,
        "comp_off_credits",
        integer(Number(params.id)),
        user.company_id,
        "claim",
      );
      if (c.status !== "pending")
        throw new HttpError(409, `This claim is already ${c.status}.`);
      if (!(await mayDecide(app, user, c.user_id)))
        throw new HttpError(403, "You cannot decide this claim.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = b.note ? string(b.note, "Note", 300) : null;
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Say why.");
      const person = await db
        .prepare("SELECT * FROM users WHERE id=?")
        .get(c.user_id);
      const company = await db
        .prepare("SELECT comp_off_valid_days v FROM companies WHERE id=?")
        .get(c.company_id);
      await transaction(async () => {
        let validUntil = null;
        if (decision === "approved") {
          const type = await compOffType(db, c.company_id, nowIso());
          const settings = await companySettings(db, c.company_id);
          const year = leaveYearOf(today(), settings.leaveYearStartMonth);
          await addEntry(
            app,
            person,
            type,
            year,
            "adjustment",
            round2(c.days),
            null,
            `Comp-off for ${c.worked_on}`,
            user.id,
          );
          validUntil = plusDays(today(), company.v);
        }
        await db
          .prepare(
            "UPDATE comp_off_credits SET status=?,decided_by=?,decided_at=?,decision_note=?,valid_until=? WHERE id=?",
          )
          .run(decision, user.id, nowIso(), note, validUntil, c.id);
        await audit("comp_off_decided", { id: c.id, decision });
      });
      await app.notify([c.user_id], {
        companyId: c.company_id,
        kind: "leave",
        title:
          decision === "approved"
            ? `Comp-off approved: ${c.days} day(s)`
            : "Your comp-off claim was not approved",
        body:
          decision === "approved" ? `Use it within ${company.v} days.` : note,
        link: "timeoff",
      });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/comp-off",
    { perm: "leave.read" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(`${VIEW} WHERE c.company_id=? ORDER BY c.id DESC LIMIT 200`)
          .all(companyId),
      ),
  );
  router.put(
    "/api/admin/comp-off/settings",
    { perm: "leave.manage" },
    async ({ companyId, body, send, audit }) => {
      const v = Math.round(
        number((await body()).valid_days, "Days valid", 7, 365),
      );
      await db
        .prepare("UPDATE companies SET comp_off_valid_days=? WHERE id=?")
        .run(v, companyId);
      await audit("comp_off_settings", { valid_days: v });
      return send(200, { valid_days: v });
    },
  );

  // ---- team leave calendar: who is away, and how many are in ----------------------------------
  router.get("/api/team/leave-calendar", async ({ user, query, send }) => {
    const scope = await inboxScope(app, user);
    if (!scope)
      throw new HttpError(
        403,
        "Only managers and HR can see the team calendar.",
      );
    const from = isoDate(query.get("from"), "From");
    const to = isoDate(query.get("to"), "To");
    if (
      !from ||
      !to ||
      to < from ||
      Date.parse(to) - Date.parse(from) > 62 * 86400000
    )
      throw new HttpError(
        400,
        "Choose a from and to date, up to two months apart.",
      );
    const dept = query.get("department_id")
      ? integer(Number(query.get("department_id")))
      : null;
    const members = await db
      .prepare(
        `SELECT r.user_id id,u.name FROM (SELECT id user_id FROM users WHERE company_id=? AND active=1 AND role<>'super_admin'${dept ? " AND department_id=?" : ""}) r JOIN users u ON u.id=r.user_id WHERE 1=1${scope.sql} ORDER BY u.name`,
      )
      .all(user.company_id, ...(dept ? [dept] : []), ...scope.params);
    const ids = new Set(members.map((m) => m.id));
    const rows = (
      await db
        .prepare(
          `SELECT d.day,d.user_id,d.session,r.status,t.code,r.user_id uid FROM leave_days d JOIN leave_requests r ON r.id=d.request_id JOIN leave_types t ON t.id=r.leave_type_id
           WHERE r.company_id=? AND d.day>=? AND d.day<=? AND r.status IN ('pending','approved')${scope.sql}`,
        )
        .all(user.company_id, from, to, ...scope.params)
    ).filter((r) => ids.has(r.user_id));
    const settings = await companySettings(db, user.company_id);
    const holidays = await holidayMap(db, user.company_id, null, from, to);
    const days = [];
    for (let d = from; d <= to; d = plusDays(d, 1)) {
      const away = new Map();
      for (const r of rows.filter((x) => x.day === d)) {
        const a = away.get(r.user_id) ?? {
          user_id: r.user_id,
          name: members.find((m) => m.id === r.user_id).name,
          sessions: 0,
          codes: new Set(),
          pending: false,
        };
        a.sessions++;
        a.codes.add(r.code);
        if (r.status === "pending") a.pending = true;
        away.set(r.user_id, a);
      }
      const list = [...away.values()].map((a) => ({
        user_id: a.user_id,
        name: a.name,
        half: a.sessions === 1,
        codes: [...a.codes],
        pending: a.pending,
      }));
      const off = dayKind(d, settings, holidays);
      days.push({
        date: d,
        off: off ?? null,
        holiday: holidays.get(d) ?? null,
        away: list,
        in_count: off
          ? null
          : members.length - list.filter((a) => !a.half).length,
      });
    }
    return send(200, { team_size: members.length, days });
  });
}

/** Removes comp-off that was not used in time (oldest first, never below zero). */
export async function expireCompOffs(app) {
  const { db } = app;
  const now = app.dayOf(new Date(app.clock()).toISOString());
  const due = await db
    .prepare(
      "SELECT * FROM comp_off_credits WHERE status='approved' AND expiry_done=0 AND valid_until<? ORDER BY valid_until,id",
    )
    .all(now);
  for (const c of due) {
    const person = await db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(c.user_id);
    const type = await db
      .prepare("SELECT * FROM leave_types WHERE company_id=? AND code='CO'")
      .get(c.company_id);
    // Bring the ledger up to date first so anything carried into this leave year is counted.
    const settings = await ensureAccruals(app, person, now);
    const year = leaveYearOf(now, settings.leaveYearStartMonth);
    const unused = Math.min(
      c.days,
      Math.max(await yearBalance(db, c.user_id, type.id, year), 0),
    );
    if (unused > 0)
      await addEntry(
        app,
        person,
        type,
        year,
        "adjustment",
        -round2(unused),
        null,
        `Comp-off for ${c.worked_on} expired`,
        null,
      );
    await db
      .prepare(
        "UPDATE comp_off_credits SET expiry_done=1,expired_days=? WHERE id=?",
      )
      .run(unused, c.id);
    if (unused > 0)
      await app.notify([c.user_id], {
        companyId: c.company_id,
        kind: "leave",
        title: `${unused} day(s) of comp-off expired`,
        body: `Earned on ${c.worked_on}.`,
        link: "timeoff",
      });
  }
  return due.length;
}
export function scheduleCompOffExpiry(app) {
  const run = () =>
    expireCompOffs(app).catch((e) =>
      console.error("Comp-off expiry failed:", e.message),
    );
  void run();
  setInterval(run, 6 * 3600000).unref();
}
