import { branchScope, staffWith } from "./scope.js";

// What happens when training is late or failed. The employee's own weekly reminder is in
// routes/learning.js; this tells the people around them, once at each stage.
//   late at all          → reporting manager
//   7 days late          → reporting manager and HR
//   15 days late         → department head (HR if the department has none); mandatory courses only
export const HR_DAYS = 7;
export const HEAD_DAYS = 15;
const DAY = 86400000;
const daysBetween = (from, to) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);
const plusDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const todayOf = (app) => app.dayOf(new Date(app.clock()).toISOString());
const DUE = "COALESCE(r.due_date,t.due_date)";

function digest(items) {
  const late = (i) => `${i.days} ${i.days === 1 ? "day" : "days"} late`;
  if (items.length === 1) {
    const [i] = items;
    return { title: `Overdue training: ${i.name}, ${i.course}`, body: `${i.name} has not finished "${i.course}". It is ${late(i)}.` };
  }
  const shown = items.slice(0, 10).map((i) => `${i.name}: ${i.course} (${late(i)})`);
  if (items.length > 10) shown.push(`and ${items.length - 10} more`);
  return { title: `Overdue training: ${items.length} to follow up`, body: shown.join("\n") };
}

/** Moves every late course on to the stage it has reached; each person gets one message per run. */
export async function escalateOverdueTraining(app) {
  const { db } = app;
  const now = todayOf(app);
  const rows = await db
    .prepare(
      `SELECT r.id,r.user_id,r.escalation_level,t.company_id,t.title,t.mandatory,${DUE} due,u.name,u.manager_id,d.head_id
       FROM training_records r JOIN trainings t ON t.id=r.training_id JOIN users u ON u.id=r.user_id
       LEFT JOIN departments d ON d.id=u.department_id
       WHERE r.status='assigned' AND t.active=1 AND u.active=1 AND ${DUE} IS NOT NULL AND ${DUE}<? AND r.escalation_level<3`,
    )
    .all(now);
  const hrOf = new Map();
  const hr = async (companyId) => {
    if (!hrOf.has(companyId)) hrOf.set(companyId, (await staffWith(db, companyId, ["performance.manage"])).map((p) => p.id));
    return hrOf.get(companyId);
  };
  const inbox = new Map(); // "company:user" → items
  const moved = [];
  for (const r of rows) {
    const days = daysBetween(r.due, now);
    const stage = days >= HEAD_DAYS && r.mandatory ? 3 : days >= HR_DAYS ? 2 : 1;
    if (stage <= r.escalation_level) continue;
    const to = new Set();
    for (let s = r.escalation_level + 1; s <= stage; s++) {
      if (s <= 2 && r.manager_id) to.add(r.manager_id);
      if (s === 2) for (const id of await hr(r.company_id)) to.add(id);
      if (s === 3) {
        if (r.head_id) to.add(r.head_id);
        else for (const id of await hr(r.company_id)) to.add(id);
      }
    }
    to.delete(r.user_id);
    const item = { name: r.name, course: r.title, days };
    for (const id of to) {
      const key = `${r.company_id}:${id}`;
      if (!inbox.has(key)) inbox.set(key, []);
      inbox.get(key).push(item);
    }
    moved.push({ id: r.id, stage });
  }
  for (const [key, items] of inbox) {
    const [companyId, userId] = key.split(":").map(Number);
    await app.notify([userId], { companyId, kind: "training", link: "learning", email: true, ...digest(items) });
  }
  for (const m of moved) await db.prepare("UPDATE training_records SET escalation_level=? WHERE id=?").run(m.stage, m.id);
  return moved.length;
}

/** Someone has used every quiz attempt: nobody else would otherwise know they are stuck. */
export async function alertAttemptsUsed(app, user, course, score, passMark, recordId) {
  const { db } = app;
  const best = await db.prepare("SELECT MAX(score) s FROM training_attempts WHERE record_id=?").get(recordId);
  const me = await db.prepare("SELECT manager_id FROM users WHERE id=?").get(user.id);
  const hr = (await staffWith(db, user.company_id, ["performance.manage"], user.id)).map((p) => p.id);
  await app.notify([me?.manager_id, ...hr].filter((id) => id && id !== user.id), {
    companyId: user.company_id,
    kind: "training",
    title: `${user.name} has used all quiz attempts: ${course}`,
    body: `Best score ${best?.s ?? score}%, pass mark ${passMark}%. HR can allow more attempts under LMS → Manage courses → Overdue and failed.`,
    link: "learning",
    email: true,
  });
}

/** user id → mandatory courses 15 or more days late, shown beside appraisals and probation reviews. */
export async function longOverdueTraining(app, companyId) {
  const rows = await app.db
    .prepare(
      `SELECT r.user_id,t.title FROM training_records r JOIN trainings t ON t.id=r.training_id
       WHERE t.company_id=? AND t.active=1 AND t.mandatory=1 AND r.status='assigned' AND ${DUE} IS NOT NULL AND ${DUE}<=? ORDER BY t.title`,
    )
    .all(companyId, plusDays(todayOf(app), -HEAD_DAYS));
  const out = new Map();
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), r.title]);
  return out;
}

const STAGE = ["Employee reminded", "Manager told", "HR told", "Department head told"];

export function registerTrainingFollowup(router, app) {
  const { db } = app;
  const list = async (companyId, where, params) => {
    const now = todayOf(app);
    const rows = await db
      .prepare(
        `SELECT r.id,r.user_id,r.attempts,r.escalation_level,t.title,t.mandatory,t.kind,t.max_attempts,${DUE} due,
                u.name,u.employee_code,m.name manager_name,b.name branch,d.name department
         FROM training_records r JOIN trainings t ON t.id=r.training_id JOIN users u ON u.id=r.user_id
         LEFT JOIN users m ON m.id=u.manager_id LEFT JOIN branches b ON b.id=u.branch_id LEFT JOIN departments d ON d.id=u.department_id
         WHERE t.company_id=? AND t.active=1 AND u.active=1 AND r.status='assigned'
           AND ((${DUE} IS NOT NULL AND ${DUE}<?) OR (t.kind='course' AND t.max_attempts>0 AND r.attempts>=t.max_attempts))
           ${where}
         ORDER BY ${DUE},u.name`,
      )
      .all(companyId, now, ...params);
    return rows.map((r) => ({
      ...r,
      days_late: r.due && r.due < now ? daysBetween(r.due, now) : 0,
      out_of_attempts: r.kind === "course" && r.max_attempts > 0 && r.attempts >= r.max_attempts,
      stage: r.due && r.due < now ? STAGE[r.escalation_level] : "Manager and HR told",
    }));
  };

  router.get("/api/admin/learning-followup", { perm: "performance.manage" }, async ({ user, companyId, send }) => {
    const scope = branchScope(user, "r.user_id");
    return send(200, await list(companyId, scope.sql, scope.params));
  });

  // A manager's direct reports, and for a department head everyone in the department.
  router.get("/api/learning-team", async ({ user, send }) => {
    const team = await db
      .prepare(
        "SELECT u.id FROM users u LEFT JOIN departments d ON d.id=u.department_id WHERE u.company_id=? AND u.active=1 AND u.id<>? AND (u.manager_id=? OR d.head_id=?) LIMIT 1",
      )
      .get(user.company_id, user.id, user.id, user.id);
    if (!team) return send(200, { has_team: false, rows: [] });
    return send(200, {
      has_team: true,
      rows: await list(user.company_id, "AND u.id<>? AND (u.manager_id=? OR d.head_id=?)", [user.id, user.id, user.id]),
    });
  });
}
