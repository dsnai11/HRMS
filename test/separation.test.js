import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  let nowMs = Date.parse("2026-11-20T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const secrets = new Map();
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64);
    const r = await call("/login", { email, password, native: true, device: { id, platform: "android", model: "T", secret: secrets.get(id) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (await call("/admin/workplaces", { name: "Office", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, workplace_id: site, date_of_joining: "2026-01-01", ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("mgr");
  for (const k of ["gone", "here", "away", "late"]) await add(k);
  for (const k of ["gone", "here", "away", "late"])
    await db.prepare("UPDATE users SET manager_id=? WHERE id=?").run(people.mgr.id, people[k].id);
  return { db, call, owner, people, site, add };
}

const punch = (db, w, key, day) =>
  db
    .prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(w.people[key].id, w.site, "Office", 26.9, 75.8, 150, 50, new Date(Date.parse(`${day}T09:30:00+05:30`)).toISOString(), 26.9, 75.8, 10);

test("absconding list, a manager's separation request, and HR's decision", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    mgr = people.mgr.token;
  // GONE last came on 5 Nov; HERE came yesterday; AWAY is on approved leave; LATE joined this week.
  await punch(db, w, "gone", "2026-11-05");
  await punch(db, w, "here", "2026-11-19");
  await db.prepare("UPDATE users SET date_of_joining='2026-11-18' WHERE id=?").run(people.late.id);
  const lt = (await db.prepare("INSERT INTO leave_types(company_id,name,code,created_at) VALUES(1,'Casual','CL','x') RETURNING id").get()).id;
  await db.prepare("INSERT INTO leave_requests(company_id,user_id,leave_type_id,from_date,to_date,days,leave_year,status,created_at) VALUES(1,?,?,'2026-11-16','2026-11-20',5,2026,'approved','x')").run(people.away.id, lt);
  const req = await db.prepare("SELECT id FROM leave_requests WHERE user_id=?").get(people.away.id);
  for (const d of ["2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"])
    await db.prepare("INSERT INTO leave_days(request_id,user_id,day,session,paid) VALUES(?,?,?,'first',1)").run(req.id, people.away.id, d);

  const team = await call("/team/absconding?days=7", undefined, mgr);
  assert.equal(team.status, 200, JSON.stringify(team.data));
  assert.deepEqual(team.data.items.map((r) => r.name), ["GONE"]);
  assert.equal(team.data.items[0].last_seen_on, "2026-11-05");
  assert.equal((await call("/team/absconding?days=1", undefined, mgr)).status, 400);
  assert.equal((await call("/team/absconding", undefined, people.gone.token)).status, 403, "not a manager");
  // HR sees everyone, including people with no manager.
  const all = (await call("/admin/absconding", undefined, hr)).data.items.map((r) => r.name);
  assert.ok(all.includes("GONE") && all.includes("MGR") && !all.includes("HERE") && !all.includes("AWAY") && !all.includes("LATE"));
  assert.equal((await call("/admin/absconding", undefined, mgr)).status, 403);

  // The manager asks HR; only for their team, and once.
  assert.equal((await call("/team/separations", { user_id: people.hr.id, kind: "termination", reason: "x" }, mgr)).status, 403);
  assert.equal((await call("/team/separations", { user_id: people.gone.id, kind: "absconding", reason: "Not reachable" }, mgr)).status, 400, "needs the last day at work");
  const sep = await call("/team/separations", { user_id: people.gone.id, kind: "absconding", reason: "Not reachable by phone since 6 Nov", last_seen_on: "2026-11-05" }, mgr);
  assert.equal(sep.status, 201, JSON.stringify(sep.data));
  assert.equal((await call("/team/separations", { user_id: people.gone.id, kind: "termination", reason: "again" }, mgr)).status, 409);
  assert.equal((await call("/team/absconding", undefined, mgr)).data.items[0].request_id, sep.data.id);
  // A second request, cancelled by the manager.
  const other = (await call("/team/separations", { user_id: people.here.id, kind: "termination", reason: "Repeated misconduct", proposed_last_day: "2026-11-30" }, mgr)).data.id;
  assert.equal((await call(`/team/separations/${other}/cancel`, {}, people.hr.token)).status, 403);
  assert.equal((await call(`/team/separations/${other}/cancel`, {}, mgr)).status, 200);

  // HR decides.
  const pending = (await call("/admin/separations?status=pending", undefined, hr)).data;
  assert.deepEqual(pending.map((r) => [r.employee_name, r.requested_by_name]), [["GONE", "MGR"]]);
  assert.equal((await call(`/admin/separations/${sep.data.id}/decide`, { decision: "rejected" }, hr)).status, 400, "a rejection needs a reason");
  // HR staff who manage people cannot approve their own requests.
  await w.db.prepare("UPDATE users SET manager_id=? WHERE id=?").run(people.hr.id, people.late.id);
  const own = (await call("/team/separations", { user_id: people.late.id, kind: "termination", reason: "Fake documents" }, hr)).data.id;
  assert.equal((await call(`/admin/separations/${own}/decide`, { decision: "approved", last_working_day: "2026-11-20" }, hr)).status, 403);
  assert.equal((await call(`/team/separations/${own}/cancel`, {}, hr)).status, 200);
  const ok = await call(`/admin/separations/${sep.data.id}/decide`, { decision: "approved", note: "Notices sent, no reply" }, hr);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const exit = (await call(`/admin/exits/${ok.data.exit_id}`, undefined, hr)).data;
  assert.deepEqual([exit.kind, exit.status, exit.initiated_by, exit.last_working_day], ["absconding", "accepted", "company", "2026-11-05"]);
  assert.ok(exit.clearance.length > 0, "clearance started");
  assert.equal((await call(`/admin/separations/${sep.data.id}/decide`, { decision: "approved" }, hr)).status, 409);
  assert.equal((await call("/team/absconding", undefined, mgr)).data.items.length, 0, "an exit in progress leaves the list");
  const note = await db.prepare("SELECT title FROM notifications WHERE user_id=? ORDER BY id DESC").get(people.mgr.id);
  assert.match(note.title, /approved the separation of GONE/);
});

test("a manager gives a view on a team member's resignation before HR decides", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const r = await call("/exit/resign", { reason: "Moving to another city", requested_last_day: "2026-12-10" }, people.here.token);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  await call("/exit/resign", { reason: "Higher studies" }, people.mgr.token);

  const list = (await call("/team/resignations", undefined, people.mgr.token)).data;
  assert.deepEqual(list.map((x) => x.employee_name), ["HERE"], "not the manager's own resignation");
  assert.equal((await call(`/team/resignations/${r.data.id}/review`, { view: "retain" }, people.mgr.token)).status, 400, "retain needs a plan");
  assert.equal((await call(`/team/resignations/${r.data.id}/review`, { view: "accept" }, people.gone.token)).status, 403);
  const rev = await call(`/team/resignations/${r.data.id}/review`, { view: "accept", note: "Handover to AWAY", last_day: "2026-12-05" }, people.mgr.token);
  assert.equal(rev.status, 200, JSON.stringify(rev.data));
  const seen = (await call(`/admin/exits/${r.data.id}`, undefined, people.hr.token)).data;
  assert.deepEqual([seen.manager_view, seen.manager_note, seen.manager_last_day], ["accept", "Handover to AWAY", "2026-12-05"]);
  assert.equal((await call(`/admin/exits/${r.data.id}/decide`, { decision: "accepted", last_working_day: "2026-12-05" }, people.hr.token)).status, 200);
  assert.equal((await call(`/team/resignations/${r.data.id}/review`, { view: "accept" }, people.mgr.token)).status, 409, "closed once HR decides");
});
