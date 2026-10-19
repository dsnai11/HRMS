// In-app notifications, with email when a mail provider is configured
// (RESEND_API_KEY and MAIL_FROM). Notifications are best-effort: a failure here
// never fails the action that caused it.
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

  /** notify([userId…], { companyId, kind, title, body, link, email }) */
  return async function notify(userIds, n) {
    try {
      const ids = [...new Set(userIds.filter(Boolean))];
      const at = new Date(clock()).toISOString();
      for (const id of ids) {
        await db
          .prepare(
            "INSERT INTO notifications(company_id,user_id,kind,title,body,link,created_at) VALUES(?,?,?,?,?,?,?)",
          )
          .run(
            n.companyId,
            id,
            n.kind,
            n.title,
            n.body ?? null,
            n.link ?? null,
            at,
          );
        if (n.email && mailConfigured()) {
          const u = await db
            .prepare("SELECT email,active FROM users WHERE id=?")
            .get(id);
          if (!u?.active || !u.email) continue;
          const subject = n.title;
          const body = `${n.body ?? n.title}\n\nOpen the HR portal to see more.`;
          const outbox = Number(
            (
              await db
                .prepare(
                  "INSERT INTO email_outbox(company_id,to_email,subject,body,created_at) VALUES(?,?,?,?,?)",
                )
                .run(n.companyId, u.email, subject, body, at)
            ).lastInsertRowid,
          );
          // Not awaited: the request should not wait on the mail provider.
          sendMail({ id: outbox, to_email: u.email, subject, body });
        }
      }
    } catch (e) {
      console.error("notify failed:", e.message);
    }
  };
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
