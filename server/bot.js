// Laxmi, the HR assistant. Common questions are answered by rules from the
// asker's own records; anything else is searched in the company knowledge base
// and policies. An optional Claude fallback (ANTHROPIC_API_KEY) answers free
// text, but only from the facts gathered here about the asking person: it has
// no tools and sees no one else's records.
import { addDays, weekday, localToUtcMs } from "./calendar.js";
import { balances, holidayMap } from "./leave-ledger.js";
import { computeMuster } from "./muster.js";
import { pendingApprovals } from "./approval.js";
import { TEAM_SQL } from "./attendance-report.js";
import { can } from "./rbac.js";
import { GUIDE, isHrTeam } from "./hr-guide.js";

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const STOP = new Set(
  "the a an and or of to for in on at is are am be was were do does did i me my we our you your it its this that what when where who how which can could should would will with from about any have has please tell know want need there their them than then also just get".split(
    " ",
  ),
);

const pad = (n) => String(n).padStart(2, "0");
const validDay = (y, m, d) => {
  const iso = `${y}-${pad(m)}-${pad(d)}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso
    ? iso
    : null;
};
// "Sat 31 Oct 2026"
export const longDate = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const cap = (x) => x[0].toUpperCase() + x.slice(1);
  return `${cap(DAYS[d.getUTCDay()])} ${d.getUTCDate()} ${cap(MONTHS[d.getUTCMonth()])} ${d.getUTCFullYear()}`;
};
const rupees = (n) =>
  `₹${Number(n ?? 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const plural = (n, word) => `${n} ${word}${Number(n) === 1 ? "" : "s"}`;
const monthName = (ym) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${ym}-01T00:00:00Z`));

/**
 * Dates mentioned in free text, in the order they appear, as YYYY-MM-DD.
 * Understands today, tomorrow, day after tomorrow, weekday names (the next one
 * after today), 2026-11-12, 12/11/2026 (day first), "12 Nov" and "Nov 12".
 * A day and month without a year that is more than 30 days past means next year.
 */
export function datesIn(text, today) {
  const t = text.toLowerCase();
  const found = [];
  const yearFor = (m, d, y) => {
    if (y) return y < 100 ? 2000 + y : y;
    const ty = Number(today.slice(0, 4));
    const iso = validDay(ty, m, d);
    return iso && iso < addDays(today, -30) ? ty + 1 : ty;
  };
  const push = (index, iso) => iso && found.push({ index, iso });
  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g))
    push(m.index, validDay(+m[1], +m[2], +m[3]));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g))
    push(m.index, validDay(yearFor(+m[2], +m[1], m[3] && +m[3]), +m[2], +m[1]));
  const mon = "(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\\.?";
  for (const m of t.matchAll(
    new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon}(?:,?\\s+(\\d{4}))?`, "g"),
  )) {
    const mo = MONTHS.indexOf(m[2]) + 1;
    push(m.index, validDay(yearFor(mo, +m[1], m[3] && +m[3]), mo, +m[1]));
  }
  for (const m of t.matchAll(
    new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, "g"),
  )) {
    const mo = MONTHS.indexOf(m[1]) + 1;
    push(m.index, validDay(yearFor(mo, +m[2], m[3] && +m[3]), mo, +m[2]));
  }
  const dat = t.indexOf("day after tomorrow");
  if (dat >= 0) push(dat, addDays(today, 2));
  for (const m of t.matchAll(/\btomorrow\b/g))
    if (dat < 0 || m.index !== dat + "day after ".length)
      push(m.index, addDays(today, 1));
  for (const m of t.matchAll(/\btoday\b/g)) push(m.index, today);
  for (const m of t.matchAll(
    /\b(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday)?\b/g,
  )) {
    const want = DAYS.indexOf(m[1].slice(0, 3));
    const ahead = ((want - weekday(today) + 7) % 7) || 7;
    push(m.index, addDays(today, ahead));
  }
  return found.sort((a, b) => a.index - b.index).map((f) => f.iso);
}

const words = (text) =>
  (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(
    (w) => w.length > 2 && !STOP.has(w),
  );
const stem = (w) => w.replace(/(ies|es|s|ing|ed)$/, "");

/** The best knowledge-base entries and policies for a question, best first. */
export async function searchKnowledge(db, companyId, question, limit = 3) {
  if (!words(question).length) return [];
  const entries = [
    ...(
      await db
        .prepare(
          "SELECT id,title,body,keywords FROM bot_knowledge WHERE company_id=? AND active=1",
        )
        .all(companyId)
    ).map((e) => ({ ...e, kind: "knowledge" })),
    ...(
      await db
        .prepare(
          "SELECT id,title,body,'' keywords FROM policies WHERE company_id=? AND active=1",
        )
        .all(companyId)
    ).map((e) => ({ ...e, kind: "policy" })),
  ];
  return rank(entries, question, limit);
}

// Scores entries ({title, body, keywords}) against a question: a word in the title
// or keywords counts 3, one in the body 1.
function rank(entries, question, limit) {
  const q = [...new Set(words(question).map(stem))];
  if (!q.length) return [];
  const scored = entries.map((e) => {
    const head = new Set(words(`${e.title} ${e.keywords}`).map(stem));
    const body = new Set(words(e.body).map(stem));
    let score = 0,
      headHits = 0;
    for (const w of q) {
      if (head.has(w)) (score += 3), headHits++;
      else if (body.has(w)) score += 1;
    }
    return { ...e, score, headHits };
  });
  return scored
    .filter((e) => e.headHits > 0 || e.score >= 2)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}

const excerpt = (body, max = 700) => {
  const s = body.trim();
  return s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`;
};

export function nextPayday(today, payDay) {
  const at = (ym) => {
    const [y, m] = ym.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    return `${ym}-${pad(Math.min(payDay, last))}`;
  };
  const thisMonth = at(today.slice(0, 7));
  if (thisMonth >= today) return thisMonth;
  const [y, m] = today.slice(0, 7).split("-").map(Number);
  return at(m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`);
}

// The HR guide as searchable entries; the body is the numbered steps and tips.
const GUIDE_ENTRIES = GUIDE.map((g) => ({
  id: g.id,
  kind: "guide",
  title: g.title,
  keywords: `${g.area} ${g.keywords}`,
  body: [
    `Who: ${g.who}.`,
    ...g.steps.map((x, i) => `${i + 1}. ${x}`),
    ...g.tips.map((x) => `Tip: ${x}`),
  ].join("\n"),
}));
/** HR guide topics matching a question, best first. Callers must check isHrTeam. */
export const searchGuide = (question, limit = 2) =>
  rank(GUIDE_ENTRIES, question, limit);

// ---- facts about the asking person ----------------------------------------------------------------
const today = (app) => app.dayOf(new Date(app.clock()).toISOString());

async function holidaysAhead(app, user, n = 5) {
  const from = today(app);
  const map = await holidayMap(
    app.db,
    user.company_id,
    user.branch_id,
    from,
    addDays(from, 365),
  );
  return [...map]
    .map(([date, name]) => ({ date, name }))
    .filter((h) => h.date >= from)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, n);
}
async function payInfo(app, user) {
  const c = await app.db
    .prepare("SELECT pay_day FROM companies WHERE id=?")
    .get(user.company_id);
  const last = await app.db
    .prepare(
      "SELECT r.month,r.paid_on FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.user_id=? AND r.status='paid' ORDER BY r.month DESC LIMIT 1",
    )
    .get(user.id);
  return {
    pay_day: c?.pay_day ?? null,
    next_payday: c?.pay_day ? nextPayday(today(app), c.pay_day) : null,
    last_paid: last ? { month: last.month, paid_on: last.paid_on } : null,
  };
}
const lastPayslip = (app, user) =>
  app.db
    .prepare(
      "SELECT r.month,r.status,i.gross,i.deductions,i.net FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.user_id=? AND r.status IN ('approved','paid') ORDER BY r.month DESC LIMIT 1",
    )
    .get(user.id);
async function attendanceMonth(app, user) {
  const r = await computeMuster(app, {
    companyId: user.company_id,
    month: today(app).slice(0, 7),
    userIds: [user.id],
  });
  const p = r.people[0];
  if (!p) return null;
  const { days, user_id, employee_code, name, department_name, ...totals } = p;
  const open = await app.db
    .prepare("SELECT in_at FROM shifts WHERE user_id=? AND out_at IS NULL")
    .get(user.id);
  return { month: r.month, ...totals, punched_in_since: open?.in_at ?? null };
}

/** Everything the fallback may see: only the asking person's own records. */
export async function factsFor(app, user) {
  const [leave, holidays, pay, payslip, attendance] = await Promise.all([
    balances(app, user, today(app)),
    holidaysAhead(app, user),
    payInfo(app, user),
    lastPayslip(app, user),
    attendanceMonth(app, user),
  ]);
  return {
    today: today(app),
    name: user.name,
    leave_balances: leave.map((b) => ({
      type: b.name,
      code: b.code,
      available: b.unlimited ? "unlimited" : b.available,
      pending_requests_days: b.pending,
    })),
    upcoming_holidays: holidays,
    pay,
    latest_payslip: payslip ?? null,
    attendance_this_month: attendance,
  };
}

// ---- rules ------------------------------------------------------------------------------------------
const HELP = `I'm Laxmi, your HR assistant. Try asking:
• "What is my leave balance?"
• "Apply casual leave on 12 Nov" (I fill in the form, you confirm)
• "Next holidays"
• "When is payday?" or "Show my last payslip"
• "My attendance this month"
• "My leave history" or "Status of my leave"
• "My training" (courses assigned and completed)
• Managers: "Who in my team is on leave today?"
Anything else, I look up in the company knowledge base and policies.`;

const isManager = async (app, user) =>
  Boolean(
    await app.db
      .prepare("SELECT id FROM users WHERE manager_id=? AND active=1 LIMIT 1")
      .get(user.id),
  );

const GENERIC = new Set(["leave", "off", "day", "paid", "special"]);
function leaveTypeIn(text, types) {
  const t = text.toLowerCase();
  if (/\b(lwp|lop|unpaid|without pay|loss of pay)\b/.test(t))
    return types.find((x) => x.unlimited || x.code === "LWP") ?? null;
  const has = (w) => new RegExp(`\\b${w.replace(/[^a-z0-9]/g, "")}\\b`).test(t);
  return (
    types.find((x) => has(x.code.toLowerCase())) ??
    types.find((x) => t.includes(x.name.toLowerCase())) ??
    types.find((x) => {
      const first = x.name.toLowerCase().split(/\s+/)[0];
      return !GENERIC.has(first) && has(first);
    }) ??
    null
  );
}

async function leaveDraft(app, user, q) {
  const types = await balances(app, user, today(app));
  const dates = datesIn(q, today(app));
  const type = leaveTypeIn(q, types);
  const options = types.map((b) => ({
    leave_type_id: b.leave_type_id,
    name: b.name,
    available: b.unlimited ? null : b.available,
    allow_half_day: b.allow_half_day,
  }));
  if (!dates.length)
    return {
      intent: "leave_apply",
      text: `Which dates? For example: "apply ${type ? type.name.toLowerCase() : "casual leave"} on ${longDate(addDays(today(app), 1)).replace(/^\w+ /, "")}", "leave tomorrow", or "leave from 12 Nov to 14 Nov".`,
    };
  const from = dates[0];
  let to = dates[1] && dates[1] >= from ? dates[1] : from;
  const forDays = /\bfor\s+(\d{1,2})\s+days?\b/i.exec(q);
  if (forDays && !dates[1]) to = addDays(from, Math.max(1, +forDays[1]) - 1);
  const half =
    from === to && /\bhalf[\s-]?day\b/i.test(q)
      ? /\b(second half|afternoon|post[\s-]?lunch)\b/i.test(q)
        ? "second"
        : "first"
      : null;
  const reason = /\b(?:because|reason[:\s]|for my|due to)\s*(.{3,200})$/i.exec(q)?.[1] ?? null;
  return {
    intent: "leave_apply",
    text: `Here is your leave request${type ? "" : " (choose the leave type)"}. Check it and press Confirm to send it for approval. Holidays and weekly offs in the range are not counted.`,
    action: {
      type: "leave_request",
      leave_type_id: type?.leave_type_id ?? null,
      from_date: from,
      to_date: to,
      half_day: half,
      reason,
      options,
    },
  };
}

async function leaveBalance(app, user) {
  const b = await balances(app, user, today(app));
  if (!b.length)
    return {
      intent: "leave_balance",
      text: "No leave types apply to you yet. Please check with HR.",
    };
  return {
    intent: "leave_balance",
    text: `Your leave balance for ${b[0].year}:\n${b
      .map(
        (x) =>
          `• ${x.name}: ${x.unlimited ? "no limit" : `${x.available} day(s) available`}${x.pending ? ` (${x.pending} pending approval)` : ""}`,
      )
      .join("\n")}`,
    links: ["timeoff"],
  };
}

async function holidays(app, user) {
  const list = await holidaysAhead(app, user);
  return {
    intent: "holidays",
    text: list.length
      ? `Upcoming holidays:\n${list.map((h) => `• ${longDate(h.date)}: ${h.name}`).join("\n")}`
      : "There are no upcoming holidays on the calendar yet.",
    links: ["timeoff"],
  };
}

async function payday(app, user) {
  const p = await payInfo(app, user);
  const parts = [];
  if (p.next_payday)
    parts.push(
      `Salary is credited on day ${p.pay_day} of each month (or the month's last day). Your next payday is ${longDate(p.next_payday)}.`,
    );
  if (p.last_paid)
    parts.push(
      `Your last salary, for ${monthName(p.last_paid.month)}, was paid${p.last_paid.paid_on ? ` on ${longDate(p.last_paid.paid_on.slice(0, 10))}` : ""}.`,
    );
  if (!parts.length)
    parts.push("HR has not set a pay day yet. Please ask on the Helpdesk.");
  return { intent: "payday", text: parts.join(" "), links: ["payslips"] };
}

async function payslip(app, user) {
  const s = await lastPayslip(app, user);
  return {
    intent: "payslip",
    text: s
      ? `Your latest payslip is for ${monthName(s.month)}: gross ${rupees(s.gross)}, deductions ${rupees(s.deductions)}, net pay ${rupees(s.net)}. Open Payslips to download it.`
      : "You have no payslips yet. They appear once payroll for a month is approved.",
    links: ["payslips"],
  };
}

async function attendance(app, user) {
  const a = await attendanceMonth(app, user);
  if (!a)
    return {
      intent: "attendance",
      text: "There is no attendance to show for this month yet.",
      links: ["mine"],
    };
  const lines = [
    `• Present: ${a.present} day(s)${a.half_days ? `, including ${plural(a.half_days, "half day")}` : ""}`,
    `• Leave: ${a.leave_paid + a.leave_unpaid} day(s)${a.leave_unpaid ? ` (${a.leave_unpaid} unpaid)` : ""}`,
    `• Holidays and weekly offs: ${a.holidays + a.weekly_offs}`,
    `• Absent: ${a.absent} day(s)`,
  ];
  return {
    intent: "attendance",
    text: `Your attendance for ${monthName(a.month)} so far:\n${lines.join("\n")}${a.punched_in_since ? "\nYou are punched in now." : ""}${a.absent ? "\nIf a day is wrong, ask for a correction under Time off." : ""}`,
    links: ["mine", "timeoff"],
  };
}

const shortDate = (d) =>
  new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(`${d}T00:00:00Z`),
  );

async function leaveHistory(app, user) {
  const rows = await app.db
    .prepare(
      `SELECT r.from_date,r.to_date,r.days,r.half_day,r.status,t.name type FROM leave_requests r
       JOIN leave_types t ON t.id=r.leave_type_id WHERE r.user_id=? ORDER BY r.from_date DESC,r.id DESC LIMIT 8`,
    )
    .all(user.id);
  if (!rows.length)
    return {
      intent: "leave_history",
      text: "You have not applied for any leave yet.",
      links: ["timeoff"],
    };
  const status = { pending: "waiting for approval", approved: "approved", rejected: "not approved", cancelled: "cancelled" };
  const lines = rows.map(
    (r) =>
      `• ${shortDate(r.from_date)}${r.to_date !== r.from_date ? `–${shortDate(r.to_date)}` : ""}: ${r.type}, ${r.half_day ? "half day" : plural(r.days, "day")}, ${status[r.status]}`,
  );
  const waiting = rows.filter((r) => r.status === "pending").length;
  return {
    intent: "leave_history",
    text: `Your recent leave:
${lines.join("\n")}${waiting ? `\n${plural(waiting, "request")} still waiting for approval.` : ""}`,
    links: ["timeoff"],
  };
}

async function training(app, user) {
  const rows = await app.db
    .prepare(
      `SELECT t.title,t.mandatory,t.due_date,r.status,r.completed_on,r.score FROM training_records r
       JOIN trainings t ON t.id=r.training_id WHERE r.user_id=? ORDER BY r.status='completed',t.due_date,t.id`,
    )
    .all(user.id);
  if (!rows.length)
    return { intent: "training", text: "No training has been assigned to you.", links: ["learning"] };
  const open = rows.filter((r) => r.status !== "completed");
  const done = rows.filter((r) => r.status === "completed");
  const day = today(app);
  const lines = [
    ...open.map(
      (r) =>
        `• ${r.title}${r.mandatory ? " (mandatory)" : ""}: to do${r.due_date ? `, due ${shortDate(r.due_date)}${r.due_date < day ? " (overdue)" : ""}` : ""}`,
    ),
    ...done
      .slice(0, 5)
      .map((r) => `• ${r.title}: completed${r.completed_on ? ` on ${shortDate(r.completed_on.slice(0, 10))}` : ""}${r.score != null ? `, score ${r.score}%` : ""}`),
  ];
  return {
    intent: "training",
    text: `You have completed ${done.length} of ${plural(rows.length, "course")}.\n${lines.join("\n")}`,
    links: ["learning"],
  };
}

async function team(app, user) {
  const manager = await isManager(app, user);
  const companyWide = !manager && can(user, "attendance.read");
  if (!manager && !companyWide)
    return {
      intent: "team",
      text: "Team questions are for managers. You do not have anyone reporting to you.",
    };
  const day = today(app);
  const scope = companyWide
    ? { sql: "SELECT id FROM users WHERE company_id=?", params: [user.company_id] }
    : { sql: TEAM_SQL, params: [user.id] };
  const people = (
    await app.db
      .prepare(
        `SELECT COUNT(*) n FROM users WHERE active=1 AND role<>'super_admin' AND id IN (${scope.sql})`,
      )
      .get(...scope.params)
  ).n;
  const onLeave = await app.db
    .prepare(
      `SELECT DISTINCT u.name FROM leave_days d JOIN leave_requests r ON r.id=d.request_id JOIN users u ON u.id=d.user_id
       WHERE d.day=? AND r.status='approved' AND d.user_id IN (${scope.sql}) ORDER BY u.name LIMIT 30`,
    )
    .all(day, ...scope.params);
  const midnight = new Date(localToUtcMs(day, "00:00", app.timezone)).toISOString();
  const punched = (
    await app.db
      .prepare(
        `SELECT COUNT(DISTINCT user_id) n FROM shifts WHERE in_at>=? AND user_id IN (${scope.sql})`,
      )
      .get(midnight, ...scope.params)
  ).n;
  const pending = await pendingApprovals(app, user);
  return {
    intent: "team",
    text: `${companyWide ? "Company" : "Your team"} today (${people} people):\n• Punched in: ${punched}\n• On approved leave: ${onLeave.length ? onLeave.map((p) => p.name).join(", ") : "nobody"}\n• Waiting for your approval: ${plural(pending, "item")}`,
    links: [pending ? "approvals" : null, manager ? "teamcal" : null].filter(Boolean),
  };
}

// Checked in order; the first match answers.
const RULES = [
  [
    /^\s*(hi|hello|hey|namaste|help|menu|start|what can you do)\b[\s!?.]*$/i,
    () => ({ intent: "help", text: HELP }),
  ],
  [
    /\b(my team|team|reports?|reportees|subordinates)\b.*\b(leave|absent|present|today|attendance|pending|approv)|\bwho(?:'s| is)? (on leave|absent|in) today\b/i,
    team,
  ],
  [
    /\b(leaves?|cl|sl|el|pl)\b.*\b(balance|left|remaining|available|how many)\b|\b(balance|how many|remaining)\b.*\bleaves?\b/i,
    leaveBalance,
  ],
  [
    /\bleaves?\b.*\b(history|status|taken|applied|past|previous|requests?|approved)\b|\b(history|status)\b.*\bleaves?\b|\bmy leaves\s*[?.!]*$/i,
    leaveHistory,
  ],
  [/\b(trainings?|courses?|learning|lms|certifications?)\b/i, training],
  [
    (q, app) =>
      /\b(apply|request|book|take|raise)\b.*\b(leave|day off|half[\s-]?day)\b/i.test(q) ||
      (/\b(leave|half[\s-]?day|day off)\b/i.test(q) &&
        datesIn(q, today(app)).length > 0),
    leaveDraft,
  ],
  [/\bholidays?\b/i, holidays],
  [
    /\bpay ?day\b|\bsalary\b.*\b(when|date|credit|day)\b|\bwhen\b.*\b(paid|salary)\b/i,
    payday,
  ],
  [
    /\bpay ?slips?\b|\bnet pay\b|\btake[\s-]?home\b|\b(last|latest)\s+salary\b/i,
    payslip,
  ],
  [/\battendance\b|\bpunch(ed)?\b|\bpresent days?\b|\babsent\b/i, attendance],
];

const SYSTEM = (company, hrTeam) =>
  `You are Laxmi, the HR assistant for employees of ${company}.${
    hrTeam
      ? "\nThis person works in the HR team. Extracts titled \"HR guide\" explain how to run the HRMS; use them for how-to questions and keep the steps in order."
      : ""
  }
Answer the employee's question using only the facts and knowledge-base extracts in the message. They describe this one employee and their company's published guidance.
If the answer is not in them, say you don't know and suggest raising a ticket on the Helpdesk. Never guess numbers, dates, entitlements or policy terms.
You cannot take actions. To apply for leave they can type, for example, "apply casual leave on 12 Nov".
Reply in at most 120 words of plain text (no markdown headings or tables), in the language the employee wrote in.`;

/** The Claude fallback, or null when ANTHROPIC_API_KEY is not set. */
export function createLlm(env = process.env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  let client;
  return async ({ company, question, facts, extracts, hrTeam = false }) => {
    if (!client) {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      // The portal gives up on a request after 20 seconds.
      client = new Anthropic({
        apiKey: env.ANTHROPIC_API_KEY,
        timeout: 15000,
        maxRetries: 1,
      });
    }
    const model = env.BOT_MODEL || "claude-opus-5-5";
    const request = {
      model,
      max_tokens: 1024,
      output_config: { effort: "low" },
      system: SYSTEM(company, hrTeam),
      messages: [
        {
          role: "user",
          content: `<facts>\n${JSON.stringify(facts)}\n</facts>\n<knowledge>\n${
            extracts
              .map(
                (e) =>
                  `## ${e.kind === "guide" ? "HR guide: " : ""}${e.title}\n${excerpt(e.body, 2000)}`,
              )
              .join("\n\n") || "(nothing relevant found)"
          }\n</knowledge>\n\nEmployee's question: ${question}`,
        },
      ],
    };
    // Server-side fallback when a safety classifier declines (supported models only).
    const response = /^claude-(opus-5|fable-5-1|sonnet-5-5)/.test(model)
      ? await client.beta.messages.create({
          ...request,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        })
      : await client.messages.create(request);
    if (response.stop_reason === "refusal") return null;
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return text || null;
  };
}

const UNANSWERED =
  "I don't have an answer for that yet. Please raise a ticket on the Helpdesk and HR will reply. HR also sees unanswered questions and adds answers over time.";

/** Answers one question: { intent, source, answered, text, action?, links? }. */
export async function answer(app, user, question) {
  for (const [match, rule] of RULES)
    if (typeof match === "function" ? match(question, app) : match.test(question))
      return { source: "rules", answered: true, ...(await rule(app, user, question)) };
  const hrTeam = isHrTeam(user);
  const hits = await searchKnowledge(app.db, user.company_id, question);
  // The HR team also get the HR guide; a guide topic that fits better comes first.
  if (hrTeam) {
    hits.push(...searchGuide(question));
    hits.sort((a, b) => b.score - a.score);
    hits.splice(3);
  }
  const llm = app.botLlm;
  if (llm) {
    try {
      const text = await llm({
        company: app.company,
        question,
        facts: await factsFor(app, user),
        extracts: hits,
        hrTeam,
      });
      if (text)
        return {
          intent: "free_text",
          source: "ai",
          answered: true,
          text,
          links: [
            ...(hits.some((h) => h.kind === "policy") ? ["policies"] : []),
            ...(hits.some((h) => h.kind === "guide") ? ["hrguide"] : []),
          ],
        };
    } catch (e) {
      console.error("assistant fallback failed:", e.message);
    }
  }
  if (hits.length) {
    const [top, ...more] = hits;
    return {
      intent: "knowledge",
      source: top.kind,
      answered: true,
      text: `${top.kind === "guide" ? "HR guide: " : ""}${top.title}\n${excerpt(top.body, top.kind === "guide" ? 2000 : 700)}${more.length ? `\n\nRelated: ${more.map((m) => m.title).join("; ")}` : ""}`,
      links:
        top.kind === "policy"
          ? ["policies"]
          : top.kind === "guide"
            ? ["hrguide"]
            : [],
    };
  }
  return {
    intent: "unknown",
    source: "none",
    answered: false,
    text: UNANSWERED,
    links: ["helpdesk"],
  };
}
