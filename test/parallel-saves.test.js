import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { createGate, createPostgresStore } from "../server/postgres.js";
import { runMigrations } from "../server/migrate.js";

// A task that finishes only when told to, recording when it starts and ends.
function gated(log, name) {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  return {
    fn: async () => {
      log.push(`${name}+`);
      await done;
      log.push(`${name}-`);
      return name;
    },
    finish: () => finish(),
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("different people's personal saves run side by side; one person's run in order", async () => {
  const gate = createGate();
  const log = [];
  const a1 = gated(log, "a1"), a2 = gated(log, "a2"), b1 = gated(log, "b1");
  const results = [gate.personal(1, a1.fn), gate.personal(1, a2.fn), gate.personal(2, b1.fn)];
  await tick();
  assert.deepEqual(log, ["a1+", "b1+"], "a2 waits for a1; b1 does not wait at all");
  assert.equal(gate.running, 2);
  a1.finish();
  await tick();
  assert.deepEqual(log, ["a1+", "b1+", "a1-", "a2+"]);
  a2.finish();
  b1.finish();
  assert.deepEqual(await Promise.all(results), ["a1", "a2", "b1"]);
  assert.equal(gate.running, 0);
  assert.equal(gate.waiting, 0);
});

test("an exclusive save waits for running personal saves, and later ones wait for it", async () => {
  const gate = createGate();
  const log = [];
  const p1 = gated(log, "p1"), x = gated(log, "x"), p2 = gated(log, "p2"), x2 = gated(log, "x2");
  const all = [gate.personal(1, p1.fn), gate.exclusive(x.fn), gate.personal(2, p2.fn), gate.exclusive(x2.fn)];
  await tick();
  assert.deepEqual(log, ["p1+"], "p2 may not pass the exclusive save queued before it");
  p1.finish();
  await tick();
  assert.deepEqual(log, ["p1+", "p1-", "x+"]);
  x.finish();
  await tick();
  assert.deepEqual(log.slice(3), ["x-", "p2+"]);
  p2.finish();
  await tick();
  assert.deepEqual(log.slice(5), ["p2-", "x2+"], "exclusive saves run one at a time");
  x2.finish();
  await Promise.all(all);
});

test("a failed save hands back its error and does not hold up the queue", async () => {
  const gate = createGate();
  await assert.rejects(gate.personal(1, () => { throw new Error("boom"); }), /boom/);
  await assert.rejects(gate.exclusive(async () => { throw new Error("bang"); }), /bang/);
  assert.equal(await gate.personal(1, () => "after"), "after");
  assert.equal(await gate.exclusive(() => "still fine"), "still fine");
});

test("without parallel connections every save runs alone", async () => {
  const gate = createGate({ parallel: false });
  const log = [];
  const a = gated(log, "a"), b = gated(log, "b");
  const all = [gate.personal(1, a.fn), gate.personal(2, b.fn)];
  await tick();
  assert.deepEqual(log, ["a+"]);
  a.finish();
  await tick();
  assert.deepEqual(log, ["a+", "a-", "b+"]);
  b.finish();
  await Promise.all(all);
});

// An administrator, a workplace and `count` employees each signed in on an approved phone.
async function setUp(db, count, clock) {
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server } = createApp({ db, clock });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  const people = [];
  for (let i = 0; i < count; i++) {
    const email = `staff${i}@example.test`;
    const id = (
      await call("/admin/employees", { name: `Staff ${i}`, email, password: "Temporary-pass-123", workplace_id: site }, admin)
    ).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const device = { id: `staff-device-${String(i).padStart(8, "0")}`, platform: "android", model: "Pixel" };
    const reg = await call("/login", { email, password: "Temporary-pass-123", native: true, device });
    people.push({ id, token: reg.data.token, headers: { "X-Device-Id": device.id, "X-Device-Secret": reg.data.deviceSecret } });
  }
  for (const row of (await call("/admin/devices", undefined, admin)).data)
    await call(`/admin/devices/${row.id}`, { status: "approved" }, admin, {}, "PATCH");
  const punch = (person, action) =>
    call(
      "/punch",
      {
        action,
        location: { latitude: 26.9125, longitude: 75.7874, accuracy: 10, timestamp: clock() },
        signals: { emulator: false, rooted: false },
      },
      person.token,
      person.headers,
    );
  const close = () =>
    new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  return { call, admin, people, punch, close };
}

test("punch, leave and correction requests take the personal lane; HR changes stay exclusive", async (t) => {
  const nowMs = Date.parse("2026-10-19T09:30:00+05:30");
  const db = await openPglite();
  const env = await setUp(db, 3, () => nowMs);
  t.after(async () => {
    await env.close();
    await db.close();
  });
  const lanes = [];
  const { personal, exclusive } = db.gate;
  db.gate.personal = (key, fn) => (lanes.push(`personal:${key}`), personal(key, fn));
  db.gate.exclusive = (fn) => (lanes.push("exclusive"), exclusive(fn));
  const [a, b, c] = env.people;

  // Three people at once, and one of them tapping twice: both of a's taps cannot win.
  const results = await Promise.all([env.punch(a, "in"), env.punch(a, "in"), env.punch(b, "in"), env.punch(c, "in")]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 200, 409]);
  assert.match(results.find((r) => r.status === 409).data.error, /already have an active shift/);
  assert.deepEqual(lanes.sort(), [`personal:${a.id}`, `personal:${a.id}`, `personal:${b.id}`, `personal:${c.id}`]);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM shifts WHERE out_at IS NULL").get()).n, 3);

  lanes.length = 0;
  await env.call("/regularizations", { kind: "missed_punch", date: "2026-10-17", in_time: "09:30", out_time: "18:30", reason: "Forgot" }, b.token, b.headers);
  await env.call("/leave/requests", { leave_type_id: 999999, from_date: "2026-10-26" }, c.token, c.headers);
  assert.deepEqual(lanes, [`personal:${b.id}`, `personal:${c.id}`]);

  lanes.length = 0;
  await env.call("/admin/workplaces", { name: "Branch", latitude: 26, longitude: 75, radius: 100, max_accuracy: 50 }, env.admin);
  await env.call("/me", undefined, a.token, a.headers);
  assert.deepEqual(lanes, ["exclusive"], "an admin save runs alone; a read takes no lane");
});

// Optional: the same rush against a real PostgreSQL, where personal saves truly overlap.
// Set TEST_DATABASE_URL to a throwaway database (never the live one); the test works in a
// schema of its own and drops it afterwards.
test("a 9:30 rush on real PostgreSQL: everyone punches in once", { skip: !process.env.TEST_DATABASE_URL }, async (t) => {
  const schema = `parallel_test_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, max: 10, options: `-c search_path=${schema}` });
  const db = createPostgresStore(pool, { parallel: true });
  t.after(async () => {
    await db.close();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });
  await runMigrations(db);
  const nowMs = Date.parse("2026-10-19T09:30:00+05:30");
  const env = await setUp(db, 20, () => nowMs);
  t.after(env.close);
  let peak = 0;
  const { personal } = db.gate;
  db.gate.personal = (key, fn) => personal(key, async () => {
    peak = Math.max(peak, db.gate.running);
    return fn();
  });
  // Every person taps twice at the same moment.
  const results = await Promise.all(env.people.flatMap((p) => [env.punch(p, "in"), env.punch(p, "in")]));
  assert.equal(results.filter((r) => r.status === 200).length, 20);
  assert.equal(results.filter((r) => r.status === 409).length, 20);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM shifts WHERE out_at IS NULL").get()).n, 20);
  assert.ok(peak > 1, "punches overlapped");
});
