import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

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

test("activity log: employee codes, and one employee's full history", async (t) => {
  const { db, call, admin, person } = await world(t);
  const ravi = await person("Ravi", { employee_code: "LIFC0101" });
  const sita = await person("Sita", { employee_code: "LIFC0102" });
  // Something done to Ravi's record by the admin, and something Sita did herself.
  assert.equal((await call(`/admin/employees/${ravi.id}`, { phone: "9876543210" }, admin, "PATCH")).status, 200);
  await call("/me/profile", { phone: "9123456780" }, sita.token, "PATCH");

  const all = (await call("/admin/audit", undefined, admin)).data;
  const updated = all.find((a) => a.action === "employee_updated");
  assert.equal(updated.subject_code, "LIFC0101");
  assert.equal(updated.subject_name, "Ravi");
  assert.ok("actor_code" in updated);

  const mine = (await call("/admin/audit?employee=lifc0101", undefined, admin)).data;
  assert.equal(mine.employee.name, "Ravi");
  assert.ok(mine.entries.length > 0);
  assert.ok(mine.entries.every((a) => a.actor_id === ravi.id || a.subject_id === ravi.id));
  assert.ok(mine.entries.some((a) => a.action === "employee_updated"));

  assert.equal((await call("/admin/audit?employee=NOPE", undefined, admin)).status, 404);

  // Paging back: entries older than a given id only.
  const oldest = all[all.length - 1].id;
  const older = (await call(`/admin/audit?before=${all[0].id}`, undefined, admin)).data;
  assert.ok(older.every((a) => a.id < all[0].id));
  assert.ok(older.some((a) => a.id === oldest));
  void db;
});

test("ESI card and HR documents: HR uploads, the employee sees and opens them", async (t) => {
  const { call, admin, person } = await world(t);
  const ravi = await person("Ravi", { employee_code: "LIFC0201" });
  const pdf = Buffer.from("%PDF-1.4 test").toString("base64");
  // Employees cannot add HR-issued files to their own record.
  assert.equal((await call("/documents", { kind: "esi_card", name: "Mine", mime: "application/pdf", data: pdf }, ravi.token)).status, 403);
  let esi = (await call("/my-esi", undefined, ravi.token)).data;
  assert.equal(esi.card, null);
  const card = await call("/documents", { user_id: ravi.id, kind: "esi_card", name: "ESI e-Pehchan", mime: "application/pdf", data: pdf }, admin);
  assert.equal(card.status, 201);
  await call("/documents", { user_id: ravi.id, kind: "hr_document", name: "Appreciation letter", mime: "application/pdf", data: pdf }, admin);
  await call("/documents", { kind: "pan", name: "My PAN", mime: "application/pdf", data: pdf }, ravi.token);

  esi = (await call("/my-esi", undefined, ravi.token)).data;
  assert.equal(esi.card.id, card.data.id);
  const hr = (await call("/my-hr-documents", undefined, ravi.token)).data;
  assert.deepEqual(hr.map((d) => d.kind).sort(), ["esi_card", "hr_document"]);
  // The employee cannot remove what HR uploaded.
  assert.equal((await call(`/documents/${card.data.id}`, undefined, ravi.token, "DELETE")).status, 403);
});

test("ticket escalation: past due goes to level 1, past due again goes to the final person", async (t) => {
  let now = Date.parse("2026-11-09T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => now });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => { server.close(async () => { await db.close(); resolve(); }); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const mk = async (name, extra = {}) => {
    const email = `${name.toLowerCase()}@example.test`;
    const r = await call("/admin/employees", { name, email, password: PW, ...extra }, admin);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    const token = (await call("/login", { email, password: PW, native: true, device: { id: `${name.toLowerCase()}-phone-000000001`, platform: "android", model: "Pixel" } })).data.token;
    return { id: r.data.id, token };
  };
  const boss = await mk("Boss", { employee_code: "LIFC0900" });
  const agent = await mk("Agent", { role: "hr", manager_id: boss.id });
  const head = await mk("Head", { employee_code: "LIFC0999" });
  const ravi = await mk("Ravi");
  assert.equal((await call("/admin/helpdesk/sla", { low: 72, normal: 48, high: 24, escalate_to_code: "lifc0999" }, admin, "PUT")).status, 200);
  assert.equal((await call("/admin/helpdesk/sla", undefined, admin)).data.escalate_to_name, "Head");
  const ticket = (await call("/tickets", { subject: "Salary not credited", body: "Help", priority: "normal" }, ravi.token)).data.id;
  assert.equal((await call(`/admin/tickets/${ticket}`, { assigned_to: agent.id }, admin, "PATCH")).status, 200);
  const { escalateTickets } = await import("../server/ticket-escalation.js");
  const inbox = async (id) => (await db.prepare("SELECT title FROM notifications WHERE user_id=? AND title LIKE 'Escalated%'").all(id)).map((n) => n.title);

  assert.equal(await escalateTickets(app), 0, "not due yet");
  now += 49 * 3600000; // past the 48-hour response time
  assert.equal(await escalateTickets(app), 1);
  const row = await db.prepare("SELECT escalation_level,priority FROM tickets WHERE id=?").get(ticket);
  assert.deepEqual([row.escalation_level, row.priority], [1, "high"]);
  assert.equal((await inbox(boss.id)).length, 1, "assignee's manager told");
  assert.equal((await inbox(head.id)).length, 0);
  assert.equal(await escalateTickets(app), 0, "once per level");

  now += 48 * 3600000; // still open another full response time later
  assert.equal(await escalateTickets(app), 1);
  assert.equal((await inbox(head.id)).length, 1, "final escalation person told");
  assert.equal((await db.prepare("SELECT escalation_level FROM tickets WHERE id=?").get(ticket)).escalation_level, 2);
  assert.equal(await escalateTickets(app), 0);
  const list = (await call("/admin/tickets", undefined, admin)).data;
  assert.equal(list[0].escalation_level, 2);
});

test("a leaving manager's team moves to the person HR names", async (t) => {
  const { db, call, admin, person } = await world(t);
  const top = await person("Top", { employee_code: "LIFC0300" });
  const mgr = await person("Mgr", { employee_code: "LIFC0301", manager_id: top.id });
  const next = await person("Next", { employee_code: "LIFC0302", manager_id: top.id });
  const a = await person("Asha", { manager_id: mgr.id });
  const b = await person("Bala", { manager_id: mgr.id });
  const dept = (await db.prepare("INSERT INTO departments(company_id,name,head_id,created_at) VALUES(1,'Sales',?,'2026-01-01') RETURNING id").get(mgr.id)).id;

  const team = (await call(`/admin/employees/${mgr.id}/team`, undefined, admin)).data;
  assert.deepEqual(team.people.map((p) => p.name), ["Asha", "Bala"]);
  assert.deepEqual(team.departments, ["Sales"]);
  assert.equal(team.manager.name, "Top");

  // Move now, by code.
  const r = (await call(`/admin/employees/${mgr.id}/move-team`, { to_code: "lifc0302" }, admin)).data;
  assert.equal(r.people, 2);
  assert.deepEqual(r.departments, ["Sales"]);
  const boss = async (id) => (await db.prepare("SELECT manager_id FROM users WHERE id=?").get(id)).manager_id;
  assert.equal(await boss(a.id), next.id);
  assert.equal((await db.prepare("SELECT head_id FROM departments WHERE id=?").get(dept)).head_id, next.id);
  assert.equal((await call(`/admin/employees/${mgr.id}/move-team`, { to_code: "NOPE" }, admin)).status, 400);

  // Switching someone off with a named successor; one of the team is the successor themself.
  await call(`/admin/employees/${a.id}`, { manager_id: next.id }, admin, "PATCH");
  await call(`/admin/employees/${b.id}`, { manager_id: next.id }, admin, "PATCH");
  assert.equal((await call(`/admin/employees/${next.id}`, { active: false, team_to: "LIFC0301" }, admin, "PATCH")).status, 200);
  assert.equal(await boss(a.id), mgr.id);
  assert.equal(await boss(b.id), mgr.id);

  // Switching off with no name: the team goes to the leaver's own manager.
  assert.equal((await call(`/admin/employees/${mgr.id}`, { active: false }, admin, "PATCH")).status, 200);
  assert.equal(await boss(a.id), top.id);
  const log = (await call("/admin/audit?employee=LIFC0301", undefined, admin)).data.entries.map((e) => e.action);
  assert.ok(log.includes("team_moved"));
  assert.ok(log.includes("team_reassigned_on_deactivation"));
});

test("ex-employee check: matched candidate, hold blocks hiring, HR accepts or rejects", async (t) => {
  const { db, call, admin, person } = await world(t);
  const old = await person("Kavita", { employee_code: "LIFC0400", phone: "9811122233" });
  await db.prepare("UPDATE users SET name='Kavita Rao',active=0,exit_date='2026-05-31' WHERE id=?").run(old.id);

  const mk = async (name, phone) => (await call("/admin/candidates", { name, email: `${name.replace(/ /g, ".").toLowerCase()}@mail.test`, phone }, admin)).data.id;
  const cand = await mk("Kavita R", "+91 98111 22233");
  const fresh = await mk("New Person", "9000000001");

  let x = (await call(`/admin/candidates/${cand}/ex-employee`, undefined, admin)).data;
  assert.equal(x.status, null);
  assert.equal(x.matches[0].employee_code, "LIFC0400");
  assert.deepEqual(x.matches[0].matched_on, ["phone"]);
  assert.equal((await call(`/admin/candidates/${fresh}/ex-employee`, undefined, admin)).data.matches.length, 0);

  // "No" puts the profile on hold: it cannot move on.
  assert.equal((await call(`/admin/candidates/${cand}/ex-employee`, { decision: "hold" }, admin)).status, 200);
  assert.equal((await call(`/admin/candidates/${cand}/stage`, { stage: "interview" }, admin)).status, 409);
  assert.equal((await call(`/admin/candidates/${cand}/ex-employee`, { decision: "continue" }, admin)).status, 409, "already answered");
  // Accept from hold: hiring can go on.
  assert.equal((await call(`/admin/candidates/${cand}/ex-employee`, { decision: "accept" }, admin)).status, 200);
  assert.equal((await call(`/admin/candidates/${cand}/stage`, { stage: "interview" }, admin)).status, 200);
  x = (await call(`/admin/candidates/${cand}/ex-employee`, undefined, admin)).data;
  assert.equal(x.status, "accepted");
  assert.equal(x.rehire_of, old.id);

  // Another match, held and then rejected: the profile closes.
  const again = await mk("Kavita Again", "9811122233");
  await call(`/admin/candidates/${again}/ex-employee`, { decision: "hold" }, admin);
  assert.equal((await call(`/admin/candidates/${again}/ex-employee`, { decision: "reject" }, admin)).status, 200);
  assert.equal((await db.prepare("SELECT stage FROM candidates WHERE id=?").get(again)).stage, "rejected");

  // Adding an ex-employee directly needs confirmation.
  const direct = await call("/admin/employees", { name: "Kavita Rao", email: "kavita.new@mail.test", password: PW, phone: "9811122233" }, admin);
  assert.equal(direct.status, 409);
  assert.equal(direct.data.code, "ex_employee");
  assert.equal((await call("/admin/employees", { name: "Kavita Rao", email: "kavita.new@mail.test", password: PW, phone: "9811122233", ex_employee_ok: true }, admin)).status, 201);
});

test("after an exit: settlement mailed after the set days, and a link with only the allowed documents", async (t) => {
  process.env.RESEND_API_KEY = "test-key";
  process.env.MAIL_FROM = "HR <hr@example.test>";
  const mails = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      mails.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    return realFetch(url, init);
  };
  t.after(() => {
    globalThis.fetch = realFetch;
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_FROM;
  });
  let now = Date.parse("2026-11-09T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => now });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => { server.close(async () => { await db.close(); resolve(); }); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await realFetch(base + path, { method: method ?? (body === undefined ? "GET" : "POST"), headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: res.headers.get("content-type")?.includes("json") ? await res.json() : Buffer.from(await res.arrayBuffer()) };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const ravi = (await call("/admin/employees", { name: "Ravi", email: "ravi@example.test", password: PW, employee_code: "LIFC0500" }, admin)).data.id;
  const at = "2026-10-01T00:00:00.000Z";
  const exit = (await db.prepare("INSERT INTO exits(company_id,user_id,kind,initiated_by,notice_given_on,notice_days,last_working_day,status,personal_email,created_at,completed_at) VALUES(1,?,'resignation','employee','2026-09-01',30,'2026-10-01','completed','ravi.home@mail.test',?,?) RETURNING id").get(ravi, at, at)).id;
  await db.prepare("UPDATE users SET active=0 WHERE id=?").run(ravi);
  await db.prepare("INSERT INTO settlements(company_id,exit_id,user_id,pay_in_month,data,created_at) VALUES(1,?,?,'2026-10',?,?)").run(exit, ravi, JSON.stringify({ lines: [{ name: "Salary for October", kind: "earning", amount: 25000 }, { name: "Notice shortfall", kind: "deduction", amount: 2000 }], info: [] }), at);
  const run = (await db.prepare("INSERT INTO payroll_runs(company_id,month,status,created_at) VALUES(1,'2026-09','approved',?) RETURNING id").get(at)).id;
  await db.prepare("INSERT INTO payroll_items(run_id,company_id,user_id,gross,deductions,net,employer_cost,paid_days,lop_days,taxable_earnings,data) VALUES(?,1,?,30000,2000,28000,31000,30,0,30000,?)").run(run, ravi, JSON.stringify({ employee: { name: "Ravi" }, earnings: [{ name: "Basic", amount: 30000 }], deductions: [{ name: "PF", amount: 2000 }], gross_earnings: 30000, net_pay: 28000 }));
  const pdf = Buffer.from("%PDF-1.4 x").toString("base64");
  await call("/documents", { user_id: ravi, kind: "pan", name: "PAN card", mime: "application/pdf", data: pdf }, admin);

  // Settings: HR sets 35 days and pay slips + settlement only by default.
  assert.equal((await call("/admin/exit-settings", { fnf_mail_days: 35, alumni_link_days: 60, alumni_default_docs: ["payslips", "fnf"] }, admin, "PUT")).status, 200);
  assert.equal((await call("/admin/exit-settings", { fnf_mail_days: 0, alumni_link_days: 60, alumni_default_docs: [] }, admin, "PUT")).status, 400);

  // 1 Oct + 35 days = 5 Nov: on 9 Nov the mail is due.
  now = Date.parse("2026-11-04T10:00:00+05:30");
  assert.equal(await app.sendFnfMails(), 0, "not yet");
  now = Date.parse("2026-11-09T10:00:00+05:30");
  assert.equal(await app.sendFnfMails(), 1);
  assert.equal(await app.sendFnfMails(), 0, "only once");
  const mail = mails.find((m) => /settlement statement/.test(m.subject));
  assert.deepEqual(mail.to, ["ravi.home@mail.test"]);
  assert.equal(mail.attachments.length, 1);
  const link = mail.text.match(/alumni\.html\?t=([\w-]+)/)[1];

  // The link shows only what HR allowed.
  let page = (await call(`/alumni/${link}`)).data;
  assert.equal(page.name, "Ravi");
  assert.deepEqual(page.items.map((i) => i.kind).sort(), ["fnf", "payslip"]);
  const slip = await call(`/alumni/${link}/file/payslip/${run}`);
  assert.equal(slip.status, 200);
  assert.equal(slip.data.subarray(0, 4).toString(), "%PDF");
  assert.equal((await call(`/alumni/${link}/file/relieving/${exit}`)).status, 404, "not allowed");

  // HR adds the relieving letter and their own documents for this person.
  await call(`/admin/exits/${exit}/alumni`, { docs: ["relieving", "my_documents"] }, admin, "PUT");
  page = (await call(`/alumni/${link}`)).data;
  assert.deepEqual(page.items.map((i) => i.kind).sort(), ["document", "relieving"]);
  assert.equal((await call(`/alumni/${link}/file/payslip/${run}`)).status, 404, "pay slips no longer allowed");

  // A new link stops the old one; links expire.
  const fresh = (await call(`/admin/exits/${exit}/alumni/link`, { send: false }, admin)).data;
  assert.equal((await call(`/alumni/${link}`)).status, 404);
  const t2 = fresh.link.split("t=")[1];
  assert.equal((await call(`/alumni/${t2}`)).status, 200);
  now += 61 * 86400000;
  assert.equal((await call(`/alumni/${t2}`)).status, 404);
});

test("no punch for 3 working days: employee, manager and HR are told once", async (t) => {
  let now = Date.parse("2026-11-12T10:00:00+05:30"); // Thursday
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  await db.prepare("UPDATE companies SET attendance_start_date='2026-01-01'").run();
  const { server, app } = createApp({ db, clock: () => now });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => { server.close(async () => { await db.close(); resolve(); }); server.closeAllConnections(); }));
  const at = "2026-01-01T00:00:00.000Z";
  const site = await db.prepare("INSERT INTO workplaces(company_id,name,latitude,longitude,radius,max_accuracy) VALUES(1,'Office',26.9,75.8,150,50) RETURNING id").get();
  const add = async (name, mgr = null) =>
    (await db.prepare("INSERT INTO users(company_id,name,email,password_hash,role,employee_code,manager_id,workplace_id,active,date_of_joining,created_at) VALUES(1,?,?,'x','employee',?,?,?,1,'2026-01-01',?) RETURNING id")
      .get(name, `${name.toLowerCase()}@example.test`, `C-${name}`, mgr, site.id, at)).id;
  const boss = await add("Boss");
  const gone = await add("Gone", boss);
  const here = await add("Here", boss);
  const punch = (user, day) =>
    db.prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at) VALUES(?,?,'Office',26.9,75.8,150,50,?,26.9,75.8,10,?)")
      .run(user, site.id, `${day}T04:00:00.000Z`, `${day}T12:00:00.000Z`);
  // Everyone works up to Saturday 7 Nov (a working day by default). From Monday 9 Nov only "Here" punches; Boss is on leave-free punches too.
  for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07"]) for (const u of [boss, gone, here]) await punch(u, d);
  for (const d of ["2026-11-09", "2026-11-10", "2026-11-11"]) for (const u of [boss, here]) await punch(u, d);
  // Admin is not a test subject: give them punches too.
  for (const d of ["2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-09", "2026-11-10", "2026-11-11"]) await punch(1, d);
  const { sendNoPunchMails } = await import("../server/no-punch-mail.js");
  const told = async (id) => (await db.prepare("SELECT title FROM notifications WHERE user_id=? AND title LIKE '%no attendance%' OR (user_id=? AND title LIKE 'No attendance%')").all(id, id)).map((n) => n.title);

  // Wednesday: only Mon and Tue missed (2 days).
  now = Date.parse("2026-11-11T10:00:00+05:30");
  assert.equal(await sendNoPunchMails(app), 0);
  // Thursday: Mon, Tue, Wed missed.
  now = Date.parse("2026-11-12T10:00:00+05:30");
  assert.equal(await sendNoPunchMails(app), 1);
  assert.equal((await told(gone)).length, 1);
  assert.match((await told(boss))[0], /Gone .* 3 working days/);
  assert.equal((await told(here)).length, 0);
  assert.equal(await sendNoPunchMails(app), 0, "once per run of missed days");
  // Turned off: nothing.
  await db.prepare("UPDATE companies SET no_punch_mail_days=0").run();
  await db.prepare("DELETE FROM no_punch_alerts").run();
  assert.equal(await sendNoPunchMails(app), 0);
});

test("transfer acknowledgement: pushed, skippable twice, then must be acknowledged; letters mailed", async (t) => {
  const { db, call, admin, person } = await world(t);
  const ravi = await person("Ravi");
  const br = (await db.prepare("INSERT INTO branches(company_id,name,created_at) VALUES(1,'Kota','2026-01-01') RETURNING id").get()).id;
  const change = (await call("/admin/changes", { user_id: ravi.id, kind: "transfer", effective_date: "2026-11-09", branch_id: br, note: "Branch expansion" }, admin)).data.id;
  assert.ok(change);
  const pushed = await db.prepare("SELECT title,link FROM notifications WHERE user_id=? AND kind='transfer'").get(ravi.id);
  assert.equal(pushed.link, "transfer-ack");

  let list = (await call("/me/acknowledgements", undefined, ravi.token)).data;
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].details, ["Branch: Kota"]);
  assert.equal(list[0].can_skip, true);
  const act = (action) => call(`/me/acknowledgements/${change}`, { action }, ravi.token);
  assert.equal((await act("skip")).data.skips_left, 1);
  assert.equal((await act("skip")).data.skips_left, 0);
  assert.equal((await act("skip")).status, 409, "third time cannot skip");
  list = (await call("/me/acknowledgements", undefined, ravi.token)).data;
  assert.equal(list[0].can_skip, false);
  assert.equal((await act("acknowledge")).status, 200);
  assert.equal((await call("/me/acknowledgements", undefined, ravi.token)).data.length, 0);
  const row = await db.prepare("SELECT ack_skips,ack_skip_log,acknowledged_at FROM employee_changes WHERE id=?").get(change);
  assert.equal(row.ack_skips, 2);
  assert.equal(JSON.parse(row.ack_skip_log).length, 2);
  assert.ok(row.acknowledged_at);
  const hrView = (await call("/admin/changes", undefined, admin)).data.find((c) => c.id === change);
  assert.equal(hrView.ack_skips, 2);

  // Applying the change files the transfer letter under the employee's HR documents.
  assert.equal((await call(`/admin/changes/${change}/apply`, {}, admin)).status, 200);
  const docs = (await call("/my-hr-documents", undefined, ravi.token)).data;
  assert.ok(docs.some((d) => d.kind === "hr_document" && /Transfer letter/.test(d.name)));
});
