import { staffWith } from "./scope.js";

// Helpdesk tickets that miss their response time move up the line, once per level:
//   level 1, past due              → the assignee's reporting manager and the helpdesk team;
//                                    the ticket becomes high priority
//   level 2, past due by another   → the company's final escalation person (admins if none)
//            full response time
// "Response time" is the hours set for the ticket's priority when it was opened (due_at − created_at).
export async function escalateTickets(app) {
  const { db } = app;
  const now = new Date(app.clock()).toISOString();
  const rows = await db
    .prepare(
      `SELECT t.id,t.company_id,t.subject,t.created_at,t.due_at,t.escalation_level,t.assigned_to,
              a.manager_id assignee_manager,u.name raised_by,c.ticket_escalate_to
       FROM tickets t JOIN users u ON u.id=t.user_id JOIN companies c ON c.id=t.company_id
       LEFT JOIN users a ON a.id=t.assigned_to
       WHERE t.status IN ('open','in_progress') AND t.due_at IS NOT NULL AND t.due_at<? AND t.escalation_level<2`,
    )
    .all(now);
  let moved = 0;
  for (const t of rows) {
    const window = Math.max(3600000, Date.parse(t.due_at) - Date.parse(t.created_at));
    const late = Date.parse(now) - Date.parse(t.due_at);
    const level = late >= window ? 2 : 1;
    if (level <= t.escalation_level) continue;
    const to = new Set();
    if (t.escalation_level < 1) {
      if (t.assignee_manager) to.add(t.assignee_manager);
      for (const s of await staffWith(db, t.company_id, ["helpdesk.manage"])) to.add(s.id);
    }
    if (level === 2) {
      const top = t.ticket_escalate_to
        ? await db.prepare("SELECT id FROM users WHERE id=? AND active=1").get(t.ticket_escalate_to)
        : null;
      if (top) to.add(top.id);
      else
        for (const a of await db
          .prepare("SELECT id FROM users WHERE company_id=? AND role='admin' AND active=1")
          .all(t.company_id))
          to.add(a.id);
    }
    await db
      .prepare("UPDATE tickets SET escalation_level=?,escalated_at=?,priority='high' WHERE id=?")
      .run(level, now, t.id);
    const hours = Math.round(late / 3600000);
    await app.notify([...to], {
      companyId: t.company_id,
      kind: "ticket",
      title: `Escalated (level ${level}): ticket #${t.id} ${t.subject}`,
      body: `${t.raised_by}'s helpdesk ticket "${t.subject}" is ${hours} ${hours === 1 ? "hour" : "hours"} past its response time and still not resolved.`,
      link: "helpdesk",
      email: true,
    });
    await app.audit(null, "ticket_escalated", { id: t.id, level }, t.company_id);
    moved += 1;
  }
  return moved;
}
export function scheduleTicketEscalation(app) {
  const run = () => escalateTickets(app).catch((e) => console.error("Ticket escalation failed:", e.message));
  void run();
  setInterval(run, 30 * 60000).unref();
}
