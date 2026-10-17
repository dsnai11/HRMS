import { test } from "node:test";
import assert from "node:assert/strict";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { checkLocation, distanceMeters } from "../server/geo.js";
import { assessPunch, parseSignals } from "../server/risk.js";
import {
  DEFAULT_POLICY,
  evaluatePunchIn,
  halfDayReasons,
  loadPolicy,
} from "../server/policy.js";
export function attendanceCases(openTestDatabase) {
  test("first administrator setup requires a private code and can only be used once", async (t) => {
    const original = process.env.SETUP_TOKEN;
    process.env.SETUP_TOKEN = "test-only-private-setup-code-123456789";
    const db = await openTestDatabase();
    const { server } = createApp({
      db,
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          if (original === undefined) delete process.env.SETUP_TOKEN;
          else process.env.SETUP_TOKEN = original;
          server.close(async () => {
            await db.close();
            resolve();
          });
          server.closeAllConnections();
        }),
    );
    const base = `http://127.0.0.1:${server.address().port}/api`;
    assert.equal(
      (await (await fetch(base + "/config")).json()).setupRequired,
      true,
    );
    const body = {
      name: "Owner",
      email: "owner@example.test",
      password: "Private-password-123",
      setupToken: "wrong",
    };
    const setup = () =>
      fetch(base + "/setup", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    assert.equal((await setup()).status, 403);
    body.setupToken = process.env.SETUP_TOKEN;
    assert.equal((await setup()).status, 201);
    assert.equal((await setup()).status, 409);
    assert.equal(
      (await (await fetch(base + "/config")).json()).setupRequired,
      false,
    );
  });
  const loc = (extra = {}) => ({
    latitude: 26.9124,
    longitude: 75.7873,
    accuracy: 10,
    timestamp: Date.now(),
    ...extra,
  });
  test("geofence accounts for uncertainty, freshness, ranges and mock locations", () => {
    const site = {
      name: "Office",
      latitude: 26.9124,
      longitude: 75.7873,
      radius: 100,
      max_accuracy: 50,
    };
    assert.equal(distanceMeters(0, 0, 0, 0), 0);
    assert.ok(Math.abs(distanceMeters(0, 0, 0, 1) - 111195) < 1);
    assert.equal(checkLocation(loc(), site), 0);
    for (const value of [
      loc({
        latitude: 27,
      }),
      loc({
        accuracy: 51,
      }),
      loc({
        accuracy: 0,
      }),
      loc({
        latitude: NaN,
      }),
      loc({
        timestamp: Date.now() - 61000,
      }),
      loc({
        timestamp: Date.now() + 11000,
      }),
      loc({
        mocked: true,
      }),
      loc({
        latitude: 26.9132,
        accuracy: 30,
      }),
    ])
      assert.throws(() => checkLocation(value, site));
  });
  test("risk assessment rejects emulators and impossible travel and flags repeated coordinates", () => {
    const here = { latitude: 26.9124, longitude: 75.7873 };
    const clean = parseSignals({ emulator: false, rooted: false });
    const at = (ms) => new Date(Date.now() - ms).toISOString();
    assert.equal(
      assessPunch({ signals: clean, location: here, previous: [] }).reject,
      null,
    );
    assert.ok(
      assessPunch({
        signals: parseSignals({ emulator: true }),
        location: here,
        previous: [],
      }).reject,
    );
    assert.deepEqual(
      assessPunch({
        signals: parseSignals({ rooted: true }),
        location: here,
        previous: [],
      }).flags,
      ["rooted_device"],
    );
    // About 110 km in one minute.
    assert.equal(
      assessPunch({
        signals: clean,
        location: here,
        previous: [
          { latitude: 27.9124, longitude: 75.7873, created_at: at(60000) },
        ],
      }).flags[0],
      "impossible_travel",
    );
    // The same distance over a day is ordinary travel.
    assert.equal(
      assessPunch({
        signals: clean,
        location: here,
        previous: [
          { latitude: 27.9124, longitude: 75.7873, created_at: at(86400000) },
        ],
      }).reject,
      null,
    );
    const same = { ...here, created_at: at(3600000) };
    assert.deepEqual(
      assessPunch({
        signals: clean,
        location: here,
        previous: [same, same, same],
      }).flags,
      ["repeated_exact_coordinates"],
    );
    assert.deepEqual(
      assessPunch({ signals: clean, location: here, previous: [same, same] })
        .flags,
      [],
    );
    assert.deepEqual(parseSignals("junk"), {
      emulator: false,
      rooted: null,
      platform: null,
      osVersion: null,
      appVersion: null,
    });
  });
  test("attendance is accepted only from an approved, authenticated phone and refused attempts are recorded", async (t) => {
    const db = await openTestDatabase();
    await createAdmin(db, {
      name: "Admin",
      email: "admin@example.test",
      password: "Admin-password-123",
    });
    const { server } = createApp({ db });
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
    async function request(
      path,
      body,
      { token, headers = {}, method = "POST" } = {},
    ) {
      const res = await fetch(base + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return {
        status: res.status,
        data: await res.json(),
        headers: res.headers,
      };
    }
    const admin = (
      await request("/login", {
        email: "admin@example.test",
        password: "Admin-password-123",
        native: true,
      })
    ).data.token;
    const siteA = (
      await request(
        "/admin/workplaces",
        {
          name: "Jaipur",
          latitude: 26.9124,
          longitude: 75.7873,
          radius: 150,
          max_accuracy: 50,
        },
        { token: admin },
      )
    ).data.id;
    const siteB = (
      await request(
        "/admin/workplaces",
        {
          name: "Delhi",
          latitude: 28.6139,
          longitude: 77.209,
          radius: 150,
          max_accuracy: 50,
        },
        { token: admin },
      )
    ).data.id;
    const makeEmployee = async (n) => {
      const email = `emp${n}@example.test`;
      const id = (
        await request(
          "/admin/employees",
          {
            name: `Employee ${n}`,
            email,
            password: "Temporary-pass-123",
            workplace_id: siteA,
          },
          { token: admin },
        )
      ).data.id;
      await db
        .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
        .run(id);
      return { id, email };
    };
    const device = (n) => ({
      id: `device-${String(n).padStart(16, "0")}`,
      platform: "android",
      model: "Pixel",
    });
    const signIn = (email, dev) =>
      request("/login", {
        email,
        password: "Temporary-pass-123",
        native: true,
        ...(dev ? { device: dev } : {}),
      });
    const punch = (session, action, extra = {}, headers = {}) =>
      request(
        "/punch",
        {
          action,
          location: loc(),
          signals: { emulator: false, rooted: false },
          ...extra,
        },
        {
          token: session.token,
          headers: session.headers,
          ...(headers && { headers: { ...session.headers, ...headers } }),
        },
      );
    const approve = async (employeeId, status = "approved") => {
      const list = (
        await request("/admin/devices", undefined, { token: admin })
      ).data;
      const row = list.find(
        (d) => d.user_id === employeeId && d.status !== "revoked",
      );
      assert.ok(row);
      assert.equal(
        (
          await request(
            `/admin/devices/${row.id}`,
            { status },
            { token: admin, method: "PATCH" },
          )
        ).status,
        200,
      );
      return row.id;
    };

    const one = await makeEmployee(1);
    // Employees cannot sign in from the app without a device identity.
    assert.equal((await signIn(one.email)).status, 400);
    // A browser session (cookie, no bearer) cannot punch.
    const web = await fetch(base + "/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: one.email,
        password: "Temporary-pass-123",
      }),
    });
    const cookie = web.headers.get("set-cookie").split(";")[0];
    const webPunch = await fetch(base + "/punch", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ action: "in", location: loc() }),
    });
    assert.equal(webPunch.status, 403);
    assert.match((await webPunch.json()).error, /mobile app/);

    const reg = await signIn(one.email, device(1));
    assert.equal(reg.data.device.status, "pending");
    const phone = {
      token: reg.data.token,
      headers: {
        "X-Device-Id": device(1).id,
        "X-Device-Secret": reg.data.deviceSecret,
      },
    };
    // Pending phone: refused. Wrong secret and missing headers: refused.
    assert.equal((await punch(phone, "in")).status, 403);
    assert.equal(
      (await punch(phone, "in", {}, { "X-Device-Secret": "0".repeat(64) }))
        .status,
      403,
    );
    assert.equal(
      (await punch({ token: phone.token, headers: {} }, "in")).status,
      403,
    );
    // The device status is visible to the phone.
    assert.equal(
      (
        await request("/me", undefined, {
          token: phone.token,
          headers: phone.headers,
        })
      ).data.device.status,
      "pending",
    );
    // Logging in again without the key cannot take over the registration.
    assert.equal((await signIn(one.email, device(1))).status, 409);
    // Another account cannot claim the same physical phone.
    const two = await makeEmployee(2);
    assert.equal((await signIn(two.email, device(1))).status, 409);

    const firstDevice = await approve(one.id);
    // Mock locations, emulators and a bad site are refused and logged.
    assert.equal(
      (await punch(phone, "in", { location: loc({ mocked: true }) })).status,
      422,
    );
    assert.equal(
      (await punch(phone, "in", { signals: { emulator: true, rooted: false } }))
        .status,
      422,
    );
    const inPunch = await punch(phone, "in", {
      signals: { emulator: false, rooted: true },
    });
    assert.equal(inPunch.status, 200);
    assert.equal((await punch(phone, "out")).status, 200);

    // Impossible travel: reassigned to a city ~240 km away, punching moments later.
    await db
      .prepare("UPDATE users SET workplace_id=? WHERE id=?")
      .run(siteB, one.id);
    const far = await punch(phone, "in", {
      location: loc({ latitude: 28.6139, longitude: 77.209 }),
    });
    assert.equal(far.status, 422);
    assert.match(far.data.error, /too fast/);

    const events = (
      await request("/admin/security-events", undefined, { token: admin })
    ).data;
    const flags = events.map((e) => JSON.parse(e.flags)[0]);
    for (const expected of [
      "device_pending",
      "device_unknown",
      "mock_location",
      "emulator",
      "rooted_device",
      "impossible_travel",
    ])
      assert.ok(flags.includes(expected), `missing ${expected} in ${flags}`);
    assert.ok(events.every((e) => e.employee_name === "Employee 1"));

    // Replacing the phone: new device is pending; approving it revokes the old one.
    await db
      .prepare("UPDATE users SET workplace_id=? WHERE id=?")
      .run(siteA, one.id);
    const reg2 = await signIn(one.email, device(3));
    assert.equal(reg2.data.device.status, "pending");
    const phone2 = {
      token: reg2.data.token,
      headers: {
        "X-Device-Id": device(3).id,
        "X-Device-Secret": reg2.data.deviceSecret,
      },
    };
    const list = (await request("/admin/devices", undefined, { token: admin }))
      .data;
    const newRow = list.find((d) => d.status === "pending");
    assert.equal(
      (
        await request(
          `/admin/devices/${newRow.id}`,
          { status: "approved" },
          { token: admin, method: "PATCH" },
        )
      ).status,
      200,
    );
    const after = (await request("/admin/devices", undefined, { token: admin }))
      .data;
    assert.equal(after.find((d) => d.id === firstDevice).status, "revoked");
    assert.equal(
      (await punch(phone, "in")).status,
      403,
      "revoked phone must stop working",
    );
    assert.equal((await punch(phone2, "in")).status, 200);
    // Non-admins cannot approve devices.
    assert.equal(
      (
        await request(
          `/admin/devices/${newRow.id}`,
          { status: "approved" },
          { token: phone2.token, headers: phone2.headers, method: "PATCH" },
        )
      ).status,
      403,
    );
  });
  test("shift rules: grace until 9:45, nine hours, never out before 6:30 pm", () => {
    const at = (hhmmss) => Date.parse(`2026-10-19T${hhmmss}+05:30`);
    const rule = (hhmmss) =>
      evaluatePunchIn(DEFAULT_POLICY, at(hhmmss), "Asia/Kolkata");
    const outLocal = (r) =>
      new Intl.DateTimeFormat("en-GB", {
        timeZone: "Asia/Kolkata",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }).format(new Date(r.requiredOutAt));
    assert.deepEqual(
      [rule("09:30:00").late, outLocal(rule("09:30:00"))],
      [false, "18:30:00"],
    );
    assert.deepEqual(
      [rule("09:32:00").late, outLocal(rule("09:32:00"))],
      [false, "18:32:00"],
    );
    assert.equal(rule("09:45:59").late, false);
    assert.equal(rule("09:46:00").late, true);
    // Arriving early gives no earlier exit.
    assert.equal(outLocal(rule("09:00:00")), "18:30:00");
    assert.equal(outLocal(rule("08:10:00")), "18:30:00");
    assert.equal(outLocal(rule("11:00:00")), "20:00:00");
    const required = rule("09:32:00").requiredOutAt;
    assert.deepEqual(
      halfDayReasons({
        late: false,
        requiredOutAt: required,
        outMs: at("18:31:59"),
      }),
      ["early_out"],
    );
    assert.deepEqual(
      halfDayReasons({
        late: false,
        requiredOutAt: required,
        outMs: at("18:32:00"),
      }),
      [],
    );
    assert.deepEqual(
      halfDayReasons({
        late: true,
        requiredOutAt: required,
        outMs: at("19:00:00"),
      }),
      ["late_in"],
    );
    assert.deepEqual(
      halfDayReasons({
        late: true,
        requiredOutAt: required,
        outMs: at("17:00:00"),
      }),
      ["late_in", "early_out"],
    );
    const custom = loadPolicy({
      SHIFT_START: "10:00",
      LATE_GRACE_MINUTES: "10",
      SHIFT_HOURS: "8",
      EARLIEST_OUT: "17:00",
    });
    assert.equal(
      evaluatePunchIn(custom, at("10:10:59"), "Asia/Kolkata").late,
      false,
    );
    assert.equal(
      evaluatePunchIn(custom, at("10:11:00"), "Asia/Kolkata").late,
      true,
    );
    assert.throws(() => loadPolicy({ SHIFT_START: "9:30am" }));
  });
  test("punches are marked full or half day by the shift rules", async (t) => {
    let nowMs = Date.parse("2026-10-19T09:00:00+05:30");
    const db = await openTestDatabase();
    await createAdmin(db, {
      name: "Admin",
      email: "admin@example.test",
      password: "Admin-password-123",
    });
    const { server } = createApp({ db, clock: () => nowMs });
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
    const call = async (path, body, token, headers = {}, method = "POST") => {
      const res = await fetch(base + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, data: await res.json() };
    };
    const admin = (
      await call("/login", {
        email: "admin@example.test",
        password: "Admin-password-123",
        native: true,
      })
    ).data.token;
    const site = (
      await call(
        "/admin/workplaces",
        {
          name: "Office",
          latitude: 26.9124,
          longitude: 75.7873,
          radius: 150,
          max_accuracy: 50,
        },
        admin,
      )
    ).data.id;
    async function employee(n) {
      const email = `shift${n}@example.test`;
      const id = (
        await call(
          "/admin/employees",
          {
            name: `Shift ${n}`,
            email,
            password: "Temporary-pass-123",
            workplace_id: site,
          },
          admin,
        )
      ).data.id;
      await db
        .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
        .run(id);
      const device = {
        id: `shift-device-${String(n).padStart(8, "0")}`,
        platform: "ios",
        model: "iPhone",
      };
      const reg = await call("/login", {
        email,
        password: "Temporary-pass-123",
        native: true,
        device,
      });
      const row = (await call("/admin/devices", undefined, admin)).data.find(
        (d) => d.user_id === id,
      );
      await call(
        `/admin/devices/${row.id}`,
        { status: "approved" },
        admin,
        {},
        "PATCH",
      );
      const headers = {
        "X-Device-Id": device.id,
        "X-Device-Secret": reg.data.deviceSecret,
      };
      return (action, local) => {
        nowMs = Date.parse(`2026-10-19T${local}+05:30`);
        return call(
          "/punch",
          {
            action,
            location: loc({ timestamp: nowMs }),
            signals: { emulator: false, rooted: false },
          },
          reg.data.token,
          headers,
        );
      };
    }
    const onTime = await employee(1);
    const inA = await onTime("in", "09:32:00");
    assert.equal(inA.status, 200);
    assert.equal(inA.data.day_type, null);
    assert.equal(
      new Date(inA.data.required_out_at).getTime(),
      Date.parse("2026-10-19T18:32:00+05:30"),
    );
    const early = await onTime("out", "18:31:00");
    assert.equal(early.data.day_type, "half_day");
    assert.deepEqual(JSON.parse(early.data.half_day_reasons), ["early_out"]);

    const grace = await employee(2);
    assert.equal((await grace("in", "09:45:59")).data.day_type, null);
    const full = await grace("out", "18:46:00");
    assert.equal(full.data.day_type, "full_day");

    const late = await employee(3);
    const lateIn = await late("in", "09:46:00");
    assert.equal(lateIn.data.day_type, "half_day");
    assert.deepEqual(JSON.parse(lateIn.data.half_day_reasons), ["late_in"]);
    const lateOut = await late("out", "19:30:00");
    assert.equal(lateOut.data.day_type, "half_day");
    assert.deepEqual(JSON.parse(lateOut.data.half_day_reasons), ["late_in"]);

    const earlyBird = await employee(4);
    const birdIn = await earlyBird("in", "09:00:00");
    assert.equal(
      new Date(birdIn.data.required_out_at).getTime(),
      Date.parse("2026-10-19T18:30:00+05:30"),
    );
    assert.equal(
      (await earlyBird("out", "18:30:00")).data.day_type,
      "full_day",
    );

    const report = (
      await call(
        "/admin/attendance?from=2026-10-19&to=2026-10-19",
        undefined,
        admin,
      )
    ).data;
    assert.equal(report.filter((r) => r.day_type === "half_day").length, 2);
    assert.equal(report.filter((r) => r.day_type === "full_day").length, 2);
  });
  test("attendance API enforces roles, assignment, same-site punch-out, sessions and reports", async (t) => {
    const db = await openTestDatabase();
    await createAdmin(db, {
      name: "Admin",
      email: "admin@example.test",
      password: "Admin-password-123",
    });
    const { server } = createApp({
      db,
    });
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
    let punchHeaders = {};
    async function request(path, body, token, method = "POST") {
      const res = await fetch(base + path, {
        method: body === undefined ? "GET" : method,
        headers: {
          "Content-Type": "application/json",
          ...(path === "/punch" ? punchHeaders : {}),
          ...(token
            ? {
                Authorization: `Bearer ${token}`,
              }
            : {}),
        },
        ...(body !== undefined
          ? {
              body: JSON.stringify(body),
            }
          : {}),
      });
      return {
        status: res.status,
        data: res.headers.get("content-type").includes("json")
          ? await res.json()
          : await res.text(),
        headers: res.headers,
      };
    }
    assert.equal((await request("/admin/employees")).status, 401);
    assert.equal((await request("/login", null)).status, 400);
    assert.equal((await request("/login", [])).status, 400);
    assert.equal(
      (
        await request("/login", {
          email: "admin@example.test",
          password: "wrong",
        })
      ).status,
      401,
    );
    const login = await request("/login", {
      email: "admin@example.test",
      password: "Admin-password-123",
      native: true,
    });
    const admin = login.data.token;
    assert.equal(login.status, 200);
    assert.match(login.headers.get("set-cookie"), /HttpOnly/);
    const office = (
      await request(
        "/admin/workplaces",
        {
          name: "Office",
          latitude: 26.9124,
          longitude: 75.7873,
          radius: 150,
          max_accuracy: 50,
        },
        admin,
      )
    ).data.id;
    const other = (
      await request(
        "/admin/workplaces",
        {
          name: "Other",
          latitude: 28,
          longitude: 77,
          radius: 150,
          max_accuracy: 50,
        },
        admin,
      )
    ).data.id;
    assert.equal(
      (
        await request(
          "/admin/workplaces",
          {
            name: "Bad",
            latitude: 999,
            longitude: 0,
            radius: 100,
            max_accuracy: 50,
          },
          admin,
        )
      ).status,
      400,
    );
    const employee = (
      await request(
        "/admin/employees",
        {
          name: "=Formula Employee",
          email: "employee@example.test",
          password: "Temporary-pass-123",
          workplace_id: office,
        },
        admin,
      )
    ).data.id;
    const registration = await request("/login", {
      email: "employee@example.test",
      password: "Temporary-pass-123",
      native: true,
      device: {
        id: "test-device-000000001",
        platform: "android",
        model: "Pixel 8",
      },
    });
    let session = registration.data.token;
    assert.equal(registration.data.device.status, "pending");
    punchHeaders = {
      "X-Device-Id": "test-device-000000001",
      "X-Device-Secret": registration.data.deviceSecret,
    };
    const pending = (await request("/admin/devices", undefined, admin)).data;
    assert.equal(pending.length, 1);
    assert.equal(
      (
        await request(
          `/admin/devices/${pending[0].id}`,
          { status: "approved" },
          admin,
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "in",
            location: loc(),
          },
          session,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/password",
          {
            currentPassword: "Temporary-pass-123",
            newPassword: "Employee-password-123",
          },
          session,
        )
      ).status,
      200,
    );
    assert.equal(
      (await request("/admin/employees", undefined, session)).status,
      403,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "out",
            location: loc(),
          },
          session,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "in",
            location: loc({
              latitude: 28,
              longitude: 77,
            }),
          },
          session,
        )
      ).status,
      422,
    );
    const punches = await Promise.all([
      request(
        "/punch",
        {
          action: "in",
          location: loc(),
        },
        session,
      ),
      request(
        "/punch",
        {
          action: "in",
          location: loc(),
        },
        session,
      ),
    ]);
    assert.deepEqual(punches.map((p) => p.status).sort(), [200, 409]);
    assert.equal(
      (
        await request(
          `/admin/employees/${employee}`,
          {
            active: true,
            workplace_id: other,
          },
          admin,
          "PATCH",
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          `/admin/employees/${employee}`,
          {
            active: false,
            workplace_id: office,
          },
          admin,
          "PATCH",
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "out",
            location: loc({
              latitude: 28,
              longitude: 77,
            }),
          },
          session,
        )
      ).status,
      422,
    );
    // A direct database assignment change still cannot redirect an open shift's punch-out.
    await db
      .prepare("UPDATE users SET workplace_id=? WHERE id=?")
      .run(other, employee);
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "out",
            location: loc({
              latitude: 28,
              longitude: 77,
            }),
          },
          session,
        )
      ).status,
      422,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "out",
            location: loc(),
          },
          session,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await request(
          "/punch",
          {
            action: "out",
            location: loc(),
          },
          session,
        )
      ).status,
      409,
    );
    const shifts = (await request("/shifts", undefined, session)).data;
    assert.equal(shifts.length, 1);
    assert.ok(shifts[0].out_at);
    const overview = (await request("/admin/overview", undefined, admin)).data;
    assert.equal(overview.active, 0);
    assert.equal(overview.attended, 1);
    const report = await request(
      `/admin/attendance?from=${overview.today}&to=${overview.today}`,
      undefined,
      admin,
    );
    assert.equal(report.data.length, 1);
    const csv = await request(
      `/admin/export?from=${overview.today}`,
      undefined,
      admin,
    );
    assert.match(csv.data, /'=Formula Employee/);
    assert.equal(
      (await request("/admin/attendance?from=2026-02-30", undefined, admin))
        .status,
      400,
    );
    const csrf = await fetch(base + "/logout", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
        Authorization: `Bearer ${session}`,
      },
      body: "{}",
    });
    assert.equal(csrf.status, 403);
    assert.equal(
      (
        await request(
          `/admin/employees/${employee}`,
          {
            active: false,
            workplace_id: other,
          },
          admin,
          "PATCH",
        )
      ).status,
      200,
    );
    assert.equal((await request("/me", undefined, session)).status, 401);
    assert.equal(
      (
        await request("/login", {
          email: "employee@example.test",
          password: "Employee-password-123",
        })
      ).status,
      401,
    );
    assert.equal((await request("/logout", {}, admin)).status, 200);
    assert.equal(
      (await request("/admin/employees", undefined, admin)).status,
      401,
    );
  });
}
