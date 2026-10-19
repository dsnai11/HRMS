import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { createHash } from "node:crypto";

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
  return {
    db,
    call,
    owner,
    people,
    site,
    add,
    signIn,
    base,
    clockTo: (iso) => (nowMs = Date.parse(iso)),
  };
}

const sha = (s) => createHash("sha256").update(s).digest("hex");

test("directory, referrals and career changes", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    emp = people.emp.token,
    pay = people.pay.token;
  await w.add("boss", { role: "admin" });
  const org = (await call("/admin/org", undefined, hr)).data;
  void org;
  const d1 = (await call("/admin/departments", { name: "Operations" }, hr)).data
    .id;
  const g1 = (await call("/admin/designations", { name: "Manager" }, hr)).data
    .id;
  const g0 = (await call("/admin/designations", { name: "Executive" }, hr)).data
    .id;
  await db
    .prepare("UPDATE users SET designation_id=?,department_id=? WHERE id=?")
    .run(g0, d1, people.emp.id);

  // Directory shows colleagues, searchable, without super admin.
  const all = (await call("/directory", undefined, emp)).data;
  assert.equal(all.length, 5);
  assert.deepEqual(
    (await call("/directory?q=executive", undefined, emp)).data.map(
      (p) => p.name,
    ),
    ["EMP"],
  );
  assert.equal(
    all.some((p) => p.name === "Owner"),
    false,
  );

  // Referral: becomes a candidate with its source, HR is told, duplicates are refused.
  const opening = (await call("/admin/openings", { title: "Clerk" }, hr)).data
    .id;
  assert.deepEqual(
    (await call("/openings/open", undefined, emp)).data.map((o) => o.title),
    ["Clerk"],
  );
  const ref = await call(
    "/referrals",
    {
      name: "Meera Shah",
      phone: "9876500000",
      opening_id: opening,
      note: "Ex-colleague",
    },
    emp,
  );
  assert.equal(ref.status, 201, JSON.stringify(ref.data));
  assert.equal(
    (await call("/referrals", { name: "No contact" }, emp)).status,
    400,
  );
  const cand = (await call("/admin/candidates", undefined, hr)).data[0];
  assert.deepEqual(
    [cand.name, cand.source, cand.stage],
    ["Meera Shah", "Referral by EMP", "applied"],
  );
  assert.deepEqual(
    (await call("/referrals", undefined, emp)).data.map((r) => [
      r.name,
      r.stage,
    ]),
    [["Meera Shah", "applied"]],
  );
  assert.match(
    (await call("/notifications", undefined, hr)).data.items[0].title,
    /EMP referred Meera Shah/,
  );

  // Promotion: pending until applied; applying changes the profile and tells the person.
  const promo = await call(
    "/admin/changes",
    {
      user_id: people.emp.id,
      kind: "promotion",
      effective_date: "2026-11-01",
      designation_id: g1,
      note: "For strong work",
    },
    hr,
  );
  assert.equal(promo.status, 201, JSON.stringify(promo.data));
  assert.equal(
    (
      await call(
        "/admin/changes",
        {
          user_id: people.emp.id,
          kind: "promotion",
          effective_date: "2026-11-01",
        },
        hr,
      )
    ).status,
    400,
    "needs a designation",
  );
  assert.equal(
    (
      await call(
        "/admin/changes",
        {
          user_id: people.emp.id,
          kind: "promotion",
          effective_date: "2026-11-01",
          designation_id: g1,
        },
        emp,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(`/admin/changes/${promo.data.id}/apply`, {}, hr)).status,
    200,
  );
  assert.equal(
    (await call(`/admin/changes/${promo.data.id}/apply`, {}, hr)).status,
    409,
    "only once",
  );
  assert.equal(
    (await call(`/admin/employees/${people.emp.id}`, undefined, hr)).data
      .designation_name,
    "Manager",
  );
  assert.match(
    (await call("/notifications", undefined, emp)).data.items[0].title,
    /promoted/,
  );
  const letter = (
    await call(`/admin/changes/${promo.data.id}/letter`, undefined, hr)
  ).data;
  assert.equal(letter.title, "Promotion letter");
  assert.match(
    letter.paragraphs.join(" "),
    /promoted to Manager.*1 November 2026/,
  );
  assert.equal((await call("/my-changes", undefined, emp)).data.length, 1);

  // A change dated in the future cannot be applied yet; it can be cancelled.
  const later = (
    await call(
      "/admin/changes",
      {
        user_id: people.emp.id,
        kind: "transfer",
        effective_date: "2026-12-01",
        manager_id: people.mgr.id,
      },
      hr,
    )
  ).data.id;
  assert.equal(
    (await call(`/admin/changes/${later}/apply`, {}, hr)).status,
    409,
  );
  assert.equal(
    (await call(`/admin/changes/${later}/cancel`, {}, hr)).status,
    200,
  );

  // Increment: applied by an administrator, creates a salary revision and keeps the person's PF settings.
  assert.equal(
    (await call("/admin/payroll/components/seed-defaults", {}, pay)).status,
    201,
  );
  assert.equal(
    (
      await call(
        `/admin/employees/${people.emp.id}/salary`,
        {
          effective_from: "2026-04-01",
          monthly_gross: 20000,
          esi_applicable: true,
          pf_applicable: false,
        },
        pay,
      )
    ).status,
    201,
  );
  const inc = (
    await call(
      "/admin/changes",
      {
        user_id: people.emp.id,
        kind: "increment",
        effective_date: "2026-11-01",
        monthly_gross: 24000,
      },
      hr,
    )
  ).data.id;
  assert.equal(
    (await call(`/admin/changes/${inc}/apply`, {}, hr)).status,
    403,
    "HR cannot revise salary",
  );
  const done = await call(`/admin/changes/${inc}/apply`, {}, people.boss.token);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const salaries = (
    await call(`/admin/employees/${people.emp.id}/salary`, undefined, pay)
  ).data;
  const latest = salaries.find((s) => s.effective_from === "2026-11-01");
  assert.deepEqual(
    [
      latest.monthly_gross,
      Boolean(latest.pf_applicable),
      Boolean(latest.esi_applicable),
    ],
    [24000, false, false],
    "PF stays off; ESI ends above 21,000",
  );
  const history = (await call("/my-changes", undefined, emp)).data
    .map((c) => c.kind)
    .sort();
  assert.deepEqual(history, ["increment", "promotion"]);
});

test("forgot-password flow and the employee tax statement", async (t) => {
  process.env.APP_URL = "https://hrms.example.test";
  t.after(() => delete process.env.APP_URL);
  const w = await world(t);
  const { call, people, db } = w;
  // The answer never reveals whether the address exists.
  const a = await call("/forgot-password", { email: "emp@example.test" });
  const b = await call("/forgot-password", { email: "nobody@example.test" });
  assert.deepEqual([a.status, a.data.message], [b.status, b.data.message]);
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM password_resets").get()).n,
    1,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM notifications WHERE kind='password'")
        .get()
    ).n,
    0,
    "the link is never put in the in-app inbox",
  );
  // Use a token we know (the real one only travels by email).
  await db
    .prepare(
      "INSERT INTO password_resets(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)",
    )
    .run(
      people.emp.id,
      sha("known-token"),
      Date.now() + 60000,
      new Date().toISOString(),
    );
  assert.equal(
    (
      await call("/reset-password", {
        token: "wrong",
        password: "Brand-new-pass-1",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("/reset-password", { token: "known-token", password: "short" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("/reset-password", {
        token: "known-token",
        password: "Brand-new-pass-1",
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await call("/reset-password", {
        token: "known-token",
        password: "Another-pass-123",
      })
    ).status,
    400,
    "single use",
  );
  assert.equal(
    (await call("/me", undefined, people.emp.token)).status,
    401,
    "old sessions end",
  );
  assert.equal(
    typeof (await w.signIn("emp@example.test", "Brand-new-pass-1")),
    "string",
  );
  await db
    .prepare(
      "INSERT INTO password_resets(user_id,token_hash,expires_at,created_at) VALUES(?,?,?,?)",
    )
    .run(
      people.mgr.id,
      sha("old"),
      Date.now() - 1000,
      new Date().toISOString(),
    );
  assert.equal(
    (
      await call("/reset-password", {
        token: "old",
        password: "Brand-new-pass-1",
      })
    ).status,
    400,
    "expired",
  );

  // Employee tax statement: nothing before a run is approved.
  const empty = (
    await call(
      "/my/tax-statement?year=2026",
      undefined,
      await w.signIn("mgr@example.test"),
    )
  ).data;
  assert.deepEqual([empty.months.length, empty.totals.gross], [0, 0]);
  assert.equal(
    (
      await call(
        "/my/tax-statement?year=1999",
        undefined,
        await w.signIn("mgr@example.test"),
      )
    ).status,
    400,
  );
});

test("selfie at punch is required when the company asks, stored and viewable by HR", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token;
  const login = async (key) => {
    const device = `selfie-device-${key}`.padEnd(20, "0");
    const secret = "s".repeat(32);
    await db
      .prepare(
        "INSERT INTO devices(user_id,device_id,platform,model,secret_hash,status,registered_at) VALUES(?,?,?,?,?,'approved',?)",
      )
      .run(
        people[key].id,
        device,
        "android",
        "Pixel",
        sha(secret),
        new Date().toISOString(),
      );
    const r = await call("/login", {
      email: `${key}@example.test`,
      password: PW,
      native: true,
      device: { id: device, platform: "android", model: "Pixel", secret },
    });
    return {
      token: r.data.token,
      headers: { "X-Device-Id": device, "X-Device-Secret": secret },
    };
  };
  const punch = async (s, extra = {}) => {
    const res = await fetch(`${w.base}/punch`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.token}`,
        ...s.headers,
      },
      body: JSON.stringify({
        action: "in",
        location: {
          latitude: 26.9,
          longitude: 75.8,
          accuracy: 10,
          timestamp: Date.parse("2026-11-05T10:00:00+05:30"),
        },
        signals: { emulator: false, rooted: false },
        ...extra,
      }),
    });
    return { status: res.status, data: await res.json() };
  };
  const mgr = await login("mgr");
  assert.equal(
    (await punch(mgr)).status,
    200,
    "no selfie needed until the company asks",
  );
  assert.equal(
    (
      await call(
        "/admin/attendance-settings",
        { require_selfie: true },
        people.emp.token,
        "PATCH",
      )
    ).status,
    403,
    "employees cannot change company settings",
  );
  assert.equal(
    (
      await call(
        "/admin/attendance-settings",
        { require_selfie: true },
        w.owner,
        "PATCH",
      )
    ).status,
    200,
  );
  const emp = await login("emp");
  const missing = await punch(emp);
  assert.deepEqual(
    [missing.status, missing.data.code],
    [422, "selfie_required"],
  );
  assert.equal((await punch(emp, { selfie: "not base64!" })).status, 400);
  assert.equal(
    (await punch(emp, { selfie: Buffer.from("GIF89a....").toString("base64") }))
      .status,
    400,
    "must be a JPEG",
  );
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(2000, 7),
  ]).toString("base64");
  const ok = await punch(emp, { selfie: jpeg });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const res = await fetch(
    `${w.base}/admin/shifts/${ok.data.id}/selfie?kind=in`,
    { headers: { Authorization: `Bearer ${hr}` } },
  );
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/jpeg");
  assert.equal((await res.arrayBuffer()).byteLength, 2004);
  assert.equal(
    (
      await fetch(`${w.base}/admin/shifts/${ok.data.id}/selfie?kind=out`, {
        headers: { Authorization: `Bearer ${hr}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${w.base}/admin/shifts/${ok.data.id}/selfie`, {
        headers: { Authorization: `Bearer ${people.emp.token}` },
      })
    ).status,
    403,
  );
});

test("old punch selfies are purged but the punch stays", async (t) => {
  const { purgeOldSelfies } = await import("../server/retention.js");
  const w = await world(t);
  const { db, people } = w;
  const shift = Number(
    (
      await db
        .prepare(
          "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          people.emp.id,
          w.site,
          "Office",
          26.9,
          75.8,
          150,
          50,
          "2026-01-01T04:00:00.000Z",
          26.9,
          75.8,
          10,
        )
    ).lastInsertRowid,
  );
  await db
    .prepare(
      "INSERT INTO punch_photos(shift_id,kind,data,created_at) VALUES(?,?,?,?)",
    )
    .run(shift, "in", "AAAA", "2026-01-01T04:00:00.000Z");
  await db
    .prepare(
      "INSERT INTO punch_photos(shift_id,kind,data,created_at) VALUES(?,?,?,?)",
    )
    .run(shift, "out", "AAAA", "2026-10-20T04:00:00.000Z");
  assert.equal(
    await purgeOldSelfies(db, 90, Date.parse("2026-11-05T00:00:00Z")),
    1,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM punch_photos").get()).n,
    1,
  );
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM shifts").get()).n, 1);
});
