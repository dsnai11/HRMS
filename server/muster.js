import { eachDay, monthRange } from "./calendar.js";
import { companySettings, holidayMap, dayKind } from "./leave-ledger.js";

const round2 = (n) => Math.round(n * 100) / 100;

function statusOf({ present, absent, leaveDays }) {
  if (absent === 1) return "absent";
  if (present === 1) return "present";
  if (present === 0 && leaveDays === 1) return "leave";
  if (present === 0.5 && leaveDays === 0) return "half_day";
  return present === 0.5 ? "half_day_and_leave" : "half_leave";
}

/**
 * Classifies every day of `month` for each person: attendance, approved leave,
 * holidays, weekly offs and absence. Future days and days before joining are
 * left out. This is the input payroll will use for paid and loss-of-pay days.
 */
export async function computeMuster(
  app,
  { companyId, month, userIds, filters = {} },
) {
  const { db } = app;
  const { from, to } = monthRange(month);
  const todayStr = app.dayOf(new Date(app.clock()).toISOString());
  const settings = await companySettings(db, companyId);

  const where = ["u.company_id=?", "u.active=1", "u.role<>'super_admin'"],
    params = [companyId];
  if (userIds) {
    if (!userIds.length) return { month, from, to, people: [] };
    where.push(`u.id IN (${userIds.map(() => "?").join(",")})`);
    params.push(...userIds);
  }
  for (const key of ["department_id", "branch_id"])
    if (filters[key]) {
      where.push(`u.${key}=?`);
      params.push(filters[key]);
    }
  const people = await db
    .prepare(
      `SELECT u.id,u.name,u.employee_code,u.branch_id,u.date_of_joining,u.exit_date,d.name department_name FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE ${where.join(" AND ")} ORDER BY u.name,u.id`,
    )
    .all(...params);
  if (!people.length) return { month, from, to, people: [] };
  const ids = people.map((p) => p.id);
  const inIds = `(${ids.map(() => "?").join(",")})`;

  const shiftOf = new Map();
  for (const s of await db
    .prepare(
      `SELECT id,user_id,in_at,out_at,day_type,source FROM shifts WHERE user_id IN ${inIds} AND in_at>=? AND in_at<?`,
    )
    .all(
      ...ids,
      new Date(Date.parse(from) - 86400000).toISOString(),
      new Date(Date.parse(to) + 2 * 86400000).toISOString(),
    )) {
    const d = app.dayOf(s.in_at);
    if (d >= from && d <= to) shiftOf.set(`${s.user_id}|${d}`, s);
  }

  const leaveOf = new Map();
  for (const l of await db
    .prepare(
      `SELECT d.user_id,d.day,d.paid FROM leave_days d JOIN leave_requests r ON r.id=d.request_id WHERE r.status='approved' AND d.user_id IN ${inIds} AND d.day>=? AND d.day<=?`,
    )
    .all(...ids, from, to)) {
    const k = `${l.user_id}|${l.day}`;
    leaveOf.set(k, [...(leaveOf.get(k) ?? []), l.paid]);
  }

  // Roster entries override the weekly off: a rest day, or a working day on a normal off day.
  const rosterOf = new Map();
  for (const r of await db
    .prepare(
      `SELECT user_id,date,off FROM roster_entries WHERE user_id IN ${inIds} AND date>=? AND date<=?`,
    )
    .all(...ids, from, to))
    rosterOf.set(`${r.user_id}|${r.date}`, r.off);

  const holidayCache = new Map();
  const holidaysFor = async (branchId) => {
    const key = branchId ?? 0;
    if (!holidayCache.has(key))
      holidayCache.set(
        key,
        await holidayMap(db, companyId, branchId, from, to),
      );
    return holidayCache.get(key);
  };

  const out = [];
  for (const p of people) {
    const holidays = await holidaysFor(p.branch_id);
    const days = [];
    const t = {
      present: 0,
      half_days: 0,
      leave_paid: 0,
      leave_unpaid: 0,
      holidays: 0,
      weekly_offs: 0,
      absent: 0,
    };
    for (const date of eachDay(from, to)) {
      if (date > todayStr) {
        days.push({ date, status: "future" });
        continue;
      }
      if (date < settings.attendanceStart) {
        days.push({ date, status: "not_started" });
        continue;
      }
      if (p.date_of_joining && date < p.date_of_joining) {
        days.push({ date, status: "not_joined" });
        continue;
      }
      if (p.exit_date && date > p.exit_date) {
        days.push({ date, status: "exited" });
        continue;
      }
      const s = shiftOf.get(`${p.id}|${date}`);
      const present = s ? (s.day_type === "half_day" ? 0.5 : 1) : 0;
      const slots = leaveOf.get(`${p.id}|${date}`) ?? [];
      const paidLeave = slots.filter((x) => x).length * 0.5,
        unpaidLeave = slots.filter((x) => !x).length * 0.5;
      let off = dayKind(date, settings, holidays);
      const rostered = rosterOf.get(`${p.id}|${date}`);
      if (rostered !== undefined && off !== "holiday")
        off = rostered ? "weekly_off" : null;
      let status;
      // Today is not over: with no punch or leave yet, nothing is counted.
      if (date === todayStr && !off && !s && !slots.length) {
        days.push({ date, status: "pending" });
        continue;
      }
      if (off) {
        t[off === "holiday" ? "holidays" : "weekly_offs"] += 1;
        status = off;
      } else {
        const absent = Math.max(0, 1 - present - paidLeave - unpaidLeave);
        t.present += present;
        if (present === 0.5) t.half_days += 1;
        t.leave_paid += paidLeave;
        t.leave_unpaid += unpaidLeave;
        t.absent += absent;
        status = statusOf({
          present,
          absent,
          leaveDays: paidLeave + unpaidLeave,
        });
      }
      days.push({
        date,
        status,
        present,
        leave: paidLeave + unpaidLeave,
        source: s?.source ?? null,
        in_at: s?.in_at ?? null,
        out_at: s?.out_at ?? null,
        holiday: holidays.get(date) ?? null,
      });
    }
    out.push({
      user_id: p.id,
      employee_code: p.employee_code,
      name: p.name,
      department_name: p.department_name,
      ...Object.fromEntries(Object.entries(t).map(([k, v]) => [k, round2(v)])),
      payable_days: round2(
        t.present + t.leave_paid + t.holidays + t.weekly_offs,
      ),
      lop_days: round2(t.absent + t.leave_unpaid),
      days,
    });
  }
  return { month, from, to, people: out };
}
