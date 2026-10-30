import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { randomBytes } from "node:crypto";
import { hotp, stepOf } from "../server/totp.js";

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

const PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\n").toString("base64");

test("two-factor login, recovery codes and session controls", async (t) => {
  const original = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  t.after(() =>
    original === undefined
      ? delete process.env.DATA_ENCRYPTION_KEY
      : (process.env.DATA_ENCRYPTION_KEY = original),
  );
  const w = await world(t);
  const { people } = w;
  await w.add("boss", { role: "admin" });
  const web = async (path, body, cookie, method = "POST") => {
    const res = await fetch(w.base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
      cookie: res.headers.get("set-cookie")?.split(";")[0],
    };
  };
  const login = (extra = {}) =>
    web("/login", { email: "boss@example.test", password: PW, ...extra });
  const first = await login();
  assert.equal(first.status, 200);
  const cookie = first.cookie;

  // Set up: nothing changes until a code is confirmed.
  const setup = (await web("/2fa/setup", {}, cookie)).data;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.equal((await web("/2fa", undefined, cookie)).data.enabled, false);
  assert.equal(
    (await web("/2fa/enable", { code: "000000" }, cookie)).status,
    400,
  );
  const code = () =>
    hotp(
      setup.secret,
      stepOf(Date.parse("2026-11-05T10:00:00+05:30") + w.offset),
    );
  w.offset = 0;
  const enabled = await web("/2fa/enable", { code: code() }, cookie);
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  assert.equal(enabled.data.recovery_codes.length, 8);

  // A browser login now needs a code; a used code is refused; a new one works.
  const noCode = await login();
  assert.equal(noCode.status, 401);
  assert.equal(noCode.data.code, "totp_required");
  assert.equal((await login({ code: "123456" })).status, 401);
  assert.equal(
    (await login({ code: code() })).status,
    401,
    "that time step was used to turn it on",
  );
  w.clockTo("2026-11-05T10:01:00+05:30");
  w.offset = 60000;
  const ok = await login({ code: code() });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(
    (await login({ code: code() })).status,
    401,
    "a code works once",
  );
  // Recovery codes work once each.
  const rc = enabled.data.recovery_codes[0];
  assert.equal((await login({ code: rc })).status, 200);
  assert.equal((await login({ code: rc })).status, 401);
  assert.equal(
    (await web("/2fa", undefined, ok.cookie)).data.recovery_codes_left,
    7,
  );

  // Sessions: list, revoke one, revoke the others.
  const sessions = (await web("/sessions", undefined, ok.cookie)).data;
  assert.ok(sessions.length >= 3);
  assert.equal(sessions.filter((s) => s.current).length, 1);
  const other = sessions.find((s) => !s.current);
  assert.equal(
    (await web(`/sessions/${other.id}`, undefined, ok.cookie, "DELETE")).status,
    200,
  );
  assert.equal(
    (await web("/sessions/revoke-others", {}, ok.cookie)).status,
    200,
  );
  assert.equal((await web("/sessions", undefined, ok.cookie)).data.length, 1);
  assert.equal(
    (await web("/me", undefined, cookie)).status,
    401,
    "the first browser was signed out",
  );

  // Turning it off needs the password; an admin can reset it for someone who lost their phone.
  assert.equal(
    (await web("/2fa/disable", { password: "wrong-password" }, ok.cookie))
      .status,
    403,
  );
  const reset = await w.call(
    `/admin/employees/${people.boss.id}/2fa-reset`,
    {},
    w.owner,
  );
  assert.equal(reset.status, 200);
  assert.equal((await login()).status, 200, "no code needed after the reset");
});

test("documents are validated, kept private and can be verified", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const hr = people.hr.token,
    emp = people.emp.token;
  const up = (body, token = emp) =>
    call(
      "/documents",
      {
        kind: "id_proof",
        name: "Aadhaar",
        mime: "application/pdf",
        data: PDF,
        ...body,
      },
      token,
    );
  const doc = await up({});
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  assert.equal(
    (await up({ mime: "image/png" })).status,
    400,
    "bytes do not match the type",
  );
  assert.equal((await up({ mime: "text/html" })).status, 400);
  assert.equal((await up({ data: "###" })).status, 400);
  const big = Buffer.concat([
    Buffer.from("%PDF"),
    Buffer.alloc(2 * 1024 * 1024 + 10),
  ]).toString("base64");
  assert.equal((await up({ data: big })).status, 413);
  // Only the owner and HR can see the list or the file.
  assert.equal((await call("/documents", undefined, emp)).data.length, 1);
  assert.equal(
    (await call(`/documents?user_id=${people.emp.id}`, undefined, hr)).data
      .length,
    1,
  );
  assert.equal(
    (
      await call(
        `/documents?user_id=${people.emp.id}`,
        undefined,
        people.mgr.token,
      )
    ).status,
    403,
  );
  const file = await fetch(`${w.base}/documents/${doc.data.id}/file`, {
    headers: { Authorization: `Bearer ${people.mgr.token}` },
  });
  assert.equal(file.status, 404);
  const ownFile = await fetch(`${w.base}/documents/${doc.data.id}/file`, {
    headers: { Authorization: `Bearer ${emp}` },
  });
  assert.equal(ownFile.status, 200);
  assert.equal(ownFile.headers.get("content-type"), "application/pdf");
  assert.match(Buffer.from(await ownFile.arrayBuffer()).toString(), /^%PDF/);
  // HR uploads on someone's behalf and verifies; after that the employee cannot delete it.
  assert.equal(
    (
      await call(
        "/documents",
        {
          user_id: people.emp.id,
          kind: "pan",
          name: "PAN card",
          mime: "application/pdf",
          data: PDF,
        },
        emp,
      )
    ).status,
    201,
    "own",
  );
  assert.equal(
    (
      await call(
        "/documents",
        {
          user_id: people.mgr.id,
          kind: "pan",
          name: "x",
          mime: "application/pdf",
          data: PDF,
        },
        emp,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call(`/documents/${doc.data.id}/verify`, {}, emp)).status,
    403,
  );
  assert.equal(
    (await call(`/documents/${doc.data.id}/verify`, {}, hr)).status,
    200,
  );
  assert.equal(
    (await call(`/documents/${doc.data.id}`, undefined, emp, "DELETE")).status,
    403,
  );
  assert.equal(
    (await call(`/documents/${doc.data.id}`, undefined, hr, "DELETE")).status,
    200,
  );
  assert.equal((await call("/documents", undefined, emp)).data.length, 1);
  // Missing-document report.
  const missing = (
    await call("/admin/documents/missing?kinds=pan,id_proof", undefined, hr)
  ).data;
  assert.deepEqual(missing.find((p) => p.name === "EMP").missing, ["id_proof"]);
  assert.deepEqual(missing.find((p) => p.name === "MGR").missing, [
    "pan",
    "id_proof",
  ]);
});

test("goals, review cycles and training", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    emp = people.emp.token,
    mgr = people.mgr.token;
  await db
    .prepare("UPDATE users SET manager_id=? WHERE id=?")
    .run(people.mgr.id, people.emp.id);

  // Goals: own, set by the manager, but not by a peer.
  const g = await call(
    "/goals",
    { title: "Close 20 loan accounts", weight: 60, due_date: "2026-12-31" },
    emp,
  );
  assert.equal(g.status, 201, JSON.stringify(g.data));
  assert.equal(
    (
      await call(
        "/goals",
        { user_id: people.emp.id, title: "Learn the new system" },
        mgr,
      )
    ).status,
    201,
  );
  assert.equal(
    (await call("/goals", { user_id: people.mgr.id, title: "Sneaky" }, emp))
      .status,
    403,
  );
  assert.equal(
    (await call(`/goals?user_id=${people.emp.id}`, undefined, people.pay.token))
      .status,
    403,
  );
  assert.equal(
    (await call(`/goals/${g.data.id}`, { progress: 100 }, emp, "PATCH")).status,
    200,
  );
  assert.equal(
    (await call("/goals", undefined, emp)).data.find((x) => x.id === g.data.id)
      .status,
    "done",
    "100% completes it",
  );

  // A review cycle: self-review, then the manager, then release.
  assert.equal(
    (
      await call(
        "/admin/review-cycles",
        { name: "FY26", start_date: "2026-04-01", end_date: "2027-03-31" },
        emp,
      )
    ).status,
    403,
  );
  const cycle = await call(
    "/admin/review-cycles",
    { name: "FY26", start_date: "2026-04-01", end_date: "2027-03-31" },
    hr,
  );
  assert.equal(cycle.status, 201, JSON.stringify(cycle.data));
  assert.equal(cycle.data.reviews, 4);
  const mine = (await call("/reviews/mine", undefined, emp)).data[0];
  assert.equal(mine.status, "pending_self");
  assert.equal(
    (
      await call(
        `/reviews/${mine.id}/manager`,
        { rating: 4, comment: "early" },
        mgr,
      )
    ).status,
    409,
    "needs the self-review first",
  );
  assert.equal(
    (await call(`/reviews/${mine.id}/self`, { rating: 9, comment: "x" }, emp))
      .status,
    400,
  );
  assert.equal(
    (
      await call(
        `/reviews/${mine.id}/self`,
        { rating: 4, comment: "Hit most targets" },
        emp,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/reviews/${mine.id}/self`,
        { rating: 5, comment: "again" },
        emp,
      )
    ).status,
    409,
  );
  assert.deepEqual(
    (await call("/reviews/team", undefined, mgr)).data.map(
      (r) => r.employee_name,
    ),
    ["EMP"],
  );
  assert.equal(
    (
      await call(
        `/reviews/${mine.id}/manager`,
        { rating: 3, comment: "Good, can do more" },
        emp,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/reviews/${mine.id}/manager`,
        { rating: 3, comment: "Good, can do more" },
        mgr,
      )
    ).status,
    200,
  );
  // The employee does not see the manager's rating until HR releases it.
  const hidden = (await call("/reviews/mine", undefined, emp)).data[0];
  assert.deepEqual(
    [hidden.status, hidden.manager_rating, hidden.manager_comment],
    ["completed", null, null],
  );
  assert.equal(
    (await call(`/admin/reviews/${mine.id}/release`, {}, hr)).status,
    200,
  );
  assert.equal(
    (await call("/reviews/mine", undefined, emp)).data[0].manager_rating,
    3,
  );
  // HR runs the cycle but cannot see or release their own result early.
  const hrReview = (await call("/reviews/mine", undefined, hr)).data[0];
  await db
    .prepare("UPDATE reviews SET self_rating=4,manager_rating=2,manager_comment='Needs work',status='completed' WHERE id=?")
    .run(hrReview.id);
  const cycleRows = (await call(`/admin/review-cycles/${cycle.data.id}/reviews`, undefined, hr)).data;
  const own = cycleRows.find((r) => r.id === hrReview.id);
  assert.deepEqual([own.own, own.manager_rating, own.manager_comment], [true, null, null]);
  assert.equal(cycleRows.find((r) => r.id === mine.id).manager_rating, 3, "others' ratings stay visible");
  const selfRelease = await call(`/admin/reviews/${hrReview.id}/release`, {}, hr);
  assert.equal(selfRelease.status, 403);
  assert.match(selfRelease.data.error, /own review/);
  assert.equal((await call(`/admin/reviews/${hrReview.id}/release`, {}, w.owner)).status, 200);
  assert.equal(
    (await call(`/admin/review-cycles/${cycle.data.id}/reviews`, undefined, hr)).data.find((r) => r.id === hrReview.id)
      .manager_rating,
    2,
    "visible once someone else releases it",
  );
  const cycles = (await call("/admin/review-cycles", undefined, hr)).data;
  assert.deepEqual([cycles[0].reviews, Number(cycles[0].completed)], [4, 2]);
  assert.equal(
    (await call(`/admin/review-cycles/${cycle.data.id}/close`, {}, hr)).status,
    200,
  );

  // Training: assigned to everyone; mandatory ones are confirmed by a manager or HR, not the person.
  const tr = await call(
    "/admin/trainings",
    {
      title: "Anti-money-laundering",
      hours: 2,
      mandatory: true,
      due_date: "2026-12-15",
    },
    hr,
  );
  assert.equal(tr.status, 201);
  assert.equal(tr.data.assigned, 4);
  const rec = (await call("/trainings/mine", undefined, emp)).data[0];
  assert.deepEqual(
    [rec.title, rec.status],
    ["Anti-money-laundering", "assigned"],
  );
  assert.equal(
    (await call(`/trainings/records/${rec.id}/complete`, {}, emp)).status,
    403,
  );
  assert.equal(
    (await call(`/trainings/records/${rec.id}/complete`, { score: 88 }, mgr))
      .status,
    200,
  );
  assert.equal(
    (await call("/trainings/mine", undefined, emp)).data[0].status,
    "completed",
  );
  const list = (await call("/admin/trainings", undefined, hr)).data[0];
  assert.deepEqual([list.assigned, Number(list.completed)], [4, 1]);
  // Optional training can be self-completed.
  const opt = (
    await call(
      "/admin/trainings",
      { title: "Excel basics", user_ids: [people.emp.id] },
      hr,
    )
  ).data;
  const optRec = (await call("/trainings/mine", undefined, emp)).data.find(
    (r) => r.title === "Excel basics",
  );
  assert.equal(
    (await call(`/trainings/records/${optRec.id}/complete`, {}, emp)).status,
    200,
  );
  void opt;
});

test("mid-year check-in, year-end with core competencies, and goal change history", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token,
    emp = people.emp.token,
    mgr = people.mgr.token;
  await db.prepare("UPDATE users SET manager_id=? WHERE id=?").run(people.mgr.id, people.emp.id);

  // Goal history: each changed field, with who changed it.
  const g = (await call("/goals", { title: "Close 20 loan accounts", weight: 60, due_date: "2026-12-31" }, emp)).data.id;
  assert.equal((await call(`/goals/${g}`, { weight: 50, title: "Close 25 loan accounts" }, mgr, "PATCH")).status, 200);
  assert.equal((await call(`/goals/${g}`, { progress: 40 }, emp, "PATCH")).status, 200);
  assert.equal((await call(`/goals/${g}`, { progress: 40 }, emp, "PATCH")).status, 200, "no change, no row");
  const h = (await call(`/goals/${g}/history`, undefined, emp)).data.changes;
  assert.deepEqual(
    h.map((c) => [c.field, c.old_value, c.new_value, c.changed_by_name]),
    [["progress", "0", "40", "EMP"], ["weight", "60", "50", "MGR"], ["title", "Close 20 loan accounts", "Close 25 loan accounts", "MGR"]],
  );
  assert.equal((await call(`/goals/${g}/history`, undefined, people.pay.token)).status, 403);
  assert.equal((await call(`/goals/${g}/history`, undefined, hr)).status, 200);

  // Mid-year: comments only.
  const mid = await call("/admin/review-cycles", { name: "FY26 mid-year", phase: "mid_year", start_date: "2026-04-01", end_date: "2026-09-30" }, hr);
  assert.equal(mid.status, 201, JSON.stringify(mid.data));
  assert.equal((await call("/admin/review-cycles", { name: "x", phase: "quarterly", start_date: "2026-04-01", end_date: "2026-09-30" }, hr)).status, 400);
  const m = (await call("/reviews/mine", undefined, emp)).data[0];
  assert.equal(m.phase, "mid_year");
  assert.equal((await call(`/reviews/${m.id}/self`, { comment: "On track for 25" }, emp)).status, 200);
  assert.equal((await call(`/reviews/${m.id}/manager`, { comment: "Agreed; focus on recoveries" }, mgr)).status, 200);
  await call(`/admin/review-cycles/${mid.data.id}/close`, {}, hr);

  // Year-end: overall rating required, and competencies.
  assert.equal((await call("/admin/competencies", { name: "Customer focus" }, emp)).status, 403);
  const c1 = (await call("/admin/competencies", { name: "Customer focus", sort_order: 1 }, hr)).data.id;
  const c2 = (await call("/admin/competencies", { name: "Integrity", sort_order: 2 }, hr)).data.id;
  const c3 = (await call("/admin/competencies", { name: "Old one" }, hr)).data.id;
  assert.equal((await call("/admin/competencies", { name: "integrity" }, hr)).status, 409);
  assert.equal((await call(`/admin/competencies/${c3}`, { active: false }, hr, "PATCH")).status, 200);
  const ye = (await call("/admin/review-cycles", { name: "FY26 year-end", start_date: "2026-04-01", end_date: "2027-03-31" }, hr)).data.id;
  const r = (await call("/reviews/mine", undefined, emp)).data.find((x) => x.cycle_id === ye);
  assert.equal(r.phase, "year_end");
  assert.deepEqual((await call(`/reviews/${r.id}/competencies`, undefined, emp)).data.map((x) => x.name), ["Customer focus", "Integrity"]);
  assert.equal((await call(`/reviews/${r.id}/competencies`, { ratings: [{ competency_id: c3, rating: 4 }] }, emp, "PUT")).status, 400, "retired");
  assert.equal((await call(`/reviews/${r.id}/competencies`, { ratings: [{ competency_id: c1, rating: 4 }] }, mgr, "PUT")).status, 409, "manager waits for the self-review");
  assert.equal((await call(`/reviews/${r.id}/competencies`, { ratings: [{ competency_id: c1, rating: 4 }, { competency_id: c2, rating: 5 }] }, emp, "PUT")).status, 200);
  assert.equal((await call(`/reviews/${r.id}/self`, { comment: "Closed 26" }, emp)).status, 400, "rating required at year-end");
  assert.equal((await call(`/reviews/${r.id}/self`, { rating: 4, comment: "Closed 26" }, emp)).status, 200);
  assert.equal((await call(`/reviews/${r.id}/competencies`, { ratings: [{ competency_id: c1, rating: 5 }] }, emp, "PUT")).status, 409, "locked after submitting");
  assert.equal((await call(`/reviews/${r.id}/competencies`, { ratings: [{ competency_id: c1, rating: 3, comment: "Slow on complaints" }, { competency_id: c2, rating: 5 }] }, mgr, "PUT")).status, 200);
  assert.equal((await call(`/reviews/${r.id}/manager`, { rating: 4, comment: "Strong year" }, mgr)).status, 200);
  // Hidden from the employee until released.
  const before = (await call(`/reviews/${r.id}/competencies`, undefined, emp)).data;
  assert.deepEqual(before.map((x) => [x.self_rating, x.manager_rating]), [[4, null], [5, null]]);
  assert.equal((await call(`/admin/reviews/${r.id}/release`, {}, hr)).status, 200);
  const after = (await call(`/reviews/${r.id}/competencies`, undefined, emp)).data;
  assert.deepEqual(after.map((x) => [x.manager_rating, x.manager_comment]), [[3, "Slow on complaints"], [5, null]]);
  assert.equal((await call(`/reviews/${r.id}/competencies`, undefined, people.pay.token)).status, 403);
});
