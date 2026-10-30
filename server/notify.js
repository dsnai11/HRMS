// In-app notifications, with email when a mail provider is configured
// (RESEND_API_KEY and MAIL_FROM). Notifications are best-effort: a failure here
// never fails the action that caused it.
import { SMS_KINDS, sendSms, smsConfigured } from "./sms.js";

export function createNotifier(app, env = process.env) {
  const { db, clock } = app;
  const mailConfigured = () => Boolean(env.RESEND_API_KEY && env.MAIL_FROM);

  async function sendMail(row) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: env.MAIL_FROM,
          to: [row.to_email],
          subject: row.subject,
          text: row.body,
          ...(row.attachments ? { attachments: row.attachments } : {}),
        }),
      });
      if (!res.ok) throw new Error(`Mail provider answered ${res.status}`);
      await db
        .prepare("UPDATE email_outbox SET status='sent',sent_at=? WHERE id=?")
        .run(new Date(clock()).toISOString(), row.id);
    } catch (e) {
      await db
        .prepare("UPDATE email_outbox SET status='failed',error=? WHERE id=?")
        .run(String(e.message).slice(0, 300), row.id);
    }
  }

  // The mail provider accepts a few messages a second (Resend: 2 by default), so mail
  // to many people waits in a queue and goes out at that pace (MAIL_PER_SECOND).
  const perSecond = Math.max(1, Number(env.MAIL_PER_SECOND) || 2);
  const queue = [];
  let windowStart = 0,
    inWindow = 0,
    pump = null;
  function dispatch(row) {
    const now = Date.now();
    if (now - windowStart >= 1000) (windowStart = now), (inWindow = 0);
    if (!queue.length && inWindow < perSecond) {
      inWindow++;
      void sendMail(row);
      return;
    }
    queue.push(row);
    pump ??= setInterval(() => {
      for (let i = 0; i < perSecond && queue.length; i++) void sendMail(queue.shift());
      if (!queue.length) {
        clearInterval(pump);
        pump = null;
      }
    }, 1000);
  }
  // After a restart, mail still waiting from the last day goes out.
  async function resumeQueue() {
    if (!mailConfigured()) return 0;
    const rows = await db
      .prepare("SELECT id,to_email,subject,body FROM email_outbox WHERE status='pending' AND created_at>? ORDER BY id LIMIT 20000")
      .all(new Date(clock() - 86400000).toISOString());
    for (const r of rows) dispatch(r);
    return rows.length;
  }

  /** Plain email to anyone (e.g. a candidate with no login yet); resolves false if mail is not configured. */
  async function mail(companyId, to, subject, body, attachments) {
    if (!mailConfigured() || !to) return false;
    const outbox = Number(
      (
        await db
          .prepare(
            "INSERT INTO email_outbox(company_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?)",
          )
          .run(companyId, to, subject, body, new Date(clock()).toISOString())
      ).lastInsertRowid,
    );
    dispatch({ id: outbox, to_email: to, subject, body, attachments });
    return true;
  }

  /** notify([userId…], { companyId, kind, title, body, link, email, sms }) */
  async function notify(userIds, n) {
    try {
      const ids = [...new Set(userIds.filter(Boolean))];
      const at = new Date(clock()).toISOString();
      // Written 500 at a time: an announcement to 5,000 people is ten statements, not 5,000.
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        if (n.inApp !== false)
          await db
            .prepare(
              `INSERT INTO notifications(company_id,user_id,kind,title,body,link,created_at) VALUES ${chunk.map(() => "(?,?,?,?,?,?,?)").join(",")}`,
            )
            .run(...chunk.flatMap((id) => [n.companyId, id, n.kind, n.title, n.body ?? null, n.link ?? null, at]));
        if (n.email && mailConfigured()) {
          const people = await db
            .prepare(`SELECT email FROM users WHERE active=1 AND email IS NOT NULL AND email<>'' AND id IN (${chunk.map(() => "?").join(",")})`)
            .all(...chunk);
          if (!people.length) continue;
          const subject = n.title;
          const body = `${n.body ?? n.title}\n\nOpen the HR portal to see more.`;
          const rows = await db
            .prepare(
              `INSERT INTO email_outbox(company_id,to_email,subject,body,created_at) VALUES ${people.map(() => "(?,?,?,?,?)").join(",")} RETURNING id,to_email`,
            )
            .all(...people.flatMap((u) => [n.companyId, u.email, subject, body, at]));
          // Not awaited: the request should not wait on the mail provider.
          for (const r of rows) dispatch({ id: r.id, to_email: r.to_email, subject, body });
        }
      }
      // Text messages for the alerts that matter most, when a provider is set up.
      if ((n.sms ?? SMS_KINDS.has(n.kind)) && smsConfigured(env))
        for (const id of ids) {
          const u = await db
            .prepare("SELECT phone,active FROM users WHERE id=?")
            .get(id);
          if (u?.active && u.phone)
            void sendSms(app, n.companyId, u.phone, `${n.title}. ${app.company ?? ""}`.trim(), env);
        }
      // Phone push, not awaited: the request should not wait on Google.
      if (n.inApp !== false && app.push) void app.push(ids, n);
    } catch (e) {
      console.error("notify failed:", e.message);
    }
  }
  notify.mail = mail;
  notify.resumeQueue = resumeQueue;
  return notify;
}

const monthName = (m) =>
  new Intl.DateTimeFormat("en-IN", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${m}-01T00:00:00Z`));

// Turns audit events into notifications, so routes do not each need to know.
export async function notifyFromAudit(app, actor, action, d, companyId) {
  const { db } = app;
  const to = (ids, n) => app.notify(ids, { companyId, ...n });
  const word = (a) => (a.endsWith("approved") ? "approved" : "not approved");
  if (/^leave_(approved|rejected)$/.test(action))
    return to([d.employeeId], {
      kind: "leave",
      title: `Your leave request was ${word(action)}`,
      link: "timeoff",
      email: true,
    });
  if (/^regularization_(approved|rejected)$/.test(action))
    return to([d.employeeId], {
      kind: "regularization",
      title: `Your attendance correction was ${word(action)}`,
      link: "mine",
    });
  if (action === "claim_decided") {
    const c = await db
      .prepare("SELECT user_id FROM reimbursement_claims WHERE id=?")
      .get(d.id);
    return to([c?.user_id], {
      kind: "claim",
      title: `Your reimbursement claim was ${d.decision === "approved" ? "approved" : "not approved"}`,
      link: "myclaims",
    });
  }
  if (action === "interview_scheduled") {
    const i = await db
      .prepare(
        "SELECT i.interviewer_id,i.round_name,c.name FROM interviews i JOIN candidates c ON c.id=i.candidate_id WHERE i.id=?",
      )
      .get(d.id);
    return to([i?.interviewer_id], {
      kind: "interview",
      title: `Interview scheduled: ${i?.name}`,
      body: i?.round_name,
      link: "approvals",
      email: true,
    });
  }
  if (action === "separation_decided") {
    const r = await db
      .prepare("SELECT s.requested_by,u.name FROM separation_requests s JOIN users u ON u.id=s.user_id WHERE s.id=?")
      .get(d.id);
    return to([r?.requested_by], {
      kind: "exit",
      title:
        d.decision === "approved"
          ? `HR approved the separation of ${r?.name}`
          : `HR did not approve the separation of ${r?.name}`,
      link: "team",
      email: true,
    });
  }
  if (action === "exit_decided") {
    const x = await db
      .prepare("SELECT user_id FROM exits WHERE id=?")
      .get(d.id);
    return to([x?.user_id], {
      kind: "exit",
      title:
        d.decision === "accepted"
          ? `Your resignation was accepted. Last working day: ${d.lwd}`
          : "Your resignation was not accepted. HR will contact you.",
      link: "myemployment",
      email: true,
    });
  }
  if (action === "payroll_run_approved") {
    const rows = await db
      .prepare("SELECT user_id FROM payroll_items WHERE run_id=?")
      .all(d.id);
    return to(
      rows.map((r) => r.user_id),
      {
        kind: "payslip",
        title: `Your ${monthName(d.month)} payslip is ready`,
        link: "payslips",
        email: true,
      },
    );
  }
  if (action === "onboarding_task_added") return;
}
