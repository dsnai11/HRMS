import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import {
  addDays,
  daysBetween,
  eachDay,
  isWeeklyOff,
  leaveYearOf,
  leaveYearRange,
  localToUtcMs,
  monthIndexInYear,
  monthRange,
  occurrenceInMonth,
  weekday,
} from "../server/calendar.js";

const PW = "Temporary-pass-123";
const IST = (s) => Date.parse(`${s}+05:30`);

test("calendar: weekly offs, leave years and time zones", () => {
  assert.equal(weekday("2026-10-19"), 1);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.equal(daysBetween("2026-10-01", "2026-10-19"), 18);
  assert.deepEqual(
    [...eachDay("2026-10-30", "2026-11-02")],
    ["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"],
  );
  assert.deepEqual(monthRange("2028-02"), {
    from: "2028-02-01",
    to: "2028-02-29",
  });
  assert.equal(occurrenceInMonth("2026-10-10"), 2);
  const off = { days: [0], saturdays: [2, 4] };
  assert.equal(isWeeklyOff("2026-10-04", off), true, "Sunday");
  assert.equal(isWeeklyOff("2026-10-10", off), true, "2nd Saturday");
  assert.equal(isWeeklyOff("2026-10-24", off), true, "4th Saturday");
  assert.equal(isWeeklyOff("2026-10-03", off), false, "1st Saturday");
  assert.equal(isWeeklyOff("2026-10-31", off), false, "5th Saturday");
  assert.equal(isWeeklyOff("2026-10-19", off), false);
  assert.equal(leaveYearOf("2027-02-10", 1), 2027);
  assert.equal(leaveYearOf("2027-02-10", 4), 2026, "financial year");
  assert.equal(leaveYearOf("2027-04-01", 4), 2027);
  assert.equal(monthIndexInYear("2026-04-05", 4), 1);
  assert.equal(monthIndexInYear("2027-03-05", 4), 12);
  assert.deepEqual(leaveYearRange(2026, 4), {
    from: "2026-04-01",
    to: "2027-03-31",
  });
  assert.deepEqual(leaveYearRange(2026, 1), {
    from: "2026-01-01",
    to: "2026-12-31",
  });
  assert.equal(
    localToUtcMs("2026-10-19", "09:30", "Asia/Kolkata"),
    IST("2026-10-19T09:30:00"),
  );
  assert.equal(
    localToUtcMs("2026-07-01", "09:30", "America/New_York"),
    Date.parse("2026-07-01T13:30:00Z"),
    "daylight saving",
  );
  assert.equal(
    localToUtcMs("2026-12-01", "09:30", "America/New_York"),
    Date.parse("2026-12-01T14:30:00Z"),
  );
});

const secrets = new Map();
async function world(t, nowIso = "2026-10-19T10:00:00+05:30") {
  let nowMs = Date.parse(nowIso);
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha",
  });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method = "POST") => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
    };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
      .padEnd(16, "0")
      .slice(0, 64);
    const r = await call("/login", {
      email,
      password,
      native: true,
      device: { id, platform: "android", model: "T", secret: secrets.get(id) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (
    await call(
      "/admin/workplaces",
      {
        name: "Office",
        latitude: 26.9124,
        longitude: 75.7873,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const email = `${key}@example.test`;
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email,
        password: PW,
        workplace_id: site,
        date_of_joining: "2026-01-01",
        gender: "male",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(email) };
    return people[key];
  };
  await add("hr", { role: "hr" });
  await add("m");
  await add("x");
  await add("a", { manager_id: people.m.id });
  await add("c", { manager_id: people.m.id });
  await add("j", { manager_id: people.m.id, date_of_joining: "2026-07-15" });
  await add("f", { manager_id: people.m.id, gender: "female" });
  const hr = people.hr.token;
  return {
    db,
    call,
    owner,
    hr,
    people,
    site,
    setNow: (iso) => (nowMs = Date.parse(iso)),
    signIn,
    add,
  };
}
const balance = async (w, who, code) =>
  (await w.call("/leave/balances", undefined, w.people[who].token)).data.find(
    (b) => b.code === code,
  );
const apply = (w, who, body) =>
  w.call("/leave/requests", body, w.people[who].token);
const decide = (w, token, id, decision = "approved") =>
  w.call(`/leave/requests/${id}/decision`, { decision }, token);

test("leave accrues monthly, pro-rates joiners, and carries forward", async (t) => {
  const w = await world(t);
  // Nothing accrues until leave is set up; then only from that year on.
  assert.deepEqual(
    (await w.call("/leave/balances", undefined, w.people.a.token)).data,
    [],
  );
  assert.equal(
    (await w.call("/admin/leave-types/seed-defaults", {}, w.people.a.token))
      .status,
    403,
  );
  assert.equal(
    (await w.call("/admin/leave-types/seed-defaults", {}, w.hr)).data.created,
    5,
  );
  assert.equal(
    (await w.call("/admin/leave-types/seed-defaults", {}, w.hr)).data.created,
    0,
    "idempotent",
  );
  assert.equal(
    (await w.call("/admin/leave-settings", undefined, w.hr)).data
      .leave_start_year,
    2026,
  );

  // October: ten months accrued.
  assert.equal((await balance(w, "a", "CL")).balance, 10);
  assert.equal((await balance(w, "a", "SL")).balance, 5.83);
  assert.equal((await balance(w, "a", "EL")).balance, 12.5);
  assert.equal((await balance(w, "a", "LWP")).balance, null, "unlimited");
  assert.equal(
    await balance(w, "a", "ML"),
    undefined,
    "maternity does not apply to men",
  );
  assert.equal((await balance(w, "f", "ML")).balance, 182);
  // A joiner on 15 July accrues from July (month 7 of 12).
  assert.equal((await balance(w, "j", "CL")).balance, 4);
  assert.equal((await balance(w, "j", "EL")).balance, 5);
  // Repeating changes nothing.
  assert.equal((await balance(w, "a", "CL")).balance, 10);

  // By December the year totals the quota exactly, however it rounds monthly.
  w.setNow("2026-12-31T10:00:00+05:30");
  for (const [code, total] of [
    ["CL", 12],
    ["SL", 7],
    ["EL", 15],
  ])
    assert.equal((await balance(w, "a", code)).balance, total);
  assert.equal((await balance(w, "j", "CL")).balance, 6);

  // January: earned leave carries forward (up to 30); casual leave lapses.
  w.setNow("2027-01-15T10:00:00+05:30");
  assert.equal((await balance(w, "a", "CL")).balance, 1);
  assert.equal(
    (await balance(w, "a", "EL")).balance,
    16.25,
    "15 carried + 1.25 accrued",
  );
  assert.equal((await balance(w, "a", "SL")).balance, 0.58);
  const ledger = (
    await w.call(`/admin/employees/${w.people.a.id}/leave`, undefined, w.hr)
  ).data.ledger;
  assert.ok(ledger.some((l) => l.kind === "carry_forward" && l.days === 15));

  // Bulk accrual and manual adjustment.
  assert.equal(
    (await w.call("/admin/leave/accrue", {}, w.hr)).data.employees >= 7,
    true,
  );
  const adj = {
    user_id: w.people.a.id,
    leave_type_id: (
      await w.call("/admin/leave-types", undefined, w.hr)
    ).data.find((x) => x.code === "CL").id,
    days: 2,
  };
  assert.equal(
    (await w.call("/admin/leave/adjust", adj, w.hr)).status,
    400,
    "reason required",
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave/adjust",
        { ...adj, note: "Opening balance" },
        w.hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave/adjust",
        { ...adj, note: "x" },
        w.people.a.token,
      )
    ).status,
    403,
  );
  assert.equal((await balance(w, "a", "CL")).balance, 3);
});

test("applying, approving, rejecting and cancelling leave", async (t) => {
  const w = await world(t);
  await w.call("/admin/leave-types/seed-defaults", {}, w.hr);
  const cl = (await w.call("/admin/leave-types", undefined, w.hr)).data.find(
    (x) => x.code === "CL",
  ).id;
  const el = (await w.call("/admin/leave-types", undefined, w.hr)).data.find(
    (x) => x.code === "EL",
  ).id;
  const lwp = (await w.call("/admin/leave-types", undefined, w.hr)).data.find(
    (x) => x.code === "LWP",
  ).id;
  const ml = (await w.call("/admin/leave-types", undefined, w.hr)).data.find(
    (x) => x.code === "ML",
  ).id;

  const first = await apply(w, "a", {
    leave_type_id: cl,
    from_date: "2026-10-21",
    to_date: "2026-10-23",
    reason: "Family",
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.days, 3);
  let cl_a = await balance(w, "a", "CL");
  assert.deepEqual(
    [cl_a.balance, cl_a.pending, cl_a.available],
    [10, 3, 7],
    "pending leave is reserved",
  );

  // Validation.
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: cl,
        from_date: "2026-10-22",
        to_date: "2026-10-22",
        half_day: "first",
      })
    ).status,
    409,
    "overlap",
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: el,
        from_date: "2026-11-02",
        to_date: "2026-11-28",
      })
    ).status,
    422,
    "too many days",
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: cl,
        from_date: "2026-12-30",
        to_date: "2027-01-02",
      })
    ).status,
    400,
    "crosses leave year",
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: cl,
        from_date: "2026-10-30",
        to_date: "2026-10-29",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: cl,
        from_date: "2026-10-27",
        to_date: "2026-10-28",
        half_day: "first",
      })
    ).status,
    400,
    "half day needs one day",
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: ml,
        from_date: "2026-11-02",
        to_date: "2026-11-03",
      })
    ).status,
    403,
    "gender",
  );
  assert.equal(
    (await apply(w, "a", { leave_type_id: 999999, from_date: "2026-11-02" }))
      .status,
    400,
  );
  // Sundays do not count; holidays do not count.
  const c1 = await apply(w, "c", {
    leave_type_id: cl,
    from_date: "2026-10-23",
    to_date: "2026-10-27",
  });
  assert.equal(c1.data.days, 4, "Fri, Sat, Mon, Tue (Sunday skipped)");
  assert.equal(
    (
      await w.call(
        "/admin/holidays",
        { date: "2026-10-29", name: "Local holiday" },
        w.hr,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await apply(w, "c", {
        leave_type_id: cl,
        from_date: "2026-10-28",
        to_date: "2026-10-30",
      })
    ).data.days,
    2,
  );
  assert.equal(
    (await apply(w, "c", { leave_type_id: cl, from_date: "2026-10-29" }))
      .status,
    400,
    "a holiday needs no leave",
  );
  assert.equal(
    (
      await apply(w, "c", {
        leave_type_id: lwp,
        from_date: "2026-11-01",
        to_date: "2026-11-01",
      })
    ).status,
    400,
    "Sunday only",
  );
  // Half days and unlimited unpaid leave.
  assert.equal(
    (
      await apply(w, "c", {
        leave_type_id: cl,
        from_date: "2026-11-03",
        half_day: "second",
      })
    ).data.days,
    0.5,
  );
  assert.equal(
    (
      await apply(w, "c", {
        leave_type_id: lwp,
        from_date: "2026-11-09",
        to_date: "2026-12-04",
      })
    ).status,
    201,
  );

  // Approval authority.
  assert.equal(
    (await decide(w, w.people.x.token, first.data.id)).status,
    403,
    "not their manager",
  );
  assert.equal(
    (await decide(w, w.people.a.token, first.data.id)).status,
    403,
    "not own",
  );
  const hrOwn = await apply(w, "hr", {
    leave_type_id: lwp,
    from_date: "2026-11-10",
  });
  assert.equal(
    (await decide(w, w.hr, hrOwn.data.id)).status,
    403,
    "HR cannot approve their own",
  );
  assert.equal(
    (await decide(w, w.owner, hrOwn.data.id)).status,
    200,
    "someone else can",
  );
  assert.equal(
    (await decide(w, w.people.m.token, first.data.id)).status,
    200,
    "manager approves",
  );
  assert.equal(
    (await decide(w, w.hr, first.data.id)).status,
    409,
    "already decided",
  );
  cl_a = await balance(w, "a", "CL");
  assert.deepEqual([cl_a.balance, cl_a.pending, cl_a.available], [7, 0, 7]);
  // Rejecting frees the dates and costs nothing.
  assert.equal((await decide(w, w.hr, c1.data.id, "rejected")).status, 200);
  assert.equal(
    (
      await apply(w, "c", {
        leave_type_id: cl,
        from_date: "2026-10-23",
        to_date: "2026-10-27",
      })
    ).status,
    201,
  );
  assert.equal((await balance(w, "c", "CL")).balance, 10);

  // Inbox: the manager sees their team's pending requests, never their own.
  const inbox = (await w.call("/approvals", undefined, w.people.m.token)).data;
  assert.ok(
    inbox.leave.length >= 3 &&
      inbox.leave.every((r) => r.employee_name !== "M"),
  );
  assert.equal(
    (await w.call("/approvals", undefined, w.people.x.token)).data.leave.length,
    0,
  );
  assert.ok(
    (await w.call("/approvals", undefined, w.hr)).data.leave.length >=
      inbox.leave.length,
  );
  assert.ok(
    (await w.call("/me", undefined, w.people.m.token)).data.approvals_pending >=
      3,
  );

  // Cancelling: approved future leave returns the days; started leave is HR's call.
  assert.equal(
    (
      await w.call(
        `/leave/requests/${first.data.id}/cancel`,
        {},
        w.people.x.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await w.call(
        `/leave/requests/${first.data.id}/cancel`,
        {},
        w.people.a.token,
      )
    ).status,
    200,
  );
  assert.equal((await balance(w, "a", "CL")).balance, 10);
  assert.equal(
    (
      await w.call(
        `/leave/requests/${first.data.id}/cancel`,
        {},
        w.people.a.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await apply(w, "a", {
        leave_type_id: cl,
        from_date: "2026-10-21",
        to_date: "2026-10-23",
      })
    ).status,
    201,
    "dates are free again",
  );
  const started = await apply(w, "j", {
    leave_type_id: lwp,
    from_date: "2026-10-19",
  });
  assert.equal(
    (await decide(w, w.people.m.token, started.data.id)).status,
    200,
  );
  assert.equal(
    (
      await w.call(
        `/leave/requests/${started.data.id}/cancel`,
        {},
        w.people.j.token,
      )
    ).status,
    409,
  );
  assert.equal(
    (await w.call(`/leave/requests/${started.data.id}/cancel`, {}, w.hr))
      .status,
    200,
  );

  // HR's request list, and company isolation of requests.
  const list = (
    await w.call(
      "/admin/leave/requests?status=pending&limit=5",
      undefined,
      w.hr,
    )
  ).data;
  assert.ok(list.total >= 4 && list.items.length <= 5);
  assert.equal(
    (await w.call("/admin/leave/requests", undefined, w.people.a.token)).status,
    403,
  );
  assert.equal(
    (await w.call(`/admin/holidays?year=2026`, undefined, w.hr)).data.length,
    1,
  );
  assert.equal(
    (
      await w.call(
        `/admin/holidays/${(await w.call("/admin/holidays?year=2026", undefined, w.hr)).data[0].id}`,
        undefined,
        w.hr,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await w.call("/holidays?year=2026", undefined, w.people.a.token)).data
      .length,
    0,
  );
});

const ids = async (w) => {
  const types = (await w.call("/admin/leave-types", undefined, w.hr)).data;
  return Object.fromEntries(types.map((x) => [x.code, x.id]));
};
const shiftsOn = async (w, date) =>
  (await w.call(`/admin/attendance?from=${date}&to=${date}`, undefined, w.hr))
    .data;
const regularize = (w, who, body) =>
  w.call("/regularizations", body, w.people[who].token);
const decideReg = (w, token, id, decision = "approved") =>
  w.call(`/regularizations/${id}/decision`, { decision }, token);

test("attendance corrections follow the rules and rebuild the day", async (t) => {
  const w = await world(t);
  await w.call("/admin/leave-types/seed-defaults", {}, w.hr);
  const type = await ids(w);
  const full = {
    kind: "missed_punch",
    in_time: "09:30",
    out_time: "18:30",
    reason: "Forgot to punch",
  };

  // Requests are validated.
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-01" })).status,
    422,
    "outside the 7-day window",
  );
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-11" })).status,
    422,
    "8 days back",
  );
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-20" })).status,
    400,
    "future",
  );
  assert.equal(
    (
      await regularize(w, "a", {
        ...full,
        date: "2026-10-16",
        in_time: undefined,
      })
    ).status,
    400,
    "times needed",
  );
  assert.equal(
    (
      await regularize(w, "a", {
        ...full,
        date: "2026-10-16",
        out_time: "09:00",
      })
    ).status,
    400,
    "out before in",
  );
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-16", reason: "" }))
      .status,
    400,
  );
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-16", kind: "nap" }))
      .status,
    400,
  );

  const a1 = await regularize(w, "a", { ...full, date: "2026-10-16" });
  assert.equal(a1.status, 201);
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-16" })).status,
    409,
    "one pending per day",
  );
  // Only the reporting line or HR decides.
  assert.equal((await decideReg(w, w.people.x.token, a1.data.id)).status, 403);
  assert.equal((await decideReg(w, w.people.a.token, a1.data.id)).status, 403);
  assert.equal((await decideReg(w, w.people.m.token, a1.data.id)).status, 200);
  assert.equal(
    (await decideReg(w, w.hr, a1.data.id)).status,
    409,
    "already decided",
  );
  let [row] = (await shiftsOn(w, "2026-10-16")).filter(
    (r) => r.employee_name === "A",
  );
  assert.equal(row.source, "regularized");
  assert.equal(row.day_type, "full_day");
  assert.equal(Date.parse(row.in_at), IST("2026-10-16T09:30:00"));
  assert.equal(Date.parse(row.out_at), IST("2026-10-16T18:30:00"));

  // A late arrival is a half day, exactly as for a real punch.
  const late = await regularize(w, "c", {
    ...full,
    date: "2026-10-15",
    in_time: "09:50",
    out_time: "18:50",
  });
  assert.equal((await decideReg(w, w.hr, late.data.id)).status, 200);
  [row] = (await shiftsOn(w, "2026-10-15")).filter(
    (r) => r.employee_name === "C",
  );
  assert.equal(row.day_type, "half_day");
  assert.deepEqual(JSON.parse(row.half_day_reasons), ["late_in"]);
  // On duty and work from home count as full days without times.
  const duty = await regularize(w, "c", {
    kind: "on_duty",
    date: "2026-10-14",
    reason: "Client visit",
  });
  assert.equal(
    (await decideReg(w, w.people.m.token, duty.data.id)).status,
    200,
  );
  [row] = (await shiftsOn(w, "2026-10-14")).filter(
    (r) => r.employee_name === "C",
  );
  assert.deepEqual([row.source, row.day_type], ["on_duty", "full_day"]);
  assert.equal(Date.parse(row.in_at), IST("2026-10-14T09:30:00"));
  assert.equal(Date.parse(row.out_at), IST("2026-10-14T18:30:00"));

  // Rejections change nothing; cancelling is for the owner's own pending requests.
  const rej = await regularize(w, "c", { ...full, date: "2026-10-13" });
  assert.equal((await decideReg(w, w.hr, rej.data.id, "rejected")).status, 200);
  assert.equal((await shiftsOn(w, "2026-10-13")).length, 0);

  // The monthly limit (changeable by HR).
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { regularization_monthly_limit: 2 },
        w.people.a.token,
        "PATCH",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { regularization_monthly_limit: 2 },
        w.hr,
        "PATCH",
      )
    ).status,
    200,
  );
  const a2 = await regularize(w, "a", { ...full, date: "2026-10-14" });
  assert.equal(a2.status, 201);
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-13" })).status,
    422,
    "limit reached",
  );
  assert.equal(
    (
      await w.call(
        `/regularizations/${a2.data.id}/cancel`,
        {},
        w.people.x.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await w.call(
        `/regularizations/${a2.data.id}/cancel`,
        {},
        w.people.a.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await regularize(w, "a", { ...full, date: "2026-10-13" })).status,
    201,
    "a cancelled request frees the allowance",
  );

  // A day of approved leave cannot also be corrected.
  const leave = await apply(w, "j", {
    leave_type_id: type.LWP,
    from_date: "2026-10-13",
  });
  assert.equal((await decide(w, w.people.m.token, leave.data.id)).status, 200);
  assert.equal(
    (await regularize(w, "j", { ...full, date: "2026-10-13" })).status,
    409,
  );

  // An unclosed shift is completed, not duplicated.
  await w.db
    .prepare(
      "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      w.people.x.id,
      w.site,
      "Office",
      26.9124,
      75.7873,
      150,
      50,
      new Date(IST("2026-10-17T09:40:00")).toISOString(),
      26.9124,
      75.7873,
      10,
    );
  const x1 = await regularize(w, "x", {
    ...full,
    kind: "wrong_punch",
    date: "2026-10-17",
  });
  assert.equal((await decideReg(w, w.hr, x1.data.id)).status, 200);
  const xs = (await shiftsOn(w, "2026-10-17")).filter(
    (r) => r.employee_name === "X",
  );
  assert.equal(xs.length, 1);
  assert.equal(Date.parse(xs[0].out_at), IST("2026-10-17T18:30:00"));
  assert.equal(xs[0].day_type, "full_day");

  // Without a workplace there is nowhere to record the shift.
  const n = await w.add("n", { workplace_id: null });
  const n1 = await regularize(w, "n", {
    kind: "work_from_home",
    date: "2026-10-16",
    reason: "WFH",
  });
  assert.equal((await decideReg(w, w.hr, n1.data.id)).status, 422);
  assert.equal(
    (
      await w.call(
        `/admin/employees/${n.id}`,
        { workplace_id: w.site },
        w.hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal((await decideReg(w, w.hr, n1.data.id)).status, 200);

  const approved = (
    await w.call("/admin/regularizations?status=approved", undefined, w.hr)
  ).data;
  assert.ok(approved.length >= 5);
  assert.equal(
    (await w.call("/admin/regularizations", undefined, w.people.a.token))
      .status,
    403,
  );
  assert.equal(
    (await w.call("/regularizations", undefined, w.people.a.token)).data.every(
      (r) => r.employee_name === "A",
    ),
    true,
  );
});

test("the monthly muster counts present, leave, off and absent days for payroll", async (t) => {
  const w = await world(t);
  await w.call("/admin/leave-types/seed-defaults", {}, w.hr);
  const type = await ids(w);
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { weekly_off_saturdays: [2, 4], attendance_start_date: "2026-10-01" },
        w.hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { weekly_off_days: [0, 9] },
        w.hr,
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await w.call(
        "/admin/holidays",
        { date: "2026-10-02", name: "Gandhi Jayanti" },
        w.hr,
      )
    ).status,
    201,
  );
  assert.equal(
    (await w.call("/admin/holidays", { date: "2026-10-02", name: "Dup" }, w.hr))
      .status,
    409,
  );
  const shift = (who, date, dayType) =>
    w.db
      .prepare(
        "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,day_type) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        w.people[who].id,
        w.site,
        "Office",
        26.9124,
        75.7873,
        150,
        50,
        new Date(IST(`${date}T09:30:00`)).toISOString(),
        26.9124,
        75.7873,
        10,
        new Date(IST(`${date}T18:30:00`)).toISOString(),
        dayType,
      );
  for (const d of ["01", "03", "05", "06", "07", "08", "09", "12", "17"])
    await shift("c", `2026-10-${d}`, "full_day");
  await shift("c", "2026-10-13", "half_day");
  await shift("c", "2026-10-15", "half_day");
  const cl = await apply(w, "c", {
    leave_type_id: type.CL,
    from_date: "2026-10-14",
  });
  assert.equal((await decide(w, w.people.m.token, cl.data.id)).status, 200);
  const lwp = await apply(w, "c", {
    leave_type_id: type.LWP,
    from_date: "2026-10-15",
    half_day: "first",
  });
  assert.equal((await decide(w, w.people.m.token, lwp.data.id)).status, 200);
  // A pending request is not leave yet.
  await apply(w, "c", { leave_type_id: type.CL, from_date: "2026-10-16" });
  await w.add("n", { date_of_joining: "2026-10-10" });

  const summary = (
    await w.call("/admin/attendance-summary?month=2026-10", undefined, w.hr)
  ).data;
  const c = summary.people.find((p) => p.name === "C");
  assert.deepEqual(
    [
      c.present,
      c.half_days,
      c.leave_paid,
      c.leave_unpaid,
      c.holidays,
      c.weekly_offs,
      c.absent,
      c.payable_days,
      c.lop_days,
    ],
    [10, 2, 1, 0.5, 1, 4, 1.5, 16, 2],
  );
  const n = summary.people.find((p) => p.name === "N");
  assert.deepEqual(
    [n.weekly_offs, n.absent, n.present, n.payable_days, n.lop_days],
    [3, 6, 0, 3, 6],
    "days before joining are not counted",
  );
  assert.ok(
    !summary.people.some((p) => p.name === "OWNER"),
    "the platform owner is not in the muster",
  );
  assert.equal(
    (await w.call("/admin/attendance-summary?month=2026-13", undefined, w.hr))
      .status,
    400,
  );
  assert.equal(
    (await w.call("/admin/attendance-summary", undefined, w.people.a.token))
      .status,
    403,
  );

  // The same month, day by day, for the employee themself.
  const mine = (
    await w.call(
      "/attendance/calendar?month=2026-10",
      undefined,
      w.people.c.token,
    )
  ).data;
  const at = (d) => mine.days.find((x) => x.date === d).status;
  assert.deepEqual(
    ["02", "04", "10", "13", "14", "15", "16", "17", "19", "20"].map((d) =>
      at(`2026-10-${d}`),
    ),
    [
      "holiday",
      "weekly_off",
      "weekly_off",
      "half_day",
      "leave",
      "half_day_and_leave",
      "absent",
      "present",
      "pending",
      "future",
    ],
  );
  assert.equal(
    mine.days.find((x) => x.date === "2026-10-02").holiday,
    "Gandhi Jayanti",
  );

  const csv = await w.call(
    "/admin/attendance-summary/export?month=2026-10",
    undefined,
    w.hr,
  );
  assert.match(csv.data, /Payable days/);
  assert.match(csv.data, /"C","/);
});

test("days before the company started using the system are not counted", async (t) => {
  const w = await world(t);
  const calendar = async () =>
    (
      await w.call(
        "/attendance/calendar?month=2026-10",
        undefined,
        w.people.a.token,
      )
    ).data.days;
  const from = (await w.call("/leave/settings", undefined, w.people.a.token))
    .data.attendance_counted_from;
  assert.match(
    from,
    /^\d{4}-\d{2}-\d{2}$/,
    "defaults to the day the company was created",
  );
  for (const d of await calendar())
    if (d.date < from && d.date <= "2026-10-19")
      assert.equal(d.status, "not_started");
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { attendance_start_date: "2026-10-01" },
        w.hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await w.call("/leave/settings", undefined, w.people.a.token)).data
      .attendance_counted_from,
    "2026-10-01",
  );
  assert.equal(
    (await calendar()).find((d) => d.date === "2026-10-01").status,
    "absent",
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { attendance_start_date: "10/01/2026" },
        w.hr,
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await w.call(
        "/admin/leave-settings",
        { attendance_start_date: null },
        w.hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await w.call("/leave/settings", undefined, w.people.a.token)).data
      .attendance_counted_from,
    from,
  );
});
