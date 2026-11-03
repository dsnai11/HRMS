import { HttpError, integer, isoDate, number, oneOf, optionalString } from "../http.js";
import { mayDecide } from "../approval.js";
import { staffWith } from "../scope.js";

// Optional (restricted) holidays (see migration 063): HR lists them under Leave & holidays;
// each person chooses up to the company's yearly limit, and their manager (or HR) approves.
// An approved choice is a holiday for that person in attendance, leave and payroll.
export function registerOptionalHolidays(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());
  const yearOf = (v) => {
    const y = v ? Number(v) : Number(today().slice(0, 4));
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new HttpError(400, "Choose a valid year.");
    return y;
  };
  const limitOf = async (companyId) =>
    Number(
      (await db.prepare("SELECT optional_holiday_limit FROM companies WHERE id=?").get(companyId))
        ?.optional_holiday_limit ?? 1,
    );
  const offered = (user, y) =>
    db
      .prepare(
        `SELECT DISTINCT date,name FROM holidays WHERE company_id=? AND optional=1 AND date>=? AND date<=?
         AND (branch_id IS NULL OR branch_id=?) ORDER BY date`,
      )
      .all(user.company_id, `${y}-01-01`, `${y}-12-31`, user.branch_id ?? -1);

  async function summary(user, y) {
    const [list, limit, choices] = await Promise.all([
      offered(user, y),
      limitOf(user.company_id),
      db
        .prepare(
          "SELECT id,date,name,status,decision_note FROM optional_holiday_choices WHERE user_id=? AND date>=? AND date<=? AND status<>'cancelled' ORDER BY date,id DESC",
        )
        .all(user.id, `${y}-01-01`, `${y}-12-31`),
    ]);
    const latest = new Map();
    for (const c of choices) if (!latest.has(c.date)) latest.set(c.date, c);
    const live = choices.filter((c) => c.status === "pending" || c.status === "approved");
    const t = today();
    return {
      year: y,
      limit,
      counts: {
        total: list.length,
        max_allowed: limit,
        applied: live.filter((c) => c.status === "pending").length,
        approved: live.filter((c) => c.status === "approved").length,
        remaining: Math.max(limit - live.length, 0),
        taken: live.filter((c) => c.status === "approved" && c.date <= t).length,
      },
      holidays: list.map((h) => {
        const c = latest.get(h.date);
        return {
          date: h.date,
          name: h.name,
          past: h.date < t,
          choice: c ? { id: c.id, status: c.status, note: c.decision_note } : null,
        };
      }),
    };
  }

  router.get("/api/optional-holidays", async ({ user, query, send }) =>
    send(200, await summary(user, yearOf(query.get("year")))),
  );

  // Saves the person's picks for the year: new dates are sent for approval, pending ones left
  // out are withdrawn. Approved choices stay (ask HR to change one).
  router.put("/api/optional-holidays", async ({ user, body, send, audit }) => {
    const b = await body();
    const y = yearOf(b.year);
    if (!Array.isArray(b.dates)) throw new HttpError(400, "Send the chosen dates.");
    const wanted = new Set(b.dates.map((d) => isoDate(d, "Date")));
    const s = await summary(user, y);
    const byDate = new Map(s.holidays.map((h) => [h.date, h]));
    for (const d of wanted) {
      const h = byDate.get(d);
      if (!h) throw new HttpError(400, `${d} is not one of your optional holidays.`);
      if (h.past && h.choice?.status !== "approved" && h.choice?.status !== "pending")
        throw new HttpError(400, `${h.name} has already passed.`);
    }
    const kept = s.holidays.filter((h) => h.choice?.status === "approved" || (h.choice?.status === "pending" && wanted.has(h.date)));
    const added = [...wanted].filter((d) => !byDate.get(d).choice || !["pending", "approved"].includes(byDate.get(d).choice.status));
    if (kept.length + added.length > s.limit)
      throw new HttpError(422, `You can choose at most ${s.limit} optional holiday${s.limit === 1 ? "" : "s"} a year.`);
    const withdrawn = s.holidays.filter((h) => h.choice?.status === "pending" && !wanted.has(h.date));
    await transaction(async () => {
      for (const h of withdrawn)
        await db.prepare("UPDATE optional_holiday_choices SET status='cancelled' WHERE id=? AND status='pending'").run(h.choice.id);
      for (const d of added)
        await db
          .prepare("INSERT INTO optional_holiday_choices(company_id,user_id,date,name,created_at) VALUES(?,?,?,?,?)")
          .run(user.company_id, user.id, d, byDate.get(d).name, nowIso());
    });
    if (added.length || withdrawn.length)
      await audit("optional_holidays_chosen", { year: y, added, withdrawn: withdrawn.map((h) => h.date) });
    if (added.length) {
      const to = user.manager_id
        ? [{ id: user.manager_id }]
        : await staffWith(db, user.company_id, ["leave.approve"], user.id);
      await app.notify(
        to.map((x) => x.id),
        {
          companyId: user.company_id,
          kind: "approval",
          title: `${user.name} chose ${added.length === 1 ? "an optional holiday" : `${added.length} optional holidays`}`,
          body: added.map((d) => `${byDate.get(d).name} (${d})`).join(", "),
          link: "approvals",
        },
      );
    }
    return send(200, await summary(user, y));
  });

  // Choices waiting for this approver: their team, or everyone for HR.
  router.get("/api/optional-holidays/inbox", async ({ user, send }) => {
    const rows = await db
      .prepare(
        `SELECT c.*,u.name employee_name,u.employee_code FROM optional_holiday_choices c JOIN users u ON u.id=c.user_id
         WHERE c.company_id=? AND c.status='pending' AND c.user_id<>? ORDER BY c.date,c.id LIMIT 300`,
      )
      .all(user.company_id, user.id);
    const mine = [];
    for (const r of rows) if (await mayDecide(app, user, r.user_id)) mine.push(r);
    return send(200, mine);
  });

  router.post("/api/optional-holidays/:id/decision", async ({ user, params, companyId, body, send, audit }) => {
    const c = await db
      .prepare("SELECT * FROM optional_holiday_choices WHERE id=? AND company_id=?")
      .get(integer(Number(params.id)), companyId);
    if (!c) throw new HttpError(404, "Choice not found.");
    if (!(await mayDecide(app, user, c.user_id))) throw new HttpError(403, "You cannot decide this request.");
    const b = await body();
    const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
    const note = optionalString(b.note, "Note", 300);
    const r = await db
      .prepare("UPDATE optional_holiday_choices SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=? AND status='pending'")
      .run(decision, user.id, nowIso(), note, c.id);
    if (!r.changes) throw new HttpError(409, "This choice has already been decided.");
    await audit(`optional_holiday_${decision}`, { id: c.id, employeeId: c.user_id, date: c.date });
    await app.notify([c.user_id], {
      companyId,
      kind: "leave",
      title: `Your optional holiday ${c.name} (${c.date}) was ${decision}`,
      body: note ?? undefined,
      link: "timeoff",
    });
    return send(200, { ok: true });
  });

  router.put("/api/admin/optional-holiday-limit", { perm: "leave.manage" }, async ({ companyId, body, send, audit }) => {
    const limit = Math.round(number((await body()).limit, "Optional holidays a year", 0, 30));
    await db.prepare("UPDATE companies SET optional_holiday_limit=? WHERE id=?").run(limit, companyId);
    await audit("optional_holiday_limit_set", { limit });
    return send(200, { ok: true, limit });
  });
  router.get("/api/admin/optional-holiday-limit", { perm: "leave.read" }, async ({ companyId, send }) =>
    send(200, { limit: await limitOf(companyId) }),
  );
}
