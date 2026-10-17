// Shift rules: punch in by START + grace, work SHIFT_HOURS, and never leave
// before EARLIEST_OUT. Missing either rule makes the day a half day.
const clock = (value, name) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) throw new Error(`${name} must look like 09:30.`);
  return Number(m[1]) * 60 + Number(m[2]);
};
export function loadPolicy(env = process.env) {
  const hours = Number(env.SHIFT_HOURS ?? 9),
    grace = Number(env.LATE_GRACE_MINUTES ?? 15);
  if (!(hours > 0 && hours <= 16)) throw new Error("SHIFT_HOURS must be 1–16.");
  if (!(grace >= 0 && grace <= 240))
    throw new Error("LATE_GRACE_MINUTES must be 0–240.");
  return {
    startMinutes: clock(env.SHIFT_START ?? "09:30", "SHIFT_START"),
    graceMinutes: grace,
    hours,
    earliestOutMinutes: clock(env.EARLIEST_OUT ?? "18:30", "EARLIEST_OUT"),
  };
}
export const DEFAULT_POLICY = loadPolicy({});

function localParts(ms, timezone) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  return {
    minutes: Number(p.hour) * 60 + Number(p.minute),
    seconds: Number(p.second),
  };
}

/** Rules fixed at punch-in: lateness and the earliest allowed punch-out. */
export function evaluatePunchIn(policy, inMs, timezone) {
  const { minutes, seconds } = localParts(inMs, timezone);
  const msIntoDay = (minutes * 60 + seconds) * 1000;
  const earliestOut = inMs - msIntoDay + policy.earliestOutMinutes * 60000;
  return {
    late: minutes > policy.startMinutes + policy.graceMinutes,
    requiredOutAt: new Date(
      Math.max(inMs + policy.hours * 3600000, earliestOut),
    ).toISOString(),
  };
}

/** Half-day reasons once a shift is closed (or already known at punch-in). */
export function halfDayReasons({ late, requiredOutAt, outMs }) {
  const reasons = [];
  if (late) reasons.push("late_in");
  if (outMs !== undefined && outMs < Date.parse(requiredOutAt))
    reasons.push("early_out");
  return reasons;
}
