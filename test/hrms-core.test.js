import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openPglite } from "../server/pglite.js";
import {
  createAdmin,
  ensureDefaultCompany,
  backfillEmployeeCodes,
  passwordHash,
} from "../server/db.js";
import { createApp } from "../server/index.js";
import { clientIp } from "../server/http.js";

async function start(t, db) {
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
  const call = async (
    path,
    body,
    token,
    { method = "POST", headers = {} } = {},
  ) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json().catch(() => null) };
  };
  return call;
}
const PW = "Temporary-pass-123";
const secrets = new Map();
async function signIn(call, email, password = PW) {
  // A stable fake phone per account, as the mobile app would send; it keeps its key.
  const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
    .padEnd(16, "0")
    .slice(0, 64);
  const r = await call("/login", {
    email,
    password,
    native: true,
    device: { id, platform: "android", model: "Test", secret: secrets.get(id) },
  });
  assert.equal(r.status, 200, `login ${email}: ${JSON.stringify(r.data)}`);
  if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
  return r.data.token;
}

test("an existing single-company database upgrades and keeps working", async (t) => {
  const baseline = await readFile(
    new URL("../server/migrations/001_baseline.sql", import.meta.url),
    "utf8",
  );
  const db = await openPglite(undefined, {
    beforeMigrate: async (engine) => {
      await engine.exec(baseline);
      await engine.query(
        "INSERT INTO workplaces(name,latitude,longitude,radius,max_accuracy) VALUES($1,0,0,100,20)",
        ["Old office"],
      );
      for (const [name, email, role] of [
        ["Old Admin", "old-admin@example.test", "admin"],
        ["Old Staff", "old-staff@example.test", "employee"],
      ])
        await engine.query(
          "INSERT INTO users(name,email,password_hash,role,workplace_id,created_at) VALUES($1,$2,$3,$4,1,$5)",
          [
            name,
            email,
            passwordHash("Old-password-123"),
            role,
            new Date().toISOString(),
          ],
        );
      await engine.query(
        "INSERT INTO audit(actor_id,action,detail,created_at) VALUES(1,'login','{}',$1)",
        [new Date().toISOString()],
      );
    },
  });
  await ensureDefaultCompany(db, "Legacy Co");
  await backfillEmployeeCodes(db);
  assert.deepEqual(
    (await db.prepare("SELECT employee_code FROM users ORDER BY id").all()).map(
      (r) => r.employee_code,
    ),
    ["E0001", "E0002"],
  );
  const companies = await db.prepare("SELECT * FROM companies").all();
  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, "Legacy Co");
  for (const table of ["users", "workplaces", "audit"])
    assert.equal(
      (
        await db
          .prepare(`SELECT COUNT(*) n FROM ${table} WHERE company_id IS NULL`)
          .get()
      ).n,
      0,
    );
  assert.equal(
    (
      await db
        .prepare("SELECT role FROM users WHERE email='old-admin@example.test'")
        .get()
    ).role,
    "super_admin",
  );
  const call = await start(t, db);
  const admin = await signIn(
    call,
    "old-admin@example.test",
    "Old-password-123",
  );
  assert.equal(
    (await call("/admin/employees", undefined, admin)).data.total,
    2,
  );
  assert.equal(
    (await call("/admin/workplaces", undefined, admin)).data[0].name,
    "Old office",
  );
});

test("companies are isolated, roles are enforced, and org data is validated", async (t) => {
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const call = await start(t, db);
  const owner = await signIn(call, "owner@example.test", "Owner-password-123");

  // The platform owner creates a second company and works inside it by naming it.
  const beta = (
    await call("/admin/companies", { name: "Beta Ltd", code: "beta" }, owner)
  ).data.id;
  assert.ok(beta);
  assert.equal(
    (await call("/admin/companies", { name: "Dup", code: "BETA" }, owner))
      .status,
    409,
  );
  assert.equal(
    (await call("/admin/companies", { name: "Bad", code: "!" }, owner)).status,
    400,
  );
  const inBeta = { headers: { "X-Company-Id": String(beta) } };
  const betaStaff = (
    await call(
      "/admin/employees",
      { name: "Beta Person", email: "beta@example.test", password: PW },
      owner,
      inBeta,
    )
  ).data.id;
  assert.equal(
    (
      await call(
        "/admin/employees",
        { name: "x", email: "x@example.test", password: PW },
        owner,
        { headers: { "X-Company-Id": "999999" } },
      )
    ).status,
    400,
  );
  const betaDept = (
    await call("/admin/departments", { name: "Ops" }, owner, inBeta)
  ).data.id;

  // Company A: an admin, an HR user and employees.
  const mk = async (body, token = owner) => {
    const r = await call("/admin/employees", { password: PW, ...body }, token);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.id;
  };
  const alphaAdmin = await mk({
    name: "Alpha Admin",
    email: "aadmin@example.test",
    role: "admin",
  });
  const hrId = await mk({
    name: "Hema HR",
    email: "hr@example.test",
    role: "hr",
  });
  const admin = await signIn(call, "aadmin@example.test");
  // Temporary passwords must be changed before anything else works.
  assert.equal((await call("/admin/employees", undefined, admin)).status, 403);
  assert.equal(
    (
      await call(
        "/password",
        { currentPassword: PW, newPassword: "Admin-new-password-1" },
        admin,
      )
    ).status,
    200,
  );
  const adminT = await signIn(
    call,
    "aadmin@example.test",
    "Admin-new-password-1",
  );
  await db
    .prepare(
      "UPDATE users SET must_change_password=0 WHERE company_id=(SELECT id FROM companies WHERE code='MAIN')",
    )
    .run();
  const hr = await signIn(call, "hr@example.test");

  // Isolation: neither the company's admin nor the X-Company-Id header crosses companies.
  const list = (await call("/admin/employees", undefined, adminT, inBeta)).data;
  assert.ok(list.items.every((e) => e.email !== "beta@example.test"));
  assert.equal(
    (await call(`/admin/employees/${betaStaff}`, undefined, adminT)).status,
    404,
  );
  assert.equal(
    (
      await call(`/admin/employees/${betaStaff}`, { name: "Hijack" }, adminT, {
        method: "PATCH",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await call(
        "/admin/employees",
        {
          name: "Z",
          email: "z@example.test",
          password: PW,
          department_id: betaDept,
        },
        adminT,
      )
    ).status,
    400,
  );
  assert.equal((await call("/admin/companies", undefined, adminT)).status, 403);
  assert.equal(
    (await call("/admin/departments", undefined, adminT, inBeta)).data.length,
    0,
  );
  const betaList = (await call("/admin/employees", undefined, owner, inBeta))
    .data;
  assert.deepEqual(
    betaList.items.map((e) => e.email),
    ["beta@example.test"],
  );

  // Role limits.
  assert.equal(
    (
      await call(
        "/admin/employees",
        {
          name: "S",
          email: "s@example.test",
          password: PW,
          role: "super_admin",
        },
        adminT,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/employees",
        { name: "H", email: "h2@example.test", password: PW, role: "hr" },
        hr,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/employees",
        { name: "Staff", email: "staff@example.test", password: PW },
        hr,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(`/admin/employees/${alphaAdmin}`, { name: "Renamed" }, hr, {
        method: "PATCH",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(`/admin/employees/${hrId}`, { role: "admin" }, hr, {
        method: "PATCH",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/workplaces",
        { name: "W", latitude: 1, longitude: 1, radius: 100, max_accuracy: 20 },
        hr,
      )
    ).status,
    403,
  );
  assert.equal((await call("/admin/audit", undefined, hr)).status, 403);
  assert.equal(
    (await call("/admin/security-events", undefined, hr)).status,
    200,
  );
  assert.equal((await call("/admin/audit", undefined, adminT)).status, 200);
  assert.equal(
    (
      await call(`/admin/employees/${alphaAdmin}`, { active: false }, adminT, {
        method: "PATCH",
      })
    ).status,
    409,
    "no self-deactivation",
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${alphaAdmin}`,
        { role: "employee" },
        adminT,
        { method: "PATCH" },
      )
    ).status,
    409,
    "no self-demotion",
  );

  // Org structure: names are unique per company ignoring case; inactive items stay listed.
  const dept = (
    await call("/admin/departments", { name: "Finance", code: "FIN" }, hr)
  ).data.id;
  assert.equal(
    (await call("/admin/departments", { name: "finance" }, hr)).status,
    409,
  );
  assert.equal(
    (await call("/admin/departments", { name: "Finance" }, owner, inBeta))
      .status,
    201,
    "same name in another company is fine",
  );
  const desig = (await call("/admin/designations", { name: "Analyst" }, hr))
    .data.id;
  const branch = (
    await call(
      "/admin/branches",
      { name: "Jaipur", city: "Jaipur", state: "Rajasthan" },
      hr,
    )
  ).data.id;
  assert.equal(
    (
      await call(`/admin/branches/${branch}`, { active: "no" }, hr, {
        method: "PATCH",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/admin/branches/${branch}`, { city: "Jaipur City" }, hr, {
        method: "PATCH",
      })
    ).status,
    200,
  );
  const org = (await call("/admin/org", undefined, hr)).data;
  assert.deepEqual(
    org.departments.map((d) => d.name),
    ["Finance"],
  );

  // Employees: profile fields, auto codes, validation.
  const e1 = await mk(
    {
      name: "Ravi",
      email: "ravi@example.test",
      department_id: dept,
      designation_id: desig,
      branch_id: branch,
      phone: "+91 98765 43210",
      gender: "male",
      date_of_joining: "2026-04-01",
      date_of_birth: "1990-05-17",
      employment_type: "full_time",
      emergency_name: "Sita",
      emergency_phone: "9876500000",
      emergency_relation: "Spouse",
    },
    adminT,
  );
  const e2 = await mk(
    { name: "Meera", email: "meera@example.test", department_id: dept },
    adminT,
  );
  const e3 = await mk({ name: "Kabir", email: "kabir@example.test" }, adminT);
  const codes = (
    await call("/admin/employees?limit=200", undefined, adminT)
  ).data.items.map((e) => e.employee_code);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.every((c) => /^E\d{4}$/.test(c)));
  const full = (await call(`/admin/employees/${e1}`, undefined, adminT)).data;
  assert.equal(full.department_name, "Finance");
  assert.equal(full.emergency_relation, "Spouse");
  assert.equal(full.date_of_birth, "1990-05-17");
  for (const bad of [
    { phone: "abc" },
    { gender: "x" },
    { date_of_joining: "2026-02-30" },
    { employment_type: "slave" },
  ])
    assert.equal(
      (
        await call(
          "/admin/employees",
          {
            name: "B",
            email: `b${Math.random()}@example.test`,
            password: PW,
            ...bad,
          },
          adminT,
        )
      ).status,
      400,
    );
  assert.equal(
    (
      await call(
        "/admin/employees",
        {
          name: "Dup",
          email: "dup@example.test",
          password: PW,
          employee_code: full.employee_code,
        },
        adminT,
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/employees",
        { name: "Dup", email: "ravi@example.test", password: PW },
        adminT,
      )
    ).status,
    409,
  );
  const found = (await call("/admin/employees?q=mee", undefined, adminT)).data;
  assert.deepEqual(
    found.items.map((e) => e.name),
    ["Meera"],
  );
  const byDept = (
    await call(`/admin/employees?department_id=${dept}`, undefined, adminT)
  ).data;
  assert.deepEqual(byDept.items.map((e) => e.name).sort(), ["Meera", "Ravi"]);
  const page = (
    await call("/admin/employees?limit=2&offset=1", undefined, adminT)
  ).data;
  assert.equal(page.items.length, 2);
  assert.ok(page.total >= 5);

  // Reporting lines: managers are derived, cycles and orphaned reports are refused.
  assert.equal(
    (
      await call(`/admin/employees/${e2}`, { manager_id: e1 }, adminT, {
        method: "PATCH",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/admin/employees/${e3}`, { manager_id: e2 }, adminT, {
        method: "PATCH",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call(`/admin/employees/${e1}`, { manager_id: e3 }, adminT, {
        method: "PATCH",
      })
    ).status,
    400,
    "circular",
  );
  assert.equal(
    (
      await call(`/admin/employees/${e1}`, { manager_id: e1 }, adminT, {
        method: "PATCH",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call(`/admin/employees/${e3}`, { manager_id: betaStaff }, adminT, {
        method: "PATCH",
      })
    ).status,
    400,
  );
  // Deactivating someone with a team now hands the team to their manager
  // (see roles.test.js), so it is not exercised here.
  const ravi = await signIn(call, "ravi@example.test");
  await db
    .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
    .run(e1);
  const me = (await call("/me", undefined, ravi)).data;
  assert.equal(me.is_manager, true);
  assert.deepEqual(me.permissions, []);
  assert.equal(me.company.name, "Alpha Ltd");
  const team = (await call("/team/members", undefined, ravi)).data;
  assert.deepEqual(team.map((m) => [m.name, m.direct]).sort(), [
    ["Kabir", false],
    ["Meera", true],
  ]);
  assert.equal((await call("/team/attendance", undefined, ravi)).status, 200);
  const kabir = await signIn(call, "kabir@example.test");
  await db
    .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
    .run(e3);
  assert.equal((await call("/team/members", undefined, kabir)).status, 403);
  assert.equal((await call("/admin/employees", undefined, ravi)).status, 403);

  // Self-service: contact details only.
  assert.equal(
    (
      await call(
        "/profile",
        { phone: "9999999999", address: "12 MG Road" },
        ravi,
        { method: "PATCH" },
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/profile", { name: "Hacker", role: "admin" }, ravi, {
        method: "PATCH",
      })
    ).status,
    400,
  );
  const mine = (await call("/profile", undefined, ravi)).data;
  assert.equal(mine.phone, "9999999999");
  assert.equal(mine.name, "Ravi");
  assert.equal(mine.role, "employee");

  // Deactivating a company ends its sessions and blocks sign-in.
  assert.equal(
    (
      await call(`/admin/companies/${beta}`, { active: false }, owner, {
        method: "PATCH",
      })
    ).status,
    200,
  );
  assert.equal(
    (await call("/login", { email: "beta@example.test", password: PW })).status,
    401,
  );
  assert.equal(
    (
      await call(
        `/admin/companies/${(await call("/me", undefined, owner)).data.company.id}`,
        { active: false },
        owner,
        { method: "PATCH" },
      )
    ).status,
    409,
  );
});

test("rate limiting sees the real client behind a trusted proxy and ignores spoofed headers", () => {
  const req = (xff) => ({
    headers: xff ? { "x-forwarded-for": xff } : {},
    socket: { remoteAddress: "10.0.0.1" },
  });
  assert.equal(
    clientIp(req("1.2.3.4"), {}),
    "10.0.0.1",
    "not behind a proxy: header ignored",
  );
  assert.equal(clientIp(req("1.2.3.4"), { RENDER: "true" }), "1.2.3.4");
  // A client-supplied first entry is not trusted; the proxy appended the last one.
  assert.equal(
    clientIp(req("6.6.6.6, 1.2.3.4"), { RENDER: "true" }),
    "1.2.3.4",
  );
  assert.equal(
    clientIp(req("1.2.3.4, 5.5.5.5"), { TRUST_PROXY_HOPS: "2" }),
    "1.2.3.4",
  );
  assert.equal(clientIp(req(), { RENDER: "true" }), "10.0.0.1");
});
