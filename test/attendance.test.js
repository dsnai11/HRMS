import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase, createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { checkLocation, distanceMeters } from "../server/geo.js";

test("first administrator setup requires a private code and can only be used once", async (t) => {
  const original = process.env.SETUP_TOKEN;
  process.env.SETUP_TOKEN = "test-only-private-setup-code-123456789";
  const db = openDatabase(":memory:");
  const { server } = createApp({ db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        if (original === undefined) delete process.env.SETUP_TOKEN;
        else process.env.SETUP_TOKEN = original;
        server.close(() => {
          db.close();
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
      headers: { "Content-Type": "application/json" },
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
    loc({ latitude: 27 }),
    loc({ accuracy: 51 }),
    loc({ accuracy: 0 }),
    loc({ latitude: NaN }),
    loc({ timestamp: Date.now() - 61000 }),
    loc({ timestamp: Date.now() + 11000 }),
    loc({ mocked: true }),
    loc({ latitude: 26.9132, accuracy: 30 }),
  ])
    assert.throws(() => checkLocation(value, site));
});
test("attendance API enforces roles, assignment, same-site punch-out, sessions and reports", async (t) => {
  const db = openDatabase(":memory:");
  createAdmin(db, {
    name: "Admin",
    email: "admin@example.test",
    password: "Admin-password-123",
  });
  const { server } = createApp({ db });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections();
      }),
  );
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(path, body, token, method = "POST") {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
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
  let session = (
    await request("/login", {
      email: "employee@example.test",
      password: "Temporary-pass-123",
      native: true,
    })
  ).data.token;
  assert.equal(
    (await request("/punch", { action: "in", location: loc() }, session))
      .status,
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
    (await request("/punch", { action: "out", location: loc() }, session))
      .status,
    409,
  );
  assert.equal(
    (
      await request(
        "/punch",
        { action: "in", location: loc({ latitude: 28, longitude: 77 }) },
        session,
      )
    ).status,
    422,
  );
  const punches = await Promise.all([
    request("/punch", { action: "in", location: loc() }, session),
    request("/punch", { action: "in", location: loc() }, session),
  ]);
  assert.deepEqual(punches.map((p) => p.status).sort(), [200, 409]);
  assert.equal(
    (
      await request(
        `/admin/employees/${employee}`,
        { active: true, workplace_id: other },
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
        { active: false, workplace_id: office },
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
        { action: "out", location: loc({ latitude: 28, longitude: 77 }) },
        session,
      )
    ).status,
    422,
  );
  // A direct database assignment change still cannot redirect an open shift's punch-out.
  db.prepare("UPDATE users SET workplace_id=? WHERE id=?").run(other, employee);
  assert.equal(
    (
      await request(
        "/punch",
        { action: "out", location: loc({ latitude: 28, longitude: 77 }) },
        session,
      )
    ).status,
    422,
  );
  assert.equal(
    (await request("/punch", { action: "out", location: loc() }, session))
      .status,
    200,
  );
  assert.equal(
    (await request("/punch", { action: "out", location: loc() }, session))
      .status,
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
        { active: false, workplace_id: other },
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
