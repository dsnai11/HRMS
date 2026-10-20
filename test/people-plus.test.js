import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  let nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
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
  const call = async (path, body, token, method = "POST") => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
    };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
      .padEnd(16, "0")
      .slice(0, 64);
    const r = await call("/login", {
      email,
      password,
      native: true,
      device: { id, platform: "android", model: "T", secret: secrets.get(id) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (
    await call(
      "/admin/workplaces",
      {
        name: "Office",
        latitude: 26.9,
        longitude: 75.8,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email: `${key}@example.test`,
        password: PW,
        workplace_id: site,
        date_of_joining: "2026-01-01",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("pay", { role: "payroll" });
  await add("mgr");
  await add("emp");
  return {
    db,
    call,
    owner,
    people,
    site,
    add,
    signIn,
    app,
    setNow: (iso) => (nowMs = Date.parse(iso)),
  };
}

test("grades, cost centres, business units, custom fields, org chart, labels and the 360 profile", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token;
  await db
    .prepare("UPDATE users SET manager_id=? WHERE id=?")
    .run(people.mgr.id, people.emp.id);

  // Org structure: new kinds work like departments, and bands are checked.
  assert.equal(
    (await call("/admin/grades", { name: "G1" }, people.emp.token)).status,
    403,
  );
  const g = await call(
    "/admin/grades",
    { name: "Grade 5", level: 5, salary_min: 400000, salary_max: 700000 },
    hr,
  );
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(
    (
      await call(
        `/admin/grades/${g.data.id}`,
        { salary_min: 900000 },
        hr,
        "PATCH",
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/admin/grades", { name: "Bad", salary_min: "abc" }, hr))
      .status,
    400,
  );
  const cc = (
    await call("/admin/cost_centres", { name: "Branch ops", code: "CC10" }, hr)
  ).data.id;
  const bu = (
    await call(
      "/admin/business_units",
      { name: "Retail lending", code: "RL" },
      hr,
    )
  ).data.id;
  const org = (await call("/admin/org", undefined, hr)).data;
  assert.equal(org.grades[0].name, "Grade 5");
  assert.equal(org.cost_centres[0].name, "Branch ops");
  assert.equal(org.business_units[0].name, "Retail lending");

  // Custom fields.
  const f1 = await call(
    "/admin/custom-fields",
    { label: "Project code", type: "text", required: true },
    hr,
  );
  assert.equal(f1.data.key, "project_code");
  assert.equal(
    (await call("/admin/custom-fields", { label: "Project code" }, hr)).status,
    409,
  );
  assert.equal(
    (
      await call(
        "/admin/custom-fields",
        { label: "Site", type: "select", options: "Only one" },
        hr,
      )
    ).status,
    400,
  );
  const f2 = await call(
    "/admin/custom-fields",
    {
      label: "Mobilisation status",
      type: "select",
      options: "Mobilised, Pending, On hold",
    },
    hr,
  );
  assert.equal(f2.status, 201);
  await call(
    "/admin/custom-fields",
    { label: "Passport expiry", type: "date" },
    hr,
  );
  assert.equal(
    (await call("/admin/custom-fields", { label: "x" }, people.emp.token))
      .status,
    403,
  );
  assert.equal(
    (await call("/custom-fields", undefined, people.emp.token)).data.length,
    3,
  );

  const mk = (extra) =>
    call(
      "/admin/employees",
      {
        name: "Nina Rao",
        email: "nina@example.test",
        password: PW,
        workplace_id: w.site,
        grade_id: g.data.id,
        cost_centre_id: cc,
        business_unit_id: bu,
        ...extra,
      },
      hr,
    );
  assert.equal(
    (await mk({ custom: { mobilisation_status: "Mobilised" } })).status,
    400,
  ); // project code required
  assert.equal(
    (await mk({ custom: { project_code: "P-1", mobilisation_status: "Nope" } }))
      .status,
    400,
  );
  assert.equal(
    (
      await mk({
        custom: { project_code: "P-1", passport_expiry: "31-12-2030" },
      })
    ).status,
    400,
  );
  const nina = await mk({
    custom: {
      project_code: "P-1",
      mobilisation_status: "Pending",
      passport_expiry: "2030-12-31",
    },
  });
  assert.equal(nina.status, 201, JSON.stringify(nina.data));
  const rec = (await call(`/admin/employees/${nina.data.id}`, undefined, hr))
    .data;
  assert.deepEqual(
    [rec.grade_name, rec.cost_centre_name, rec.business_unit_name],
    ["Grade 5", "Branch ops", "Retail lending"],
  );
  assert.deepEqual(JSON.parse(rec.custom), {
    project_code: "P-1",
    mobilisation_status: "Pending",
    passport_expiry: "2030-12-31",
  });
  await call(
    `/admin/employees/${nina.data.id}`,
    { custom: { mobilisation_status: "Mobilised", passport_expiry: "" } },
    hr,
    "PATCH",
  );
  assert.deepEqual(
    JSON.parse(
      (await call(`/admin/employees/${nina.data.id}`, undefined, hr)).data
        .custom,
    ),
    { project_code: "P-1", mobilisation_status: "Mobilised" },
  );

  // Org chart: everyone can see names and reporting lines, never contact details.
  const chart = (await call("/org-chart", undefined, people.emp.token)).data;
  assert.equal(chart.me, people.emp.id);
  const emp = chart.people.find((p) => p.id === people.emp.id);
  assert.equal(emp.manager_id, people.mgr.id);
  assert.equal(
    chart.people.some((p) => p.name === "Owner"),
    false,
  );
  assert.equal(JSON.stringify(chart).includes("@"), false);

  // Renaming terms.
  const put = await call(
    "/admin/labels",
    { labels: { Department: "Discipline", "bad<key>": "x", Branch: "Region" } },
    hr,
    "PUT",
  );
  assert.deepEqual(put.data.labels, {
    Department: "Discipline",
    Branch: "Region",
  });
  assert.deepEqual(
    (await call("/me", undefined, people.emp.token)).data.company.labels,
    { Department: "Discipline", Branch: "Region" },
  );
  assert.equal(
    (await call("/admin/labels", { labels: {} }, people.emp.token, "PUT"))
      .status,
    403,
  );

  // 360 profile: people add their own entries; HR verifies; verified entries are locked.
  const edu = await call(
    "/profile360/education",
    { degree: "B.Com", institute: "Rajasthan University", year: "2016" },
    people.emp.token,
  );
  assert.equal(edu.status, 201, JSON.stringify(edu.data));
  assert.equal(
    (
      await call(
        "/profile360/skills",
        { skill: "KYC", level: "expert" },
        people.emp.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (await call("/profile360/skills", { skill: "kyc" }, people.emp.token))
      .status,
    409,
  );
  assert.equal(
    (
      await call(
        "/profile360/certifications",
        {
          name: "NISM",
          issuer: "NISM",
          issued_on: "2024-01-10",
          expires_on: "2027-01-09",
        },
        people.emp.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "/profile360/experience",
        {
          employer: "ABC Finance",
          role: "Clerk",
          from_date: "2018-01",
          to_date: "2022-03",
        },
        people.emp.token,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await call(
        "/profile360/education",
        { degree: "x", user_id: people.mgr.id },
        people.emp.token,
      )
    ).status,
    403,
  );
  const mine = (await call("/profile360", undefined, people.emp.token)).data;
  assert.equal(mine.education[0].verified_at, null);
  assert.equal(mine.skills[0].skill, "KYC");
  // The manager and HR can see it; a colleague cannot.
  assert.equal(
    (
      await call(
        `/profile360?user_id=${people.emp.id}`,
        undefined,
        people.mgr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/profile360?user_id=${people.emp.id}`,
        undefined,
        people.pay.token,
      )
    ).status,
    200,
  ); // payroll has employees.read
  const other = await call(
    "/admin/employees",
    {
      name: "Zed",
      email: "zed@example.test",
      password: PW,
      workplace_id: w.site,
    },
    hr,
  );
  await db
    .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
    .run(other.data.id);
  const zedToken = await w.signIn("zed@example.test");
  assert.equal(
    (await call(`/profile360?user_id=${people.emp.id}`, undefined, zedToken))
      .status,
    403,
  );
  // Verification is HR's.
  assert.equal(
    (
      await call(
        `/profile360/education/${edu.data.id}/verify`,
        {},
        people.emp.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(`/profile360/education/${edu.data.id}/verify`, {}, hr)).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/profile360/education/${edu.data.id}`,
        undefined,
        people.emp.token,
        "DELETE",
      )
    ).status,
    403,
  );
  const exp = (await call("/profile360", undefined, people.emp.token)).data
    .experience[0];
  assert.equal(
    (
      await call(
        `/profile360/experience/${exp.id}`,
        undefined,
        people.emp.token,
        "DELETE",
      )
    ).status,
    200,
  );
  // HR's own entries are verified at once.
  const hrAdded = await call(
    "/profile360/education",
    { degree: "MBA", user_id: people.emp.id },
    hr,
  );
  assert.equal(hrAdded.status, 201);
  const after = (await call("/profile360", undefined, people.emp.token)).data;
  assert.equal(after.education.length, 2);
  assert.ok(after.education.every((e) => e.verified_at));
  assert.equal(
    (await call(`/profile360/skills/${after.skills[0].id}/verify`, {}, hr))
      .status,
    409,
  );
});
