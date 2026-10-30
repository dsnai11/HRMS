import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

// OD trips: during a normal shift, out of the office on duty and back, or ending the day
// outside. Each trip is approved by the manager; a rejected trip that ended the day outside
// moves the punch-out back to when the person left.
test("OD Out and OD In during a shift, punching out while out, and the manager's decision", async (t) => {
  let nowMs = Date.parse("2026-11-02T09:30:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server } = createApp({ db, clock: () => nowMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, headers = {}, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, admin)).data.id;
  const person = async (name, extra = {}) => {
    const id = (await call("/admin/employees", { name, email: `${name}@example.test`, password: "Temporary-pass-123", workplace_id: site, ...extra }, admin)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const device = { id: `${name}-device-0000001`.slice(0, 40), platform: "android", model: "Pixel" };
    const reg = await call("/login", { email: `${name}@example.test`, password: "Temporary-pass-123", native: true, device });
    const row = (await call("/admin/devices", undefined, admin)).data.find((d) => d.user_id === id);
    await call(`/admin/devices/${row.id}`, { status: "approved" }, admin, {}, "PATCH");
    return { id, token: reg.data.token, headers: { "X-Device-Id": device.id, "X-Device-Secret": reg.data.deviceSecret } };
  };
  const boss = await person("boss");
  const emp = await person("field", { manager_id: boss.id });
  const office = { latitude: 26.9124, longitude: 75.7873 };
  const kota = { latitude: 25.2138, longitude: 75.8648 };
  const punch = (who, action, local, where = office, extra = {}) => {
    nowMs = Date.parse(local);
    return call("/punch", { action, location: { ...where, accuracy: 12, timestamp: nowMs }, signals: { emulator: false, rooted: false }, ...extra }, who.token, who.headers);
  };
  const me = async (who) => (await call("/me", undefined, who.token, who.headers)).data;

  // Not punched in, not allowed: refused.
  assert.equal((await punch(emp, "od_out", "2026-11-02T09:31:00+05:30", office, { purpose: "Bank" })).status, 409);
  assert.equal((await punch(emp, "in", "2026-11-02T09:32:00+05:30")).status, 200);
  assert.equal((await punch(emp, "od_out", "2026-11-02T11:00:00+05:30", office, { purpose: "Bank" })).status, 403);
  assert.equal((await me(emp)).od_allowed, false);

  // HR switches OD on for everyone.
  assert.equal((await call("/admin/attendance-settings", { od_everyone: true }, admin, {}, "PATCH")).status, 200);
  assert.equal((await me(emp)).od_allowed, true);
  assert.equal((await punch(emp, "od_out", "2026-11-02T11:00:00+05:30", office, { purpose: "" })).status, 400);
  const out = await punch(emp, "od_out", "2026-11-02T11:05:00+05:30", office, { purpose: "Bank deposit, SBI MI Road" });
  assert.equal(out.status, 200, JSON.stringify(out.data));
  assert.equal(out.data.trip.status, "open");
  assert.equal((await me(emp)).openTrip.purpose, "Bank deposit, SBI MI Road");
  assert.equal((await punch(emp, "od_out", "2026-11-02T11:06:00+05:30", kota, { purpose: "Again" })).status, 409, "one trip at a time");
  // Back: recorded wherever the person is, then waiting for the manager.
  const back = await punch(emp, "od_in", "2026-11-02T12:40:00+05:30", { latitude: 26.915, longitude: 75.79 });
  assert.equal(back.status, 200, JSON.stringify(back.data));
  assert.deepEqual([back.data.trip.status, back.data.trip.ended_by], ["pending", "od_in"]);
  assert.equal((await punch(emp, "od_in", "2026-11-02T12:41:00+05:30")).status, 409);
  assert.equal((await me(emp)).openTrip, null);

  // The manager sees it; nobody decides their own; a rejection needs a reason.
  const waiting = (await call("/od-visits/pending", undefined, boss.token, boss.headers)).data;
  assert.deepEqual(waiting.map((v) => v.purpose), ["Bank deposit, SBI MI Road"]);
  const tripId = waiting[0].id;
  assert.equal((await call(`/od-visits/${tripId}/decision`, { decision: "approved" }, emp.token, emp.headers)).status, 403);
  assert.equal((await call(`/od-visits/${tripId}/decision`, { decision: "rejected" }, boss.token, boss.headers)).status, 400);
  assert.equal((await call(`/od-visits/${tripId}/decision`, { decision: "approved" }, boss.token, boss.headers)).status, 200);
  assert.equal((await call(`/od-visits/${tripId}/decision`, { decision: "rejected", note: "x" }, boss.token, boss.headers)).status, 409);

  // Without a trip, punching out away from the office is refused, with a hint.
  const away = await punch(emp, "out", "2026-11-02T15:00:00+05:30", kota);
  assert.equal(away.status, 422);
  assert.match(away.data.error, /OD Out/);
  // A second trip that ends the day outside: punch out from the field.
  assert.equal((await punch(emp, "od_out", "2026-11-02T15:30:00+05:30", office, { purpose: "Customer visit, Kota" })).status, 200);
  const fieldOut = await punch(emp, "out", "2026-11-02T18:45:00+05:30", kota);
  assert.equal(fieldOut.status, 200, JSON.stringify(fieldOut.data));
  assert.equal(fieldOut.data.day_type, "full_day");
  const second = (await call("/od-visits", undefined, emp.token, emp.headers)).data.find((v) => v.purpose.startsWith("Customer"));
  assert.deepEqual([second.status, second.ended_by], ["pending", "punch_out"]);
  // On the map: both trips' starts and the first one's return.
  const map = (await call("/admin/punch-map?date=2026-11-02", undefined, admin)).data;
  assert.deepEqual(map.points.filter((p) => p.source === "od_trip").map((p) => p.kind), ["od_out", "od_in", "od_out"]);

  // Rejected: the punch-out goes back to 15:30, which is before a full day ends.
  const rej = await call(`/od-visits/${second.id}/decision`, { decision: "rejected", note: "No customer visit on record" }, boss.token, boss.headers);
  assert.deepEqual([rej.status, rej.data.adjusted], [200, true]);
  const shift = await db.prepare("SELECT * FROM shifts WHERE id=?").get(fieldOut.data.id);
  assert.equal(new Date(shift.out_at).getTime(), Date.parse("2026-11-02T15:30:00+05:30"));
  assert.equal(shift.day_type, "half_day");
  assert.ok(JSON.parse(shift.half_day_reasons).includes("early_out"));
  assert.equal(shift.out_latitude, office.latitude);

  // A trip left open overnight closes with the missed punch-out and waits for a decision.
  assert.equal((await punch(emp, "in", "2026-11-03T09:30:00+05:30")).status, 200);
  assert.equal((await punch(emp, "od_out", "2026-11-03T16:00:00+05:30", office, { purpose: "Audit, Ajmer" })).status, 200);
  nowMs = Date.parse("2026-11-04T09:00:00+05:30");
  assert.equal((await me(emp)).openTrip, null);
  const left = (await call("/od-visits", undefined, emp.token, emp.headers)).data[0];
  assert.deepEqual([left.purpose, left.status, left.ended_by], ["Audit, Ajmer", "pending", "auto"]);
  // An OD day has no trips: the whole day is already out.
  assert.equal((await punch(emp, "in", "2026-11-04T09:30:00+05:30", kota, { od: { purpose: "Branch audit" } })).status, 200);
  assert.equal((await punch(emp, "od_out", "2026-11-04T11:00:00+05:30", kota, { purpose: "x" })).status, 409);
});
