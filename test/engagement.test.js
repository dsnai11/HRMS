import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  const nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const { server } = createApp({ db, clock: () => nowMs });
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
  return { db, call, owner, people, site, add, signIn };
}

test("announcements, helpdesk, policies and notifications work together", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    emp = people.emp.token;

  // Announcements reach the right people and notify them.
  const org = (await call("/admin/branches", { name: "Jaipur" }, w.owner)).data
    .id;
  await db
    .prepare("UPDATE users SET branch_id=? WHERE id=?")
    .run(org, people.emp.id);
  assert.equal(
    (await call("/admin/announcements", { title: "x", body: "y" }, emp)).status,
    403,
  );
  const all = await call(
    "/admin/announcements",
    { title: "Diwali holiday", body: "Office closed on Friday.", pinned: true },
    hr,
  );
  assert.equal(all.status, 201, JSON.stringify(all.data));
  const branchOnly = await call(
    "/admin/announcements",
    { title: "Jaipur parking", body: "New rules", branch_id: org },
    hr,
  );
  assert.equal(branchOnly.status, 201);
  assert.deepEqual(
    (await call("/announcements", undefined, emp)).data.map((a) => a.title),
    ["Diwali holiday", "Jaipur parking"],
  );
  assert.deepEqual(
    (await call("/announcements", undefined, people.mgr.token)).data.map(
      (a) => a.title,
    ),
    ["Diwali holiday"],
    "not in that branch",
  );
  const inbox = (await call("/notifications", undefined, emp)).data;
  assert.equal(inbox.unread, 2);
  assert.equal(
    (await call("/notifications/read", { id: inbox.items[0].id }, emp)).status,
    200,
  );
  assert.equal((await call("/notifications", undefined, emp)).data.unread, 1);
  assert.equal((await call("/notifications/read", {}, emp)).status, 200);
  assert.equal((await call("/notifications", undefined, emp)).data.unread, 0);
  assert.equal(
    (await call(`/admin/announcements/${all.data.id}`, undefined, hr, "DELETE"))
      .status,
    200,
  );
  assert.equal((await call("/announcements", undefined, emp)).data.length, 1);

  // Decisions elsewhere notify the person, through the audit trail: a resignation decision.
  await call("/notifications/read", {}, emp);
  assert.equal(
    (await call("/exit/resign", { reason: "Moving" }, emp)).status,
    201,
  );
  const exitId = (await call("/admin/exits?status=pending", undefined, hr))
    .data[0].id;
  assert.equal(
    (
      await call(
        `/admin/exits/${exitId}/decide`,
        { decision: "accepted", last_working_day: "2026-12-05" },
        hr,
      )
    ).status,
    200,
  );
  assert.match(
    (await call("/notifications", undefined, emp)).data.items[0].title,
    /resignation was accepted.*2026-12-05/,
  );
  assert.equal(
    (await call(`/admin/exits/${exitId}/cancel`, {}, hr)).status,
    200,
  );

  // Helpdesk: employee opens, HR replies privately and publicly, the employee sees only the public reply.
  const tk = await call(
    "/tickets",
    {
      category: "payroll",
      subject: "Wrong PF amount",
      body: "Please check September.",
    },
    emp,
  );
  assert.equal(tk.status, 201, JSON.stringify(tk.data));
  assert.equal((await call("/admin/tickets", undefined, emp)).status, 403);
  assert.deepEqual(
    (await call("/admin/tickets", undefined, hr)).data.map((x) => x.subject),
    ["Wrong PF amount"],
  );
  assert.equal(
    (
      await call(
        `/tickets/${tk.data.id}/reply`,
        { body: "Checking with payroll", internal: true },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/tickets/${tk.data.id}/reply`,
        { body: "It is fixed in October." },
        hr,
      )
    ).status,
    200,
  );
  const seen = (await call(`/tickets/${tk.data.id}`, undefined, emp)).data;
  assert.deepEqual(
    seen.messages.map((m) => m.body),
    ["Please check September.", "It is fixed in October."],
  );
  assert.equal(seen.status, "in_progress");
  assert.equal(
    (await call(`/tickets/${tk.data.id}`, undefined, people.mgr.token)).status,
    404,
    "someone else's ticket",
  );
  assert.equal(
    (
      await call(
        `/admin/tickets/${tk.data.id}`,
        { status: "resolved" },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.match(
    (await call("/notifications", undefined, emp)).data.items[0].title,
    /resolved/,
  );
  assert.equal(
    (
      await call(
        `/tickets/${tk.data.id}/reply`,
        { body: "Thanks, one more thing" },
        emp,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/tickets/${tk.data.id}`, undefined, emp)).data.status,
    "open",
    "an employee reply reopens it",
  );

  // Policies: a new version has to be acknowledged again.
  const pol = await call(
    "/admin/policies",
    { title: "Code of conduct", body: "Be kind." },
    hr,
  );
  assert.equal(pol.status, 201);
  assert.equal(
    (await call(`/admin/policies/${pol.data.id}/pending`, undefined, hr)).data
      .length,
    4,
  );
  assert.equal(
    (await call(`/policies/${pol.data.id}/acknowledge`, {}, emp)).status,
    200,
  );
  assert.equal(
    (await call(`/policies/${pol.data.id}/acknowledge`, {}, emp)).status,
    200,
    "idempotent",
  );
  assert.equal(
    (await call("/policies", undefined, emp)).data[0].acknowledged_at !== null,
    true,
  );
  assert.equal(
    (await call("/admin/policies", undefined, hr)).data[0].acknowledged,
    1,
  );
  assert.equal(
    (
      await call(
        `/admin/policies/${pol.data.id}`,
        { body: "Be kind and honest." },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/policies", undefined, emp)).data[0].acknowledged_at,
    null,
    "version 2 is new to them",
  );
  assert.equal(
    (await call("/admin/policies", undefined, hr)).data[0].acknowledged,
    0,
  );
  assert.equal((await call("/admin/policies", undefined, emp)).status, 403);
});

test("insights summarise headcount, movement and attendance", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  assert.equal(
    (await call("/admin/insights", undefined, people.emp.token)).status,
    403,
  );
  assert.equal(
    (await call("/admin/insights", undefined, people.pay.token)).status,
    403,
  );
  await db.prepare("UPDATE users SET employment_type='full_time'").run();
  const hrView = (await call("/admin/insights", undefined, people.hr.token))
    .data;
  assert.equal(hrView.headcount.total, 4);
  assert.deepEqual(hrView.headcount.by_type, [{ name: "full_time", n: 4 }]);
  assert.equal(hrView.movement.months.length, 12);
  assert.equal(
    hrView.movement.joiners_12m,
    4,
    "everyone joined 2026-01-01, inside the last 12 months",
  );
  assert.equal(hrView.payroll, undefined, "HR does not see payroll cost");
  assert.equal(hrView.attendance.series.length, 14);
  // The admin also sees payroll cost.
  await w.add("boss", { role: "admin" });
  assert.deepEqual(
    (await call("/admin/insights", undefined, people.boss.token)).data.payroll,
    [],
  );
});

test("phone push goes through Firebase to a person's registered phones", async (t) => {
  const { generateKeyPairSync, createVerify } = await import("node:crypto");
  const { createPush } = await import("../server/push.js");
  const w = await (async () => {
    const db = await openPglite();
    await createAdmin(db, {
      name: "Owner",
      email: "owner@example.test",
      password: "Owner-password-123",
      companyName: "Alpha Ltd",
    });
    t.after(() => db.close());
    return { db };
  })();
  const { db } = w;
  const co = (await db.prepare("SELECT id FROM companies").get()).id;
  const mk = async (n) =>
    Number(
      (
        await db
          .prepare(
            "INSERT INTO users(name,email,password_hash,role,company_id,created_at) VALUES(?,?,?,?,?,?)",
          )
          .run(
            n,
            `${n}@x.test`,
            "x:y",
            "employee",
            co,
            new Date().toISOString(),
          )
      ).lastInsertRowid,
    );
  const [a, b] = [await mk("a"), await mk("b")];
  await db
    .prepare(
      "INSERT INTO push_tokens(user_id,token,platform,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(a, "tok-a1", "android", "x", "x");
  await db
    .prepare(
      "INSERT INTO push_tokens(user_id,token,platform,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(a, "tok-a2", "android", "x", "x");
  await db
    .prepare(
      "INSERT INTO push_tokens(user_id,token,platform,created_at,updated_at) VALUES(?,?,?,?,?)",
    )
    .run(b, "tok-b", "android", "x", "x");

  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("oauth2"))
      return new Response(
        JSON.stringify({ access_token: "ACCESS", expires_in: 3600 }),
        { status: 200 },
      );
    const message = JSON.parse(init.body).message;
    if (message.token === "tok-a2")
      return new Response(
        JSON.stringify({ error: { status: "UNREGISTERED" } }),
        { status: 404 },
      );
    return new Response("{}", { status: 200 });
  };
  const env = {
    FCM_SERVICE_ACCOUNT: JSON.stringify({
      client_email: "svc@proj.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      project_id: "hrms-proj",
    }),
  };
  const push = createPush({ db }, env, fake);
  assert.equal(
    await push([a], {
      title: "Your leave request was approved",
      link: "timeoff",
    }),
    1,
    "one of two phones accepted it",
  );
  // The sign-in to Google carries a correctly signed token.
  const assertion = calls[0].init.body.get("assertion");
  const [h, c, sig] = assertion.split(".");
  assert.ok(
    createVerify("RSA-SHA256")
      .update(`${h}.${c}`)
      .verify(publicKey, sig, "base64url"),
  );
  assert.equal(
    JSON.parse(Buffer.from(c, "base64url")).iss,
    "svc@proj.iam.gserviceaccount.com",
  );
  const sent = calls.filter((x) => x.url.includes("fcm.googleapis.com"));
  assert.equal(
    sent[0].url,
    "https://fcm.googleapis.com/v1/projects/hrms-proj/messages:send",
  );
  assert.equal(sent[0].init.headers.Authorization, "Bearer ACCESS");
  assert.deepEqual(JSON.parse(sent[0].init.body).message.notification, {
    title: "Your leave request was approved",
  });
  // The unregistered phone was forgotten; the Google token is reused.
  assert.deepEqual(
    (
      await db.prepare("SELECT token FROM push_tokens ORDER BY token").all()
    ).map((r) => r.token),
    ["tok-a1", "tok-b"],
  );
  await push([b], { title: "Hi" });
  assert.equal(
    calls.filter((x) => x.url.includes("oauth2")).length,
    1,
    "one sign-in serves later sends",
  );
  // Without the setting, nothing is sent.
  const off = createPush({ db }, {}, fake);
  assert.equal(await off([a], { title: "x" }), 0);
  assert.equal(
    await createPush(
      { db },
      { FCM_SERVICE_ACCOUNT: "not json" },
      fake,
    )([a], { title: "x" }),
    0,
  );
});

test("phones register and unregister their push token", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  assert.equal(
    (
      await call(
        "/push/register",
        { token: "short-token-1", platform: "android" },
        people.emp.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/push/register",
        { token: "short-token-1", platform: "android" },
        people.emp.token,
      )
    ).status,
    200,
    "idempotent",
  );
  assert.equal(
    (
      await call(
        "/push/register",
        { token: "x", platform: "windows" },
        people.emp.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM push_tokens").get()).n,
    1,
  );
  // The same phone signed in by someone else takes the token over.
  assert.equal(
    (
      await call(
        "/push/register",
        { token: "short-token-1", platform: "android" },
        people.mgr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await db.prepare("SELECT user_id FROM push_tokens").get()).user_id,
    people.mgr.id,
  );
  assert.equal(
    (
      await call(
        "/push/unregister",
        { token: "short-token-1" },
        people.emp.token,
      )
    ).status,
    200,
    "not theirs now: nothing removed",
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM push_tokens").get()).n,
    1,
  );
  assert.equal(
    (
      await call(
        "/push/unregister",
        { token: "short-token-1" },
        people.mgr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM push_tokens").get()).n,
    0,
  );
});
