import { HttpError, integer, oneOf, optionalString, string } from "../http.js";
import { requireOwned, staffWith } from "../scope.js";
import { can } from "../rbac.js";
import { appointmentLetter, changeLetter, offerLetter } from "../letters.js";
import {
  decryptJson,
  encryptJson,
  encryptionKey,
  mask,
} from "../crypto-store.js";
import { cleanPrivate, readPrivate, storePrivate } from "./payroll-setup.js";

const LETTER_KINDS = {
  promotion: "Promotion letter",
  transfer: "Transfer letter",
  increment: "Increment letter",
  confirmation: "Confirmation letter",
};

export function registerEssPlus(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());

  // ---- my employment letters ---------------------------------------------------------------
  router.get("/api/my-letters", async ({ user, send }) => {
    const out = [];
    if (user.date_of_joining)
      out.push({
        kind: "appointment",
        id: user.id,
        title: "Appointment letter",
        date: user.date_of_joining,
      });
    const offer = await db
      .prepare(
        "SELECT o.id,o.joining_date,o.decided_at FROM offers o JOIN candidates c ON c.id=o.candidate_id WHERE c.user_id=? AND o.status='accepted' ORDER BY o.id DESC LIMIT 1",
      )
      .get(user.id);
    if (offer)
      out.push({
        kind: "offer",
        id: offer.id,
        title: "Offer letter",
        date: offer.decided_at?.slice(0, 10) ?? offer.joining_date,
      });
    for (const c of await db
      .prepare(
        "SELECT id,kind,effective_date FROM employee_changes WHERE user_id=? AND status='applied' ORDER BY effective_date DESC",
      )
      .all(user.id))
      out.push({
        kind: "change",
        id: c.id,
        title: LETTER_KINDS[c.kind],
        date: c.effective_date,
      });
    return send(200, out);
  });
  router.get("/api/my-letters/:kind/:id", async ({ user, params, send }) => {
    const id = integer(Number(params.id));
    const company = await db
      .prepare("SELECT name FROM companies WHERE id=?")
      .get(user.company_id);
    const names = async (u) =>
      db
        .prepare(
          `SELECT g.name designation_name,d.name department_name,b.name branch_name,m.name manager_name FROM users x
           LEFT JOIN designations g ON g.id=x.designation_id LEFT JOIN departments d ON d.id=x.department_id
           LEFT JOIN branches b ON b.id=x.branch_id LEFT JOIN users m ON m.id=x.manager_id WHERE x.id=?`,
        )
        .get(u.id);
    if (params.kind === "appointment") {
      if (id !== user.id || !user.date_of_joining)
        throw new HttpError(404, "Letter not found.");
      const n = await names(user);
      const sal = await db
        .prepare(
          "SELECT monthly_gross FROM employee_salaries WHERE user_id=? ORDER BY effective_from,id LIMIT 1",
        )
        .get(user.id);
      return send(200, {
        company: company.name,
        ...appointmentLetter({
          company: company.name,
          person: {
            name: user.name,
            employee_code: user.employee_code,
            designation_name: n.designation_name,
            department_name: n.department_name,
          },
          joined: user.date_of_joining,
          probationEnd: user.probation_end_date,
          gross: sal?.monthly_gross,
          manager: n.manager_name,
          today: today(),
        }),
      });
    }
    if (params.kind === "offer") {
      const o = await db
        .prepare(
          "SELECT o.*,c.name FROM offers o JOIN candidates c ON c.id=o.candidate_id WHERE o.id=? AND c.user_id=? AND o.status='accepted'",
        )
        .get(id, user.id);
      if (!o) throw new HttpError(404, "Letter not found.");
      return send(200, {
        company: company.name,
        ...offerLetter({
          company: company.name,
          candidate: { name: o.name },
          offer: o,
          today: today(),
        }),
      });
    }
    if (params.kind === "change") {
      const c = await db
        .prepare(
          "SELECT * FROM employee_changes WHERE id=? AND user_id=? AND status='applied'",
        )
        .get(id, user.id);
      if (!c) throw new HttpError(404, "Letter not found.");
      const n = await db
        .prepare(
          `SELECT g.name designation,d.name department,b.name branch,m.name manager FROM employee_changes c
           LEFT JOIN designations g ON g.id=c.designation_id LEFT JOIN departments d ON d.id=c.department_id
           LEFT JOIN branches b ON b.id=c.branch_id LEFT JOIN users m ON m.id=c.manager_id WHERE c.id=?`,
        )
        .get(c.id);
      return send(200, {
        company: company.name,
        ...changeLetter({
          company: company.name,
          person: { name: user.name },
          change: c,
          names: n,
          today: today(),
        }),
      });
    }
    throw new HttpError(404, "Letter not found.");
  });

  // ---- bank details: change requests are approved by someone else --------------------------------
  const mayReview = (user) =>
    can(user, "payroll.manage") || can(user, "employees.write");
  router.post(
    "/api/profile/bank-change",
    async ({ user, body, send, audit }) => {
      const key = encryptionKey();
      if (!key)
        throw new HttpError(
          503,
          "Bank details cannot be changed online until the server has DATA_ENCRYPTION_KEY set.",
        );
      const b = await body();
      const data = cleanPrivate({
        account_holder: b.account_holder,
        bank_name: b.bank_name,
        bank_account: b.bank_account,
        ifsc: b.ifsc,
      });
      for (const k of ["account_holder", "bank_name", "bank_account", "ifsc"])
        if (!data[k])
          throw new HttpError(
            400,
            "Fill in the account holder, bank, account number and IFSC.",
          );
      const doc = b.document_id
        ? await db
            .prepare("SELECT id,user_id,deleted_at FROM documents WHERE id=?")
            .get(integer(Number(b.document_id)))
        : null;
      if (!doc || doc.user_id !== user.id || doc.deleted_at)
        throw new HttpError(
          400,
          "Attach a cancelled cheque or passbook page as proof. Upload it first, then choose it here.",
        );
      if (
        await db
          .prepare(
            "SELECT id FROM bank_change_requests WHERE user_id=? AND status='pending'",
          )
          .get(user.id)
      )
        throw new HttpError(
          409,
          "You already have a bank change waiting for approval.",
        );
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO bank_change_requests(company_id,user_id,data_enc,summary,document_id,note,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              user.company_id,
              user.id,
              encryptJson(data, key),
              `${data.bank_name} · ${mask(data.bank_account)} · ${data.ifsc}`,
              doc.id,
              optionalString(b.note, "Note", 300) || null,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("bank_change_requested", { id });
      const reviewers = await staffWith(db, user.company_id, ["payroll.manage", "employees.write"], user.id);
      await app.notify(
        reviewers.map((r) => r.id),
        {
          companyId: user.company_id,
          kind: "payroll",
          title: `${user.name} asked to change bank details`,
          link: "approvals",
          email: true,
        },
      );
      return send(201, { id });
    },
  );
  router.get("/api/profile/bank-change", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT id,summary,status,decision_note,created_at,decided_at FROM bank_change_requests WHERE user_id=? ORDER BY id DESC LIMIT 10",
        )
        .all(user.id),
    ),
  );
  router.post(
    "/api/profile/bank-change/:id/cancel",
    async ({ user, params, send }) => {
      const r = await requireOwned(
        db,
        "bank_change_requests",
        integer(Number(params.id)),
        user.company_id,
        "request",
      );
      if (r.user_id !== user.id || r.status !== "pending")
        throw new HttpError(
          409,
          "Only your own pending request can be cancelled.",
        );
      await db
        .prepare(
          "UPDATE bank_change_requests SET status='cancelled' WHERE id=?",
        )
        .run(r.id);
      return send(200, { ok: true });
    },
  );
  router.get("/api/admin/bank-changes", async ({ user, send }) => {
    if (!mayReview(user))
      throw new HttpError(403, "You do not have permission to do that.");
    return send(
      200,
      await db
        .prepare(
          `SELECT r.id,r.summary,r.status,r.note,r.created_at,r.document_id,u.name employee_name,u.employee_code
           FROM bank_change_requests r JOIN users u ON u.id=r.user_id WHERE r.company_id=? AND r.status='pending' AND r.user_id<>? ORDER BY r.id`,
        )
        .all(user.company_id, user.id),
    );
  });
  router.get(
    "/api/admin/bank-changes/:id/proof",
    async ({ user, params, res, headers, audit }) => {
      if (!mayReview(user))
        throw new HttpError(403, "You do not have permission to do that.");
      const r = await requireOwned(
        db,
        "bank_change_requests",
        integer(Number(params.id)),
        user.company_id,
        "request",
      );
      const doc = r.document_id
        ? await db
            .prepare(
              "SELECT * FROM documents WHERE id=? AND deleted_at IS NULL",
            )
            .get(r.document_id)
        : null;
      if (!doc) throw new HttpError(404, "No proof attached.");
      await audit("bank_proof_viewed", { id: r.id, employeeId: r.user_id });
      const ext = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
      }[doc.mime];
      res.writeHead(200, {
        ...headers,
        "Content-Type": doc.mime,
        "Content-Disposition": `inline; filename="${doc.name}.${ext}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(doc.data, "base64"));
    },
  );
  router.post(
    "/api/admin/bank-changes/:id/decision",
    async ({ user, params, body, send, audit }) => {
      if (!mayReview(user))
        throw new HttpError(403, "You do not have permission to do that.");
      const r = await requireOwned(
        db,
        "bank_change_requests",
        integer(Number(params.id)),
        user.company_id,
        "request",
      );
      if (r.status !== "pending")
        throw new HttpError(409, `This request is already ${r.status}.`);
      if (r.user_id === user.id)
        throw new HttpError(
          403,
          "Someone else has to approve your bank change.",
        );
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["approved", "rejected"]);
      const note = optionalString(b.note, "Note", 300) || null;
      if (decision === "rejected" && !note)
        throw new HttpError(400, "Say why.");
      if (decision === "approved") {
        const key = encryptionKey();
        if (!key)
          throw new HttpError(503, "The server has no DATA_ENCRYPTION_KEY.");
        const merged = {
          ...(await readPrivate(app, r.user_id)),
          ...decryptJson(r.data_enc, key),
        };
        await storePrivate(app, r.user_id, r.company_id, merged, user.id);
      }
      await db
        .prepare(
          "UPDATE bank_change_requests SET status=?,decided_by=?,decided_at=?,decision_note=? WHERE id=?",
        )
        .run(decision, user.id, nowIso(), note, r.id);
      await audit("bank_change_decided", {
        id: r.id,
        employeeId: r.user_id,
        decision,
      });
      await app.notify([r.user_id], {
        companyId: r.company_id,
        kind: "payroll",
        title:
          decision === "approved"
            ? "Your bank details were updated"
            : "Your bank change was not approved",
        body:
          decision === "approved"
            ? "Your next salary will go to the new account."
            : note,
        link: "profile",
        email: true,
      });
      return send(200, { ok: true });
    },
  );

  // ---- helpdesk response times -------------------------------------------------------------------
  router.get(
    "/api/admin/helpdesk/sla",
    { perm: "helpdesk.manage" },
    async ({ companyId, send }) => {
      const c = await db
        .prepare("SELECT ticket_sla FROM companies WHERE id=?")
        .get(companyId);
      return send(200, JSON.parse(c.ticket_sla));
    },
  );
  router.put(
    "/api/admin/helpdesk/sla",
    { perm: "helpdesk.manage" },
    async ({ companyId, body, send, audit }) => {
      const b = await body();
      const sla = {};
      for (const k of ["low", "normal", "high"]) {
        const h = Number(b[k]);
        if (!Number.isInteger(h) || h < 1 || h > 720)
          throw new HttpError(
            400,
            "Response times are whole hours from 1 to 720.",
          );
        sla[k] = h;
      }
      await db
        .prepare("UPDATE companies SET ticket_sla=? WHERE id=?")
        .run(JSON.stringify(sla), companyId);
      await audit("helpdesk_sla_saved", sla);
      return send(200, sla);
    },
  );
}
