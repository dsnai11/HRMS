import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { sendTeamAttendanceMails } from "../server/team-attendance-mail.js";

process.env.RESEND_API_KEY = "test-key";
process.env.MAIL_FROM = "NoReply <hrms@example.test>";

async function world(t) {
  let nowMs = Date.parse("2026-11-09T10:59:00+05:30"); // a Monday
  const sentMail = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("api.resend.com")) {
      sentMail.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    return realFetch(url, init);
  };
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    globalThis.fetch = realFetch;
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const companyId = (await db.prepare("SELECT id FROM companies LIMIT 1").get()).id;
  const at = "2026-01-01T00:00:00.000Z";
  const site = await db
    .prepare("INSERT INTO workplaces(company_id,name,latitude,longitude,radius,max_accuracy) VALUES(?,?,?,?,?,?) RETURNING id")
    .get(companyId, "Office", 26.9, 75.8, 150, 50);
  const person = async (name, manager = null, email = `${name.toLowerCase()}@example.test`) =>
    (await db
      .prepare("INSERT INTO users(company_id,name,email,password_hash,role,employee_code,manager_id,workplace_id,active,date_of_joining,created_at) VALUES(?,?,?,'x','employee',?,?,?,1,'2026-01-01',?) RETURNING id")
      .get(companyId, name, email, `C-${name}`, manager, site.id, at)).id;
  const punch = (user, inAt, reasons = []) =>
    db
      .prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,half_day_reasons) VALUES(?,?,'Office',26.9,75.8,150,50,?,26.9,75.8,10,?)")
      .run(user, site.id, inAt, JSON.stringify(reasons));
  const leave = async (user, day, sessions = ["first", "second"]) => {
    const type = await db.prepare("INSERT INTO leave_types(company_id,name,code,paid,created_at) VALUES(?,?,?,1,?) ON CONFLICT DO NOTHING RETURNING id").get(companyId, "Casual", `CL${user}`, at);
    const req = await db
      .prepare("INSERT INTO leave_requests(company_id,user_id,leave_type_id,from_date,to_date,days,leave_year,reason,status,created_at) VALUES(?,?,?,?,?,?,2026,?,'approved',?) RETURNING id")
      .get(companyId, user, type.id, day, day, sessions.length / 2, "x", at);
    for (const s of sessions) await db.prepare("INSERT INTO leave_days(request_id,user_id,day,session,paid) VALUES(?,?,?,?,1)").run(req.id, user, day, s);
  };
  const settle = async () => { for (let i = 0; i < 20 && sentMail.length < 99; i++) await new Promise((r) => setTimeout(r, 5)); };
  return { db, app, companyId, person, punch, leave, sentMail, settle, setNow: (iso) => (nowMs = Date.parse(iso)) };
}

test("a supervisor gets one mail a day naming who is late, on leave or missing", async (t) => {
  const w = await world(t);
  const boss = await w.person("Boss");
  const mgr = await w.person("Manager", boss);
  const quiet = await w.person("Quiet");
  const late = await w.person("Latecomer", mgr);
  const ontime = await w.person("Ontime", mgr);
  const away = await w.person("Away", mgr);
  const halfa = await w.person("Halfday", mgr);
  const gone = await w.person("Missing", mgr);
  const fine = await w.person("Fine", quiet);
  await w.person("NoManager");
  await w.db.prepare("UPDATE users SET branch_id=NULL WHERE id=?").run(late);
  await w.punch(late, "2026-11-09T04:45:00.000Z", ["late_in"]); // 10:15 IST
  await w.punch(ontime, "2026-11-09T03:45:00.000Z");
  await w.punch(fine, "2026-11-09T03:40:00.000Z");
  await w.punch(boss, "2026-11-09T03:40:00.000Z");
  await w.punch(mgr, "2026-11-09T03:40:00.000Z");
  await w.leave(away, "2026-11-09");
  await w.leave(halfa, "2026-11-09", ["first"]);

  assert.equal(await sendTeamAttendanceMails(w.app), 0, "before the set time");
  w.setNow("2026-11-09T11:00:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 1, "only the supervisor with someone to report");
  await w.settle();
  assert.equal(w.sentMail.length, 1);
  const m = w.sentMail[0];
  assert.deepEqual(m.to, ["manager@example.test"]);
  assert.equal(m.subject, "Team Attendance Details - 09/11/2026");
  assert.match(m.text, /Late \(1\)\n- Latecomer \(C-Latecomer\), in at 10:15/);
  assert.match(m.text, /Not punched in \(1\)\n- Missing/);
  assert.match(m.text, /On leave \(1\)\n- Away/);
  assert.match(m.text, /Half-day leave \(1\)\n- Halfday/);
  assert.doesNotMatch(m.text, /Ontime|NoManager/);
  assert.equal(m.attachments[0].filename, "Attendance_Manager_20261109.csv");
  const csv = Buffer.from(m.attachments[0].content, "base64").toString();
  assert.match(csv, /Employee Code.*Supervisor.*SLM.*Attendance Date.*Status.*Time In.*OD Time In/);
  assert.match(csv, /C-Latecomer.*C-Manager - Manager.*C-Boss - Boss.*09\/11\/2026.*Late.*10:15/);
  const note = await w.db.prepare("SELECT title FROM notifications WHERE user_id=? AND kind='attendance'").get(mgr);
  assert.equal(note.title, "Your team today: 1 late, 1 not punched in, 2 on leave");

  w.setNow("2026-11-09T11:05:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "once a day");
});

test("no mail on a holiday, a weekly off, when switched off, or hours after the set time", async (t) => {
  const w = await world(t);
  const mgr = await w.person("Manager");
  await w.person("Gone", mgr);
  w.setNow("2026-11-08T11:00:00+05:30"); // Sunday
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "weekly off");
  await w.db.prepare("INSERT INTO holidays(company_id,date,name,created_at) VALUES(?,?,?,?)").run(w.companyId, "2026-11-09", "Festival", "2026-01-01");
  w.setNow("2026-11-09T11:00:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "holiday");
  w.setNow("2026-11-10T14:30:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "too long after the set time");
  await w.db.prepare("UPDATE companies SET team_mail_enabled=0").run();
  w.setNow("2026-11-10T11:00:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "switched off");
  await w.db.prepare("UPDATE companies SET team_mail_enabled=1,team_mail_time='12:30'").run();
  assert.equal(await sendTeamAttendanceMails(w.app), 0, "before the new time");
  w.setNow("2026-11-10T12:30:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 1);
});

test("someone on approved duty elsewhere is not reported as missing", async (t) => {
  const w = await world(t);
  const mgr = await w.person("Manager");
  const out = await w.person("Outdoor", mgr);
  await w.db
    .prepare("INSERT INTO regularizations(company_id,user_id,date,kind,reason,status,created_at) VALUES(?,?,?,'on_duty','Field visit','approved',?)")
    .run(w.companyId, out, "2026-11-09", "2026-11-08");
  w.setNow("2026-11-09T11:00:00+05:30");
  assert.equal(await sendTeamAttendanceMails(w.app), 0);
});
