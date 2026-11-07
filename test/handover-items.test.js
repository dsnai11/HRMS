import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { textPdf } from "../server/text-pdf.js";
import { taxYearOf } from "../server/payroll/tax.js";

const PW = "Temporary-pass-123";
const IST = (local) => Date.parse(`${local}+05:30`);

async function world(t, nowMs = IST("2026-11-09T10:00:00")) {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(async () => {
          await db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  // Web sign-in (cookie) is not needed: employees sign in on a phone with a device.
  const person = async (name, extra = {}) => {
    const email = `${name.toLowerCase()}@example.test`;
    const id = (await call("/admin/employees", { name, email, password: PW, ...extra }, admin)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const token = (
      await call("/login", { email, password: PW, native: true, device: { id: `${name.toLowerCase()}-phone-000000001`, platform: "android", model: "Pixel" } })
    ).data.token;
    return { id, token };
  };
  return { db, app, call, admin, person };
}

test("leave during the notice period: HR chooses per leave type; approved leave can move the last day", async (t) => {
  const { db, call, admin, person } = await world(t);
  const casual = (await call("/admin/leave-types", { name: "Casual", code: "CL", unlimited: true, allowed_in_notice: false }, admin)).data.id;
  const sick = (await call("/admin/leave-types", { name: "Sick", code: "SL", unlimited: true }, admin)).data.id;
  const types = (await call("/admin/leave-types", undefined, admin)).data;
  assert.deepEqual(
    types.map((x) => [x.code, x.allowed_in_notice]).sort(),
    [["CL", 0], ["SL", 1]],
  );
  const ravi = await person("Ravi");
  const apply = (type, from, to = from) => call("/leave/requests", { leave_type_id: type, from_date: from, to_date: to }, ravi.token);

  // Before resigning, casual leave is fine.
  assert.equal((await apply(casual, "2026-11-10")).status, 201);

  // Resignation accepted: notice from 9 Nov to 9 Dec.
  const exitId = Number(
    (
      await db
        .prepare(
          "INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,last_working_day,status,created_at) VALUES(1,?,'resignation','employee','2026-11-09',30,'2026-12-09','accepted',?)",
        )
        .run(ravi.id, new Date().toISOString())
    ).lastInsertRowid,
  );
  const refused = await apply(casual, "2026-11-17");
  assert.equal(refused.status, 422);
  assert.equal(refused.data.code, "not_in_notice");
  assert.match(refused.data.error, /Casual cannot be taken during your notice period \(until 2026-12-09\)/);
  assert.equal((await apply(casual, "2026-12-08", "2026-12-11")).status, 422, "a range that touches the notice period");
  assert.equal((await apply(casual, "2026-12-14")).status, 201, "after the last day it is allowed");

  // Sick leave is allowed. With the company rule on, approving it moves the last day.
  assert.equal((await call("/admin/leave-settings", { notice_leave_extends: true }, admin, "PATCH")).data.notice_leave_extends, true);
  const sickId = (await apply(sick, "2026-11-17", "2026-11-18")).data.id;
  assert.equal((await call(`/leave/requests/${sickId}/decision`, { decision: "approved" }, admin)).status, 200);
  assert.equal((await db.prepare("SELECT last_working_day FROM exits WHERE id=?").get(exitId)).last_working_day, "2026-12-11");
  const told = await db.prepare("SELECT title FROM notifications WHERE user_id=? AND kind='exit'").get(ravi.id);
  assert.match(told.title, /Last working day moved to 2026-12-11/);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='notice_extended_by_leave'").get());

  // Turned off: approving no longer moves it.
  await call("/admin/leave-settings", { notice_leave_extends: false }, admin, "PATCH");
  const later = (await apply(sick, "2026-11-24")).data.id;
  await call(`/leave/requests/${later}/decision`, { decision: "approved" }, admin);
  assert.equal((await db.prepare("SELECT last_working_day FROM exits WHERE id=?").get(exitId)).last_working_day, "2026-12-11");
});

test("relieving and experience letters are emailed as PDFs to the personal email", async (t) => {
  const pdf = textPdf({ heading: "Laxmi", title: "Relieving letter", date: "9 November 2026", to: "Ravi (café)", paragraphs: ["One — two."], signoff: "For Laxmi" });
  const text = pdf.toString("latin1");
  assert.ok(text.startsWith("%PDF-1.4") && text.trimEnd().endsWith("%%EOF"));
  assert.match(text, /\(Relieving letter\) Tj/);
  assert.match(text, /\(One - two\.\) Tj/, "dashes become plain hyphens");

  const saved = { ...process.env };
  const realFetch = globalThis.fetch;
  const sentMail = [];
  t.after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    globalThis.fetch = realFetch;
  });
  const { db, call, admin, person } = await world(t);
  const ravi = await person("Ravi");
  const exitId = Number(
    (
      await db
        .prepare(
          "INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,last_working_day,status,personal_email,created_at) VALUES(1,?,'resignation','employee','2026-10-01',30,'2026-10-31','completed',?,?)",
        )
        .run(ravi.id, "ravi.home@example.test", new Date().toISOString())
    ).lastInsertRowid,
  );
  // No email service yet: HR is told plainly.
  const off = await call(`/admin/exits/${exitId}/letters/email`, {}, admin);
  assert.equal(off.status, 409);
  assert.match(off.data.error, /Email is not set up/);

  process.env.RESEND_API_KEY = "re_test";
  process.env.MAIL_FROM = "hr@example.test";
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com")) {
      sentMail.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: "m1" }), { status: 200 });
    }
    return realFetch(url, init);
  };
  const sent = await call(`/admin/exits/${exitId}/letters/email`, {}, admin);
  assert.deepEqual(sent.data, { ok: true, to: "ravi.home@example.test" });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sentMail.length, 1);
  assert.deepEqual(sentMail[0].to, ["ravi.home@example.test"]);
  assert.deepEqual(sentMail[0].attachments.map((a) => a.filename), ["Relieving-letter.pdf", "Experience-certificate.pdf"]);
  assert.ok(Buffer.from(sentMail[0].attachments[0].content, "base64").toString("latin1").startsWith("%PDF"));
  assert.match(Buffer.from(sentMail[0].attachments[0].content, "base64").toString("latin1"), /relieved from duties/);
  // To another address, and only for completed exits.
  assert.equal((await call(`/admin/exits/${exitId}/letters/email`, { to: "other@example.test" }, admin)).data.to, "other@example.test");
  assert.equal((await call(`/admin/exits/${exitId}/letters/email`, { to: "not-an-email" }, admin)).status, 400);
  await db.prepare("UPDATE exits SET status='accepted' WHERE id=?").run(exitId);
  assert.equal((await call(`/admin/exits/${exitId}/letters/email`, {}, admin)).status, 409);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='exit_letters_emailed'").get());
});

test("job openings above a branch's sanctioned posts need a reason", async (t) => {
  const { db, app, call, admin, person } = await world(t);
  const branch = (await call("/admin/branches", { name: "Jaipur Main" }, admin)).data.id;
  const other = (await call("/admin/branches", { name: "Kota" }, admin)).data.id;
  const ro = (await call("/admin/designations", { name: "Relationship Officer" }, admin)).data.id;
  const fy = taxYearOf(app.dayOf(new Date(app.clock()).toISOString()).slice(0, 7));
  await db.prepare("INSERT INTO budget_posts(company_id,fy,branch_id,designation_id,sanctioned) VALUES(1,?,?,?,2)").run(fy, branch, ro);
  const boss = await person("Boss", { branch_id: branch });
  await person("Asha", { branch_id: branch, designation_id: ro, manager_id: boss.id });
  const opening = (positions, extra = {}) =>
    call("/admin/openings", { title: "Relationship Officer", branch_id: branch, designation_id: ro, positions, ...extra }, admin);

  // 2 sanctioned, 1 in post: one more is fine; a second needs a reason.
  assert.equal((await opening(1)).status, 201);
  const warned = await opening(1);
  assert.equal(warned.status, 409);
  assert.equal(warned.data.code, "over_sanctioned");
  assert.match(warned.data.error, /Jaipur Main, Relationship Officer: 2 sanctioned for \d{4}-\d{2}, 1 in post and 1 already open\. This opening for 1 would go 1 over/);
  const forced = await opening(1, { over_sanction_reason: "Replacement for long leave" });
  assert.equal(forced.status, 201);
  assert.equal((await db.prepare("SELECT over_sanction_reason FROM job_openings WHERE id=?").get(forced.data.id)).over_sanction_reason, "Replacement for long leave");
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='opening_over_sanctioned'").get());

  // A branch with no manpower plan is not checked.
  assert.equal((await call("/admin/openings", { title: "RO", branch_id: other, designation_id: ro, positions: 5 }, admin)).status, 201);

  // A manager's requisition is checked when HR approves it.
  const req = (await call("/requisitions", { title: "Relationship Officer", branch_id: branch, designation_id: ro, positions: 1 }, boss.token)).data.id;
  assert.equal((await call(`/admin/openings/${req}/approval`, { decision: "approved" }, admin)).status, 409);
  assert.equal((await call(`/admin/openings/${req}/approval`, { decision: "approved", over_sanction_reason: "New collection area" }, admin)).status, 200);

  // Reopening a closed opening that would go over asks again.
  await call(`/admin/openings/${forced.data.id}`, { status: "closed" }, admin, "PATCH");
  assert.equal((await call(`/admin/openings/${forced.data.id}`, { status: "open" }, admin, "PATCH")).status, 409);
});
