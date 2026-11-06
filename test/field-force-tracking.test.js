import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { runFieldForce } from "../server/field-force/index.js";

const IST = (local) => Date.parse(`${local}+05:30`);
const PW = "Temporary-pass-123";
const HO = { latitude: 26.9124, longitude: 75.7873 };

test("Field Force tracking: consent, points only in the shift, the 2-hour check, visits, routes", async (t) => {
  let nowMs = IST("2026-11-09T08:00:00");
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
  const call = async (path, body, who, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(who?.token ? { Authorization: `Bearer ${who.token}` } : {}),
        ...(who?.headers ?? {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = { token: (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token };
  const site = (await call("/admin/workplaces", { name: "HO", ...HO, radius: 150, max_accuracy: 50 }, admin)).data.id;
  const person = async (name, extra = {}) => {
    const id = (
      await call("/admin/employees", { name, email: `${name.toLowerCase()}@example.test`, password: PW, workplace_id: site, employee_code: name.toUpperCase(), ...extra }, admin)
    ).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    return id;
  };
  const boss = await person("Boss");
  const ids = { ravi: await person("Ravi", { manager_id: boss }), sita: await person("Sita", { manager_id: boss }), tara: await person("Tara", { manager_id: boss }) };
  const other = await person("Other");
  await call("/field-force/staff", { team: "collection", user_ids: Object.values(ids) }, admin, "PATCH");
  const phone = async (email) => {
    const device = { id: `${email.split("@")[0]}-phone-00001`, platform: "android", model: "Pixel" };
    const r = (await call("/login", { email, password: PW, native: true, device })).data;
    return { token: r.token, headers: { "X-Device-Id": device.id, "X-Device-Secret": r.deviceSecret } };
  };
  const ravi = await phone("ravi@example.test");
  const sita = await phone("sita@example.test");
  const tara = await phone("tara@example.test");
  const bossPhone = await phone("boss@example.test");
  const otherPhone = await phone("other@example.test");
  for (const d of (await call("/admin/devices", undefined, admin)).data) await call(`/admin/devices/${d.id}`, { status: "approved" }, admin, "PATCH");

  // Off until the company switches it on; nothing is taken without the person agreeing.
  assert.equal((await call("/field-force/tracking", undefined, ravi)).data.track, false);
  assert.equal((await call("/field-force/tracking/settings", { tracking: true, still_meters: 20 }, admin, "PATCH")).status, 400);
  assert.equal((await call("/field-force/tracking/settings", { tracking: true }, admin, "PATCH")).data.still_minutes, 120);
  let state = (await call("/field-force/tracking", undefined, ravi)).data;
  assert.deepEqual([state.tracking_on, state.consent, state.track], [true, false, false]);
  assert.match(state.consent_text, /stops when you punch out/);
  assert.equal((await call("/field-force/tracking/consent", { agree: true }, otherPhone)).status, 403, "not field staff");
  for (const p of [ravi, sita, tara]) await call("/field-force/tracking/consent", { agree: true }, p);

  // Punch in at 9:00 (straight into the database: the punch itself is tested elsewhere).
  const punchIn = (userId, local) =>
    db
      .prepare(
        "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,?,?,150,50,?,?,?,10)",
      )
      .run(userId, site, "HO", HO.latitude, HO.longitude, new Date(IST(local)).toISOString(), HO.latitude, HO.longitude);
  for (const id of Object.values(ids)) await punchIn(id, "2026-11-09T09:00:00");
  nowMs = IST("2026-11-09T09:01:00");
  state = (await call("/field-force/tracking", undefined, ravi)).data;
  assert.deepEqual([state.track, state.ping_minutes], [true, 15]);

  // Points every 15 minutes: Ravi travels about 1 km, Sita stays put, Tara's phone sends none.
  const points = (from, to, step) => {
    const out = [];
    for (let ms = IST(from), i = 0; ms <= IST(to); ms += 15 * 60000, i++)
      out.push({ at: new Date(ms).toISOString(), latitude: HO.latitude + i * step, longitude: HO.longitude, accuracy: 12 });
    return out;
  };
  const send = (who, list) => call("/field-force/pings", { points: list }, who);
  nowMs = IST("2026-11-09T11:05:00");
  const early = await send(ravi, [{ at: new Date(IST("2026-11-09T08:30:00")).toISOString(), ...HO }]);
  assert.equal(early.data.saved, 0, "before punch-in: refused");
  assert.equal((await send(ravi, points("2026-11-09T09:00:00", "2026-11-09T11:00:00", 0.0012))).data.saved, 9);
  assert.equal((await send(sita, points("2026-11-09T09:00:00", "2026-11-09T11:00:00", 0))).data.saved, 9);
  assert.equal((await send(sita, points("2026-11-09T09:00:00", "2026-11-09T09:00:00", 0))).data.saved, 0, "duplicates ignored");
  assert.equal((await call("/field-force/pings", { points: [] }, { token: ravi.token })).status, 403, "only from the approved phone");

  // 11:05, two hours into the shift: Sita has not moved, Tara sent nothing; Ravi is fine.
  const notes = () => db.prepare("SELECT user_id,title FROM notifications WHERE kind='activation' ORDER BY id").all();
  await runFieldForce(app);
  let sent = await notes();
  assert.deepEqual(sent.map((n) => n.user_id).sort(), [ids.sita, ids.tara].sort());
  assert.match(sent.find((n) => n.user_id === ids.sita).title, /You have not moved for 2 hours/);
  assert.match(sent.find((n) => n.user_id === ids.tara).title, /not received your location for 2 hours/);
  nowMs = IST("2026-11-09T11:30:00");
  await runFieldForce(app);
  assert.equal((await notes()).length, 2, "one alert per two-hour cycle");

  // 13:10: Sita still has not moved: now her manager hears too.
  nowMs = IST("2026-11-09T13:10:00");
  await send(sita, points("2026-11-09T11:15:00", "2026-11-09T13:00:00", 0));
  await send(ravi, points("2026-11-09T11:15:00", "2026-11-09T13:00:00", 0.0012));
  await runFieldForce(app);
  sent = await notes();
  const toBoss = sent.filter((n) => n.user_id === boss);
  assert.ok(toBoss.some((n) => /^Sita: no movement for 4\.1 hours/.test(n.title)));
  assert.ok(toBoss.some((n) => /^Tara: no location/.test(n.title)));

  // Sita logs a customer visit: the check pauses and her alerts close.
  assert.equal((await call("/field-force/visits", { customer: "Mr Sharma, loan 4411", ...HO }, sita)).status, 201);
  assert.equal((await call("/field-force/visits", { customer: "x" }, otherPhone)).status, 403, "not field staff");
  nowMs = IST("2026-11-09T13:30:00");
  await runFieldForce(app);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ff_alerts WHERE user_id=? AND closed_at IS NULL").get(ids.sita)).n, 0);

  // The day for HR and the manager: distance, points, visits, alerts.
  const day = (await call("/field-force/movement?date=2026-11-09", undefined, admin)).data;
  const of = (id) => day.people.find((p) => p.id === id);
  assert.ok(of(ids.ravi).km > 1.5 && of(ids.ravi).km < 4, `Ravi moved ${of(ids.ravi).km} km`);
  assert.equal(of(ids.ravi).alerts, 0);
  assert.deepEqual([of(ids.sita).visits, of(ids.sita).alerts, of(ids.sita).alert_open], [1, 2, false]);
  assert.deepEqual([of(ids.tara).points, of(ids.tara).alert_open], [0, true]);
  assert.equal((await call("/field-force/movement?date=2026-11-09", undefined, bossPhone)).data.people.length, 3);
  assert.equal((await call("/field-force/movement", undefined, otherPhone)).status, 403);

  // A route is for HR and the person's own manager, and looking is recorded.
  const route = (await call(`/field-force/route?user_id=${ids.sita}&date=2026-11-09`, undefined, bossPhone)).data;
  assert.equal(route.points.length, 17);
  assert.equal(route.visits[0].customer, "Mr Sharma, loan 4411");
  assert.equal((await call(`/field-force/route?user_id=${ids.sita}`, undefined, otherPhone)).status, 403);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='field_route_viewed'").get());

  // Punch-out stops it: the phone is told to stop and later points are refused.
  await db.prepare("UPDATE shifts SET out_at=? WHERE user_id=? AND out_at IS NULL").run(new Date(IST("2026-11-09T14:00:00")).toISOString(), ids.ravi);
  nowMs = IST("2026-11-09T14:20:00");
  const after = await send(ravi, points("2026-11-09T14:15:00", "2026-11-09T14:15:00", 0));
  assert.deepEqual([after.data.saved, after.data.track], [0, false]);
  assert.equal((await call("/field-force/visits", { customer: "x" }, ravi)).status, 409);

  // Withdrawing stops it too, and is recorded.
  assert.equal((await call("/field-force/tracking/consent", { agree: false }, sita)).data.track, false);
  assert.equal((await send(sita, points("2026-11-09T14:15:00", "2026-11-09T14:15:00", 0))).data.saved, 0);
  assert.ok(await db.prepare("SELECT 1 FROM audit WHERE action='location_sharing_withdrawn'").get());

  // A tracker upload: by employee code, only inside the shift.
  const imported = (
    await call(
      "/field-force/pings/import",
      {
        rows: [
          { employee_code: "TARA", time: new Date(IST("2026-11-09T14:00:00")).toISOString(), latitude: 26.92, longitude: 75.79 },
          { employee_code: "TARA", time: new Date(IST("2026-11-09T07:00:00")).toISOString(), latitude: 26.92, longitude: 75.79 },
          { employee_code: "NOBODY", time: new Date(IST("2026-11-09T14:00:00")).toISOString(), latitude: 26.92, longitude: 75.79 },
        ],
      },
      admin,
    )
  ).data;
  assert.deepEqual(imported, { rows: 3, saved: 1, unknown: 1, outside_shift_or_duplicate: 1 });

  // Old points are deleted after the retention period.
  await call("/field-force/tracking/settings", { keep_days: 7 }, admin, "PATCH");
  nowMs = IST("2026-11-20T09:00:00");
  await runFieldForce(app);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ff_pings").get()).n, 0);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM ff_visits").get()).n, 1, "visits are kept");
});
