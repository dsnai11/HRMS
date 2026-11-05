import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { runFieldForce } from "../server/field-force/index.js";

const IST = (local) => Date.parse(`${local}+05:30`);
const PW = "Temporary-pass-123";

test("Field Force activation: morning nudge, reminder, reasons and the 12:30 report", async (t) => {
  let nowMs = IST("2026-11-09T07:00:00"); // a Monday
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
  const call = async (path, body, token, method, headers = {}) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const login = async (email, extra = {}) =>
    (
      await call("/login", {
        email,
        password: PW,
        native: true,
        device: { id: `${email.split("@")[0]}-phone-000001`, platform: "android", model: "Pixel" },
        ...extra,
      })
    ).data;
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, admin)).data.id;
  const ro = (await call("/admin/designations", { name: "Relationship Officer" }, admin)).data.id;
  const person = async (name, extra = {}) => {
    const id = (
      await call("/admin/employees", { name, email: `${name.toLowerCase()}@example.test`, password: PW, workplace_id: site, ...extra }, admin)
    ).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    return id;
  };
  const boss = await person("Boss");
  const hr = await person("Hema", { role: "hr" });
  const ids = {
    asha: await person("Asha", { manager_id: boss }), // punches in on time
    bala: await person("Bala", { manager_id: boss, designation_id: ro }), // gives reasons
    chitra: await person("Chitra", { manager_id: boss }), // rostered off today
    dev: await person("Dev", { manager_id: boss }), // not field staff
    esha: await person("Esha", { manager_id: boss }), // never answers
  };
  const notes = async () =>
    db.prepare("SELECT user_id,title,body FROM notifications WHERE kind='activation' ORDER BY id").all();
  const at = async (local) => {
    nowMs = IST(local);
    await runFieldForce(app);
  };

  // Field team: chosen people, and everyone with a designation.
  assert.equal((await call("/field-force/staff", { team: "collection", user_ids: [ids.asha, ids.chitra, ids.esha] }, admin, "PATCH")).data.updated, 3);
  assert.equal((await call("/field-force/staff", { team: "sales", designation_id: ro }, admin, "PATCH")).data.updated, 1);
  assert.equal((await call("/field-force/staff", { team: "sales" }, admin, "PATCH")).status, 400, "nobody chosen");
  assert.deepEqual(
    (await call("/field-force/staff", undefined, admin)).data.map((p) => [p.name, p.team_label]),
    [["Asha", "Collection"], ["Chitra", "Collection"], ["Esha", "Collection"], ["Bala", "Sales"]],
  );
  await db
    .prepare("INSERT INTO roster_entries(company_id,user_id,date,off,created_at) VALUES(1,?,?,1,?)")
    .run(ids.chitra, "2026-11-09", new Date().toISOString());

  // Off until HR switches it on.
  await at("2026-11-09T08:30:00");
  assert.equal((await notes()).length, 0);
  assert.equal((await call("/field-force/settings", { on: true, remind: "08:00" }, admin, "PATCH")).status, 400, "times out of order");
  assert.deepEqual(
    (await call("/field-force/settings", { on: true }, admin, "PATCH")).data,
    { on: true, nudge: "08:30", remind: "10:00", report: "12:30" },
  );

  // Asha punches in at 8:10 from her phone.
  nowMs = IST("2026-11-09T08:10:00");
  const device = { id: "asha-phone-0000001", platform: "android", model: "Pixel" };
  const asha = await login("asha@example.test", { device });
  const row = (await call("/admin/devices", undefined, admin)).data[0];
  await call(`/admin/devices/${row.id}`, { status: "approved" }, admin, "PATCH");
  const phone = { "X-Device-Id": device.id, "X-Device-Secret": asha.deviceSecret };
  const punched = await call(
    "/punch",
    { action: "in", location: { latitude: 26.9125, longitude: 75.7874, accuracy: 10, timestamp: nowMs }, signals: { emulator: false, rooted: false } },
    asha.token,
    undefined,
    phone,
  );
  assert.equal(punched.status, 200);

  // 8:29 nothing; 8:30 the nudge, only to those still to start; again later, no repeat.
  await at("2026-11-09T08:29:00");
  assert.equal((await notes()).length, 0);
  await at("2026-11-09T08:30:00");
  let sent = await notes();
  assert.deepEqual(sent.map((n) => n.user_id).sort(), [ids.bala, ids.esha].sort());
  assert.match(sent[0].title, /Please punch in/);
  await at("2026-11-09T09:15:00");
  assert.equal((await notes()).length, 2);

  // Bala's Home screen shows the reason card; Asha's and Dev's do not.
  const bala = await login("bala@example.test");
  const card = (await call("/field-force/today", undefined, bala.token)).data;
  assert.equal(card.show, true);
  assert.equal(card.reasons.length, 4);
  assert.equal((await call("/field-force/today", undefined, asha.token, undefined, phone)).data.show, false);
  const dev = await login("dev@example.test");
  assert.deepEqual((await call("/field-force/today", undefined, dev.token)).data, { field_team: null, show: false });

  // 10:00 the reminder to those who have not started or answered.
  await at("2026-11-09T10:00:00");
  sent = await notes();
  assert.equal(sent.length, 4);
  assert.match(sent[3].title, /not punched in yet/);

  // Reasons: "call me" goes to the manager at once; a later answer replaces it.
  const callMe = await call("/field-force/reason", { reason: "call_me", note: "Bike broke down" }, bala.token);
  assert.equal(callMe.status, 200);
  assert.equal(callMe.data.reason, "call_me");
  sent = await notes();
  assert.equal(sent.at(-1).user_id, boss);
  assert.match(sent.at(-1).title, /Bala has not started and asked to be called/);
  assert.match(sent.at(-1).body, /Bike broke down/);
  assert.equal((await call("/field-force/reason", { reason: "on_the_way" }, bala.token)).data.reason_label, "On the way to customer / market");
  assert.equal((await call("/field-force/reason", { reason: "dancing" }, bala.token)).status, 400);
  assert.equal((await call("/field-force/reason", { reason: "on_the_way" }, asha.token, undefined, phone)).status, 409, "already punched in");
  assert.equal((await call("/field-force/reason", { reason: "on_the_way" }, dev.token)).status, 403, "not field staff");
  const reminders = (await notes()).length;
  await at("2026-11-09T11:00:00");
  assert.equal((await notes()).length, reminders, "no second reminder");

  // 12:30 the report: the manager hears about their people, HR about everyone, once.
  await at("2026-11-09T12:30:00");
  const report = (await notes()).slice(reminders);
  const toBoss = report.find((n) => n.user_id === boss);
  assert.match(toBoss.title, /2 of your field team have not punched in today/);
  assert.match(toBoss.body, /Not punched in and no reason given \(1\): Esha/);
  assert.match(toBoss.body, /Said they are on the way, not punched in yet \(1\): Bala/);
  assert.doesNotMatch(toBoss.body, /Asha|Chitra|Dev/);
  assert.match(report.find((n) => n.user_id === hr).title, /Field activation 2026-11-09: 2 not punched in by 12:30/);
  await at("2026-11-09T13:00:00");
  assert.equal((await notes()).length, reminders + report.length, "the report goes once");

  // The day's view, for HR and for the manager.
  const view = (await call("/field-force/day?date=2026-11-09", undefined, admin)).data;
  assert.equal(view.total, 4);
  assert.deepEqual(
    Object.fromEntries(Object.entries(view.counts).filter(([, n]) => n)),
    { on_time: 1, reason: 1, no_reply: 1, off: 1 },
  );
  assert.equal(view.reasons.on_the_way, 1);
  assert.equal(view.people.find((p) => p.id === ids.esha).status_label, "Not punched in, no reason");
  assert.equal((await call("/field-force/day?date=2026-11-09&team=sales", undefined, admin)).data.total, 1);
  const bossLogin = await login("boss@example.test");
  assert.equal((await call("/field-force/team-day?date=2026-11-09", undefined, bossLogin.token)).data.total, 4);
  assert.equal((await call("/field-force/team-day", undefined, dev.token)).status, 403, "not a manager");

  // Next day, the server first wakes at 11:00: too late for the morning message, so only
  // the reminder goes.
  const before = (await notes()).length;
  await at("2026-11-10T11:00:00");
  const late = (await notes()).slice(before);
  assert.equal(late.length, 4, "all four field staff: nobody has punched in on this day yet");
  assert.ok(late.every((n) => /not punched in yet/.test(n.title)));

  // Sunday is a weekly off: nothing at all.
  const sunday = (await notes()).length;
  await at("2026-11-15T08:30:00");
  await at("2026-11-15T10:00:00");
  await at("2026-11-15T12:30:00");
  assert.equal((await notes()).length, sunday);

  // A company holiday: nothing. Someone on an on-duty request (Multiple OD): left out.
  await db
    .prepare("INSERT INTO holidays(company_id,date,name,created_at) VALUES(1,'2026-11-12','Festival',?)")
    .run(new Date().toISOString());
  await at("2026-11-12T08:30:00");
  assert.equal((await notes()).length, sunday);
  await db
    .prepare("INSERT INTO regularizations(company_id,user_id,date,kind,reason,created_at) VALUES(1,?,'2026-11-13','on_duty','Branch visit',?)")
    .run(ids.esha, new Date().toISOString());
  await at("2026-11-13T08:30:00");
  const friday = (await notes()).slice(sunday).map((n) => n.user_id);
  assert.equal(friday.length, 3);
  assert.ok(!friday.includes(ids.esha));
  const fridayView = (await call("/field-force/day?date=2026-11-13", undefined, admin)).data;
  assert.equal(fridayView.people.find((p) => p.id === ids.esha).status, "od");
  assert.equal(fridayView.counts.waiting, 3);
});

test("Field Force is a separate module: FIELD_FORCE=off leaves it out entirely", async (t) => {
  const before = process.env.FIELD_FORCE;
  process.env.FIELD_FORCE = "off";
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server } = createApp({ db });
  if (before === undefined) delete process.env.FIELD_FORCE;
  else process.env.FIELD_FORCE = before;
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
  assert.deepEqual((await (await fetch(`${base}/config`)).json()).features, {});
  const token = (
    await (
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.test", password: "Admin-password-123", native: true }),
      })
    ).json()
  ).token;
  const res = await fetch(`${base}/field-force/day`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 404);
  // Its tables exist (migrations always run) but nothing else in the HRMS uses them.
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ff_staff").get()).n, 0);
});
