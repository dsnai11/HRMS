import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { computeMuster } from "../server/muster.js";

// OD punch: chosen people punch in and out away from their workplace; the day waits for approval.
test("OD punch in and out from anywhere, sent for approval, counted only when approved", async (t) => {
  let nowMs = Date.parse("2026-10-19T09:30:00+05:30");
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
  const call = async (path, body, token, headers = {}, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  const site = (
    await call("/admin/workplaces", { name: "HO", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, admin)
  ).data.id;
  const id = (
    await call("/admin/employees", { name: "Field", email: "field@example.test", password: "Temporary-pass-123", workplace_id: site }, admin)
  ).data.id;
  await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
  const device = { id: "field-device-00000001", platform: "android", model: "Pixel" };
  const reg = await call("/login", { email: "field@example.test", password: "Temporary-pass-123", native: true, device });
  const row = (await call("/admin/devices", undefined, admin)).data[0];
  await call(`/admin/devices/${row.id}`, { status: "approved" }, admin, {}, "PATCH");
  const headers = { "X-Device-Id": device.id, "X-Device-Secret": reg.data.deviceSecret };
  // Kota, about 200 km from the office.
  const away = { latitude: 25.2138, longitude: 75.8648, accuracy: 15 };
  const punch = (action, local, extra = {}) => {
    nowMs = Date.parse(local);
    return call(
      "/punch",
      { action, location: { ...away, timestamp: nowMs }, signals: { emulator: false, rooted: false }, ...extra },
      reg.data.token,
      headers,
    );
  };

  // Not switched on: OD is refused, and a normal punch away from the office says so plainly.
  const notAllowed = await punch("in", "2026-10-19T09:30:00+05:30", { od: { purpose: "Client visit" } });
  assert.equal(notAllowed.status, 403);
  assert.equal((await call("/me", undefined, reg.data.token, headers)).data.user.od_punch, false);
  assert.doesNotMatch((await punch("in", "2026-10-19T09:31:00+05:30")).data.error, /OD Punch In/);

  // HR switches it on.
  assert.equal((await call("/admin/od-punch", { user_ids: [id], allowed: true }, admin, {}, "PATCH")).status, 200);
  assert.equal((await call("/admin/od-punch", undefined, admin)).data.find((p) => p.id === id).od_punch, true);
  assert.equal((await call("/me", undefined, reg.data.token, headers)).data.user.od_punch, true);
  assert.match((await punch("in", "2026-10-19T09:32:00+05:30")).data.error, /OD Punch In/);
  assert.equal((await punch("in", "2026-10-19T09:33:00+05:30", { od: { purpose: "" } })).status, 400);

  const odIn = await punch("in", "2026-10-19T09:35:00+05:30", { od: { purpose: "Collection visit, Kota" } });
  assert.equal(odIn.status, 200);
  assert.equal(odIn.data.source, "od_punch");
  assert.equal(odIn.data.od_purpose, "Collection visit, Kota");
  assert.equal(odIn.data.in_latitude, away.latitude);
  // Nothing to approve until the OD punch-out.
  assert.equal((await call("/regularizations", undefined, reg.data.token, headers)).data.length, 0);

  const odOut = await punch("out", "2026-10-19T17:50:00+05:30");
  assert.equal(odOut.status, 200);
  assert.equal(odOut.data.out_latitude, away.latitude);
  const [request] = (await call("/regularizations", undefined, reg.data.token, headers)).data;
  assert.deepEqual(
    [request.kind, request.date, request.in_time, request.out_time, request.status, request.shift_id],
    ["on_duty", "2026-10-19", "09:35", "17:50", "pending", odOut.data.id],
  );
  assert.match(request.reason, /Collection visit, Kota/);
  // A second punch-out is refused, and the employee cannot withdraw the OD.
  assert.equal((await punch("out", "2026-10-19T18:10:00+05:30")).status, 409);
  assert.equal((await call(`/regularizations/${request.id}/cancel`, {}, reg.data.token, headers)).status, 409);

  // The approver sees it in the inbox; approval makes it a full day on duty with the real times.
  const inbox = (await call("/approvals", undefined, admin)).data.regularizations;
  assert.ok(inbox.some((r) => r.id === request.id));
  assert.equal((await call(`/regularizations/${request.id}/decision`, { decision: "approved" }, admin)).status, 200);
  const approved = await db.prepare("SELECT * FROM shifts WHERE id=?").get(odOut.data.id);
  assert.deepEqual([approved.source, approved.day_type], ["on_duty", "full_day"]);
  assert.equal(new Date(approved.in_at).getTime(), Date.parse("2026-10-19T09:35:00+05:30"));

  // Next day: OD punched but rejected, so the day is absent in the muster.
  await punch("in", "2026-10-20T09:40:00+05:30", { od: { purpose: "Branch audit" } });
  await punch("out", "2026-10-20T18:00:00+05:30");
  const second = (await call("/regularizations", undefined, reg.data.token, headers)).data.find((r) => r.date === "2026-10-20");
  assert.equal((await call(`/regularizations/${second.id}/decision`, { decision: "rejected" }, admin)).status, 200);
  nowMs = Date.parse("2026-10-31T12:00:00+05:30");
  await db.prepare("UPDATE companies SET attendance_start_date='2026-10-01'").run();
  const muster = await computeMuster(app, { companyId: 1, month: "2026-10", userIds: [id] });
  const day = (d) => muster.people[0].days.find((x) => x.date === d);
  assert.deepEqual([day("2026-10-19").present, day("2026-10-19").source], [1, "on_duty"]);
  assert.deepEqual([day("2026-10-20").present, day("2026-10-20").source], [0, "od_rejected"]);

  // OD punches do not use up the monthly allowance of corrections.
  const used = await db
    .prepare("SELECT COUNT(*) n FROM regularizations WHERE user_id=? AND from_punch=1")
    .get(id);
  assert.equal(Number(used.n), 2);
});
