import { can, permissionsFor } from "./rbac.js";
import { mayDecide } from "./approval.js";
import { withDelegates } from "./delegation.js";

// Multi-level leave approval. A company lists the steps a request passes through
// (leave_chain); each approval moves it to the next step and the last one approves
// it. HR (leave.approve) may act at any step. A step nobody can fill, such as the
// manager's manager for someone whose manager reports to no one, is skipped.
export const STEPS = {
  manager: "Reporting manager",
  skip_manager: "Manager's manager",
  hr: "HR",
};

// kind: "leave" or "correction" (attendance corrections have their own chain).
export async function chainOf(db, companyId, kind = "leave") {
  const column = kind === "correction" ? "correction_chain" : "leave_chain";
  const c = await db
    .prepare(`SELECT ${column} chain FROM companies WHERE id=?`)
    .get(companyId);
  const steps = JSON.parse(c?.chain || '["manager"]').filter(
    (s) => STEPS[s],
  );
  return steps.length ? steps : ["manager"];
}

async function managerOf(db, id) {
  return (await db.prepare("SELECT manager_id FROM users WHERE id=?").get(id))
    ?.manager_id;
}

// People who may act at a step (besides HR, who always may), with whoever stands in for
// them today; the requester is never one of them.
export async function stepApprovers(db, companyId, requesterId, step) {
  if (step === "manager") {
    const m = await managerOf(db, requesterId);
    return m ? (await withDelegates(db, [m])).filter((id) => id !== requesterId) : [];
  }
  if (step === "skip_manager") {
    const m = await managerOf(db, requesterId);
    const mm = m ? await managerOf(db, m) : null;
    return mm && mm !== requesterId ? (await withDelegates(db, [mm])).filter((id) => id !== requesterId) : [];
  }
  return hrApprovers(db, companyId, requesterId);
}

// Everyone in the company who may approve anyone's leave.
export async function hrApprovers(db, companyId, exceptId = 0) {
  const rows = await db
    .prepare(
      `SELECT u.id,u.role,u.branch_id,r.permissions,r.branch_ids FROM users u LEFT JOIN custom_roles r ON r.id=u.custom_role_id
       WHERE u.company_id=? AND u.active=1 AND u.id<>? AND u.role IN ('admin','hr','custom')`,
    )
    .all(companyId, exceptId);
  return rows
    .filter((u) =>
      u.role === "custom"
        ? JSON.parse(u.permissions || "[]").includes("leave.approve")
        : permissionsFor(u.role).includes("leave.approve"),
    )
    .map((u) => u.id);
}

// Moves past steps nobody can fill. Returns the index of the next step to wait on,
// or chain.length when nothing is left (the request is fully approved).
export async function nextStep(db, companyId, requesterId, chain, from) {
  let i = from;
  while (
    i < chain.length &&
    chain[i] !== "hr" &&
    !(await stepApprovers(db, companyId, requesterId, chain[i])).length
  )
    i += 1;
  return i;
}

// May this person act on the request at its current step?
export async function mayDecideStep(app, approver, request, chain) {
  if (approver.id === request.user_id) return false;
  const step = chain[request.step] ?? "hr";
  if (can(approver, "leave.approve"))
    return mayDecide(app, approver, request.user_id);
  if (step === "hr") return false;
  // With only a manager step, anyone above in the reporting line may act, as before;
  // when the chain also has the manager's manager, the first step is the direct manager.
  if (step === "manager" && !chain.includes("skip_manager"))
    return mayDecide(app, approver, request.user_id);
  return (
    await stepApprovers(app.db, request.company_id, request.user_id, step)
  ).includes(approver.id);
}

// Reminds approvers about leave and attendance corrections waiting too long at their
// step, and once one has waited past the escalation time, tells HR. Runs hourly.
const PENDING = [
  ["leave_requests", "leave", "leave"],
  ["regularizations", "correction", "attendance correction"],
];
export async function sendApprovalReminders(app) {
  const { db } = app;
  const now = app.clock();
  const chains = new Map();
  let reminded = 0,
    escalated = 0;
  for (const [table, kind, what] of PENDING) {
    const rows = await db
      .prepare(
        `SELECT r.id,r.company_id,r.user_id,r.step,r.step_at,r.created_at,r.reminded_at,r.escalated_at,u.name,
           c.approval_reminder_hours rh,c.approval_escalate_hours eh
         FROM ${table} r JOIN users u ON u.id=r.user_id JOIN companies c ON c.id=r.company_id
         WHERE r.status='pending' AND c.active=1`,
      )
      .all();
    for (const r of rows) {
      const key = `${kind}:${r.company_id}`;
      if (!chains.has(key))
        chains.set(key, await chainOf(db, r.company_id, kind));
      const step = chains.get(key)[r.step] ?? "hr";
      const waiting = now - Date.parse(r.step_at || r.created_at);
      const hours = Math.floor(waiting / 3600000);
      if (!r.escalated_at && waiting >= r.eh * 3600000) {
        await app.notify(await hrApprovers(db, r.company_id, r.user_id), {
          companyId: r.company_id,
          kind: "approval",
          title: `Escalated: ${r.name}'s ${what} has waited ${hours} hours`,
          body: `Still waiting for: ${STEPS[step]}. HR can decide it.`,
          link: "approvals",
          email: true,
          sms: true,
        });
        await db
          .prepare(`UPDATE ${table} SET escalated_at=? WHERE id=?`)
          .run(new Date(now).toISOString(), r.id);
        escalated += 1;
      } else if (
        now - Date.parse(r.reminded_at || r.step_at || r.created_at) >=
        r.rh * 3600000
      ) {
        await app.notify(
          await stepApprovers(db, r.company_id, r.user_id, step),
          {
            companyId: r.company_id,
            kind: "approval",
            title: `Reminder: ${r.name}'s ${what} is waiting for you`,
            body: `Waiting ${hours} hours for: ${STEPS[step]}.`,
            link: "approvals",
          },
        );
        await db
          .prepare(`UPDATE ${table} SET reminded_at=? WHERE id=?`)
          .run(new Date(now).toISOString(), r.id);
        reminded += 1;
      }
    }
  }
  return { reminded, escalated };
}
export function scheduleApprovalReminders(app) {
  const run = () =>
    sendApprovalReminders(app).catch((e) =>
      console.error("Approval reminders failed:", e.message),
    );
  void run();
  setInterval(run, 3600000).unref();
}
