// Pure date logic for holidays, weekly offs, leave years and time zones.
// Dates are "YYYY-MM-DD" strings; weekdays are 0 (Sunday) to 6 (Saturday).
const MS_DAY = 86400000;
const utc = (d) => {
  const [y, m, day] = d.split("-").map(Number);
  return Date.UTC(y, m - 1, day);
};
const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);

export const addDays = (date, n) => fmt(utc(date) + n * MS_DAY);
export const daysBetween = (from, to) =>
  Math.round((utc(to) - utc(from)) / MS_DAY);
export const weekday = (date) => new Date(utc(date)).getUTCDay();
export function* eachDay(from, to) {
  for (let d = from; d <= to; d = addDays(d, 1)) yield d;
}
export const monthOf = (date) => date.slice(0, 7);
export const monthRange = (month) => {
  const [y, m] = month.split("-").map(Number);
  return { from: `${month}-01`, to: fmt(Date.UTC(y, m, 0)) };
};
// 1 for the first Saturday (or any weekday) of its month, 2 for the second…
export const occurrenceInMonth = (date) =>
  Math.ceil(Number(date.slice(8, 10)) / 7);

/** Weekly off: whole weekdays (e.g. Sunday) plus chosen Saturdays (e.g. 2nd and 4th). */
export function isWeeklyOff(date, { days = [0], saturdays = [] } = {}) {
  const wd = weekday(date);
  if (days.includes(wd)) return true;
  return wd === 6 && saturdays.includes(occurrenceInMonth(date));
}

/** The leave year containing `date`, named by the calendar year it starts in. */
export const leaveYearOf = (date, startMonth = 1) => {
  const [y, m] = date.split("-").map(Number);
  return m >= startMonth ? y : y - 1;
};
export function leaveYearRange(year, startMonth = 1) {
  const from = `${year}-${String(startMonth).padStart(2, "0")}-01`;
  const endYear = startMonth === 1 ? year : year + 1;
  const endMonth = startMonth === 1 ? 12 : startMonth - 1;
  return {
    from,
    to: monthRange(`${endYear}-${String(endMonth).padStart(2, "0")}`).to,
  };
}
// 1..12: how far into its leave year a date is.
export const monthIndexInYear = (date, startMonth = 1) =>
  ((Number(date.slice(5, 7)) - startMonth + 12) % 12) + 1;

// Offset of `tz` from UTC at an instant, in ms (positive east of Greenwich).
function offsetMs(ms, tz) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(new Date(ms))
      .map((x) => [x.type, x.value]),
  );
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(ms / 1000) * 1000;
}
/** Wall-clock `date` + "HH:MM" in `tz` as UTC milliseconds. */
export function localToUtcMs(date, hhmm, tz) {
  const [h, m] = hhmm.split(":").map(Number);
  const [y, mo, d] = date.split("-").map(Number);
  const wall = Date.UTC(y, mo - 1, d, h, m);
  let guess = wall - offsetMs(wall, tz);
  guess = wall - offsetMs(guess, tz);
  return guess;
}
