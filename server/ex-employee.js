import { decryptJson, encryptionKey } from "./crypto-store.js";
import { readPrivate } from "./routes/payroll-setup.js";

const digits = (v) => String(v ?? "").replace(/\D/g, "").slice(-10);
const lower = (v) => String(v ?? "").trim().toLowerCase();
const panOf = (v) => String(v ?? "").trim().toUpperCase();

// People who have left (inactive) matching a joiner by email, phone, PAN, or name with date of
// birth. Each match says what matched and how they left, so HR can check their records.
export async function findExEmployees(app, companyId, who) {
  const { db } = app;
  const email = lower(who.email);
  const phone = digits(who.phone);
  const name = lower(who.name);
  const dob = who.date_of_birth || null;
  const pan = panOf(who.pan);
  const rows = await db
    .prepare(
      `SELECT u.id,u.name,u.employee_code,u.email,u.phone,u.date_of_birth,u.date_of_joining,u.exit_date,
              x.kind exit_kind,x.reason,x.last_working_day,x.personal_email,x.personal_phone,
              COALESCE(i.would_rejoin,x.would_rejoin) would_rejoin
       FROM users u
       LEFT JOIN exits x ON x.id=(SELECT MAX(id) FROM exits WHERE user_id=u.id AND status='completed')
       LEFT JOIN exit_interviews i ON i.exit_id=x.id
       WHERE u.company_id=? AND u.active=0 AND u.role<>'super_admin'`,
    )
    .all(companyId);
  const out = [];
  for (const u of rows) {
    const why = [];
    if (email && [lower(u.email), lower(u.personal_email)].includes(email)) why.push("email");
    if (phone.length === 10 && [digits(u.phone), digits(u.personal_phone)].includes(phone)) why.push("phone");
    if (name && dob && lower(u.name) === name && u.date_of_birth === dob) why.push("name and date of birth");
    if (pan && encryptionKey()) {
      const p = await readPrivate(app, u.id).catch(() => ({}));
      if (panOf(p.pan) === pan) why.push("PAN");
    }
    if (why.length)
      out.push({
        id: u.id,
        name: u.name,
        employee_code: u.employee_code,
        joined: u.date_of_joining,
        left: u.last_working_day ?? u.exit_date ?? null,
        exit_kind: u.exit_kind ?? null,
        reason: u.reason ?? null,
        would_rejoin: u.would_rejoin ?? null,
        matched_on: why,
      });
  }
  return out;
}

/** What a candidate offers for matching: their record plus anything filled in pre-boarding. */
export async function candidateIdentity(app, candidate) {
  const p = await app.db.prepare("SELECT form,sensitive FROM preboarding WHERE candidate_id=?").get(candidate.id);
  const form = p ? JSON.parse(p.form || "{}") : {};
  const key = encryptionKey();
  const sensitive = p?.sensitive && key ? decryptJson(p.sensitive, key) : {};
  return {
    name: candidate.name,
    email: candidate.email || form.personal_email || form.email,
    phone: candidate.phone || form.phone,
    date_of_birth: form.date_of_birth || null,
    pan: sensitive.pan || null,
  };
}
