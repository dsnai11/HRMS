import { createHash, randomBytes } from "node:crypto";
import { HttpError, clientIp, email, integer, oneOf } from "../http.js";
import { requireOwned, staffWith } from "../scope.js";
import { textPdf } from "../text-pdf.js";
import { HR_ISSUED } from "./documents.js";

// What an ex-employee may download from their private link. HR picks these per exit; the
// company default applies when HR has not chosen.
export const ALUMNI_DOCS = {
  payslips: "Pay slips",
  form16: "Form 16",
  relieving: "Relieving letter",
  experience: "Experience certificate",
  fnf: "Full and final settlement statement",
  hr_documents: "Other HR documents (letters, ESI card)",
  my_documents: "Documents they gave HR (ID, address, education…)",
};
const KEYS = Object.keys(ALUMNI_DOCS);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const rs = (n) => `Rs. ${Math.round(Number(n) || 0).toLocaleString("en-IN")}`;
const base = () => (process.env.APP_URL || process.env.PUBLIC_URL || "").replace(/\/$/, "");
const cleanDocs = (v) => {
  if (!Array.isArray(v)) throw new HttpError(400, "Choose the documents as a list.");
  return [...new Set(v.map((k) => oneOf(k, "Document", KEYS)))];
};

/** The full and final statement as a PDF, from the posted settlement. */
async function fnfPdf(app, x) {
  const s = await app.db.prepare("SELECT * FROM settlements WHERE exit_id=? AND status='posted'").get(x.id);
  if (!s) return null;
  const data = JSON.parse(s.data);
  const lines = data.lines ?? [];
  const pay = lines.filter((l) => l.kind !== "deduction").reduce((t, l) => t + l.amount, 0);
  const cut = lines.filter((l) => l.kind === "deduction").reduce((t, l) => t + l.amount, 0);
  return textPdf({
    heading: x.company,
    title: "Full and final settlement statement",
    date: `Last working day: ${x.last_working_day}`,
    to: `${x.employee_name}${x.employee_code ? ` (${x.employee_code})` : ""}`,
    paragraphs: [
      ...lines.map((l) => `${l.kind === "deduction" ? "Less: " : ""}${l.name}: ${rs(l.amount)}`),
      `Total payable before tax: ${rs(pay - cut)}`,
      `Paid with the ${s.pay_in_month} payroll, where income tax and the final net amount are worked out.`,
      ...(data.info ?? []),
    ],
    signoff: `${x.company}, HR`,
  });
}

// Payslip as a simple PDF from the stored payroll item.
function payslipPdf(company, d, month) {
  return textPdf({
    heading: company,
    title: `Pay slip for ${month}`,
    to: `${d.employee?.name ?? ""}${d.employee?.employee_code ? ` (${d.employee.employee_code})` : ""}`,
    paragraphs: [
      `Paid days: ${d.paid_days ?? "-"} of ${d.days_in_month ?? "-"}`,
      "Earnings:",
      ...(d.earnings ?? []).map((e) => `  ${e.name}: ${rs(e.amount)}`),
      `Gross earnings: ${rs(d.gross_earnings)}`,
      "Deductions:",
      ...((d.deductions ?? []).length ? d.deductions.map((e) => `  ${e.name}: ${rs(e.amount)}`) : ["  None"]),
      `Net pay: ${rs(d.net_pay ?? d.net)}`,
    ],
  });
}

export function registerAlumni(router, app) {
  const { db, clock, rateLimit } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const EXIT = `SELECT x.*,u.name employee_name,u.employee_code,u.email user_email,c.name company,c.alumni_default_docs,c.alumni_link_days
    FROM exits x JOIN users u ON u.id=x.user_id JOIN companies c ON c.id=x.company_id`;
  const docsOf = (x) => JSON.parse(x.alumni_docs ?? x.alumni_default_docs ?? "[]");

  // ---- company settings ------------------------------------------------------------------------
  router.get("/api/admin/exit-settings", { perm: "exit.manage" }, async ({ companyId, send }) => {
    const c = await db.prepare("SELECT fnf_mail_days,alumni_link_days,alumni_default_docs FROM companies WHERE id=?").get(companyId);
    return send(200, { fnf_mail_days: c.fnf_mail_days, alumni_link_days: c.alumni_link_days, alumni_default_docs: JSON.parse(c.alumni_default_docs), choices: ALUMNI_DOCS });
  });
  router.put("/api/admin/exit-settings", { perm: "exit.manage" }, async ({ companyId, body, send, audit }) => {
    const b = await body();
    const days = (v, label, max) => {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > max) throw new HttpError(400, `${label} must be a whole number from 1 to ${max}.`);
      return n;
    };
    const fnf = days(b.fnf_mail_days, "Days before the settlement mail", 365);
    const link = days(b.alumni_link_days, "Days the link works", 730);
    const docs = cleanDocs(b.alumni_default_docs ?? []);
    await db.prepare("UPDATE companies SET fnf_mail_days=?,alumni_link_days=?,alumni_default_docs=? WHERE id=?").run(fnf, link, JSON.stringify(docs), companyId);
    await audit("exit_settings_saved", { fnf_mail_days: fnf, alumni_link_days: link, alumni_default_docs: docs });
    return send(200, { fnf_mail_days: fnf, alumni_link_days: link, alumni_default_docs: docs });
  });

  // ---- per exit: what this person may download, and their link ------------------------------
  router.get("/api/admin/exits/:id/alumni", { perm: "exit.manage" }, async ({ params, companyId, send }) => {
    const x = await requireOwned(db, "exits", integer(Number(params.id)), companyId, "exit");
    const row = await db.prepare(`${EXIT} WHERE x.id=?`).get(x.id);
    return send(200, {
      docs: docsOf(row),
      custom: row.alumni_docs !== null,
      link_expires_at: row.alumni_expires_at,
      link_active: Boolean(row.alumni_token_hash && row.alumni_expires_at > nowIso()),
      fnf_mailed_at: row.fnf_mailed_at,
      choices: ALUMNI_DOCS,
    });
  });
  router.put("/api/admin/exits/:id/alumni", { perm: "exit.manage" }, async ({ params, companyId, body, send, audit }) => {
    const x = await requireOwned(db, "exits", integer(Number(params.id)), companyId, "exit");
    const docs = cleanDocs((await body()).docs);
    await db.prepare("UPDATE exits SET alumni_docs=? WHERE id=?").run(JSON.stringify(docs), x.id);
    await audit("alumni_docs_saved", { id: x.id, employeeId: x.user_id, docs });
    return send(200, { docs });
  });
  // A new private link (the old one stops working), mailed to the personal email or another.
  router.post("/api/admin/exits/:id/alumni/link", { perm: "exit.manage" }, async ({ params, companyId, body, send, audit }) => {
    const x = await requireOwned(db, "exits", integer(Number(params.id)), companyId, "exit");
    if (x.status !== "completed") throw new HttpError(409, "The link is available once the exit is complete.");
    const b = await body();
    const row = await db.prepare(`${EXIT} WHERE x.id=?`).get(x.id);
    const to = b.to ? email(b.to) : row.personal_email;
    const { link, expires } = await issueLink(row);
    let mailed = false;
    if (to && b.send !== false) mailed = await mailLink(row, to, link, expires);
    await audit("alumni_link_issued", { id: x.id, employeeId: x.user_id, mailed, to: mailed ? to : null });
    return send(201, { link, expires_at: expires, mailed, to: mailed ? to : null });
  });
  async function issueLink(row) {
    const token = randomBytes(32).toString("base64url");
    const expires = new Date(clock() + (row.alumni_link_days || 90) * 86400000).toISOString();
    await db.prepare("UPDATE exits SET alumni_token_hash=?,alumni_expires_at=? WHERE id=?").run(sha(token), expires, row.id);
    return { link: `${base()}/alumni.html?t=${token}`, expires };
  }
  async function mailLink(row, to, link, expires) {
    return app.notify.mail(
      row.company_id,
      to,
      `${row.company}: your documents`,
      `Dear ${row.employee_name},\n\nYou can download your documents from ${row.company} here:\n${link}\n\nThe link is private to you and works until ${expires.slice(0, 10)}.\n\n${row.company}, HR`,
    );
  }
  app.alumniLink = async (exitId) => {
    const row = await db.prepare(`${EXIT} WHERE x.id=?`).get(exitId);
    return issueLink(row);
  };

  // ---- the ex-employee's page (no sign-in: the private link is the key) ----------------------
  async function byToken(req, token) {
    rateLimit(`alumni:${clientIp(req)}`, 120);
    const row = await db.prepare(`${EXIT} WHERE x.alumni_token_hash=? AND x.status='completed'`).get(sha(String(token)));
    if (!row || row.alumni_expires_at < nowIso()) throw new HttpError(404, "This link has expired. Ask HR for a new one.");
    return row;
  }
  async function itemsFor(row) {
    const docs = new Set(docsOf(row));
    const items = [];
    if (docs.has("relieving")) items.push({ kind: "relieving", id: row.id, title: "Relieving letter", date: row.last_working_day });
    if (docs.has("experience")) items.push({ kind: "experience", id: row.id, title: "Experience certificate", date: row.last_working_day });
    if (docs.has("fnf") && (await db.prepare("SELECT 1 FROM settlements WHERE exit_id=? AND status='posted'").get(row.id)))
      items.push({ kind: "fnf", id: row.id, title: "Full and final settlement statement", date: row.last_working_day });
    if (docs.has("payslips"))
      for (const p of await db
        .prepare("SELECT r.id,r.month FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE i.user_id=? AND r.status IN ('approved','paid') ORDER BY r.month DESC")
        .all(row.user_id))
        items.push({ kind: "payslip", id: p.id, title: `Pay slip ${p.month}`, date: `${p.month}-01` });
    const kinds = [
      ...(docs.has("form16") ? ["form16"] : []),
      ...(docs.has("hr_documents") ? HR_ISSUED.filter((k) => k !== "form16") : []),
    ];
    const own = docs.has("my_documents");
    if (kinds.length || own)
      for (const d of await db
        .prepare("SELECT id,kind,name,created_at FROM documents WHERE user_id=? AND deleted_at IS NULL ORDER BY id DESC")
        .all(row.user_id))
        if (kinds.includes(d.kind) || (own && !HR_ISSUED.includes(d.kind)))
          items.push({ kind: "document", id: d.id, title: d.name, date: d.created_at.slice(0, 10) });
    return items;
  }
  router.get("/api/alumni/:token", { public: true }, async ({ req, params, send }) => {
    const row = await byToken(req, params.token);
    return send(200, { company: row.company, name: row.employee_name, employee_code: row.employee_code, expires_at: row.alumni_expires_at, items: await itemsFor(row) });
  });
  router.get("/api/alumni/:token/file/:kind/:id", { public: true }, async ({ req, params, res, headers }) => {
    const row = await byToken(req, params.token);
    const kind = String(params.kind);
    const id = integer(Number(params.id));
    const allowed = (await itemsFor(row)).find((i) => i.kind === kind && i.id === id);
    if (!allowed) throw new HttpError(404, "This document is not available on your link.");
    let bytes;
    let mime = "application/pdf";
    let name = allowed.title;
    if (kind === "relieving" || kind === "experience") {
      const l = await app.exitLetterFor(row.id, row.company_id, kind);
      bytes = textPdf({ heading: l.company, ...l });
    } else if (kind === "fnf") bytes = await fnfPdf(app, row);
    else if (kind === "payslip") {
      const p = await db
        .prepare("SELECT i.data,r.month FROM payroll_items i JOIN payroll_runs r ON r.id=i.run_id WHERE r.id=? AND i.user_id=?")
        .get(id, row.user_id);
      bytes = payslipPdf(row.company, JSON.parse(p.data), p.month);
    } else {
      const d = await db.prepare("SELECT mime,name,data FROM documents WHERE id=?").get(id);
      mime = d.mime;
      name = d.name;
      bytes = await app.blobs.bytes(d.data);
    }
    await app.audit(null, "alumni_download", { id: row.id, employeeId: row.user_id, kind, item: id }, row.company_id);
    const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[mime] ?? "bin";
    res.writeHead(200, {
      ...headers,
      "Content-Type": mime,
      "Content-Disposition": `attachment; filename="${String(name).replace(/[^A-Za-z0-9._ -]/g, "_")}.${ext}"`,
      "Cache-Control": "private, no-store",
    });
    res.end(bytes);
  });

  // ---- the settlement mail, a set number of days after the last working day ------------------
  app.sendFnfMails = async () => {
    const today = app.dayOf(nowIso());
    const rows = await db
      .prepare(`${EXIT} WHERE x.status='completed' AND x.fnf_mailed_at IS NULL AND x.last_working_day IS NOT NULL`)
      .all();
    let sent = 0;
    for (const row of rows) {
      const c = await db.prepare("SELECT fnf_mail_days FROM companies WHERE id=?").get(row.company_id);
      const due = new Date(Date.parse(`${row.last_working_day}T00:00:00Z`) + c.fnf_mail_days * 86400000).toISOString().slice(0, 10);
      if (due > today) continue;
      const pdf = await fnfPdf(app, row);
      if (!pdf) continue;
      const to = row.personal_email || row.user_email;
      let link = null;
      if (docsOf(row).length) link = (await issueLink(row)).link;
      const ok = to
        ? await app.notify.mail(
            row.company_id,
            to,
            `${row.company}: your full and final settlement statement`,
            `Dear ${row.employee_name},\n\nPlease find attached your full and final settlement statement.${link ? `\n\nYou can also download your documents (pay slips, letters and others HR has shared) here:\n${link}` : ""}\n\nFor any question, reply to HR.\n\n${row.company}, HR`,
            [{ filename: "Full-and-final-settlement.pdf", content: pdf.toString("base64") }],
          )
        : false;
      if (!ok) continue;
      await db.prepare("UPDATE exits SET fnf_mailed_at=? WHERE id=?").run(nowIso(), row.id);
      const hr = (await staffWith(db, row.company_id, ["exit.manage"])).map((p) => p.id);
      await app.notify(hr, { companyId: row.company_id, kind: "exit", title: `Settlement statement mailed to ${row.employee_name}`, link: "hiring" });
      await app.audit(null, "fnf_mailed", { id: row.id, employeeId: row.user_id, to }, row.company_id);
      sent += 1;
    }
    return sent;
  };
}
export function scheduleFnfMails(app) {
  const run = () => app.sendFnfMails?.().catch((e) => console.error("Settlement mail failed:", e.message));
  void run();
  setInterval(run, 6 * 3600000).unref();
}
