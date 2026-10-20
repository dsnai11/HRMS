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

test("NDA and policy sign-off, IT/Finance/Admin task owners, welcome email and joiner dashboard", async (t) => {
  const w = await world(t);
  const { call, people, db, app } = w;
  const hr = people.hr.token;
  const mails = [];
  app.notify.mail = async (...a) => (mails.push(a), true);

  // Documents are managed by HR only.
  assert.equal(
    (await call("/admin/joining-documents", undefined, people.emp.token))
      .status,
    403,
  );
  const nda = await call(
    "/admin/joining-documents",
    {
      title: "Non-disclosure agreement",
      kind: "nda",
      body: "You will keep company information confidential.",
    },
    hr,
  );
  assert.equal(nda.status, 201);
  const optional = await call(
    "/admin/joining-documents",
    { title: "Welcome note", kind: "other", required: false, body: "Welcome." },
    hr,
  );
  assert.equal(
    (await call("/admin/joining-documents", { title: "x" }, hr)).status,
    400,
  );

  // IT work goes to named people.
  assert.equal(
    (
      await call(
        "/admin/onboarding/owners/it",
        { user_ids: [people.emp.id] },
        people.emp.token,
        "PUT",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        "/admin/onboarding/owners/it",
        { user_ids: [people.emp.id] },
        hr,
        "PUT",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call("/admin/onboarding/owners/legal", { user_ids: [] }, hr, "PUT"))
      .status,
    400,
  );
  assert.equal(
    (await call("/admin/onboarding/owners", undefined, hr)).data.it[0].name,
    "EMP",
  );

  // Candidate with an accepted offer, on the joining portal.
  const cid = (
    await call(
      "/admin/candidates",
      { name: "Riya Jain", email: "riya@example.test" },
      hr,
    )
  ).data.id;
  const offer = await call(
    `/admin/candidates/${cid}/offers`,
    { designation: "Clerk", monthly_gross: 20000, joining_date: "2026-12-01" },
    hr,
  );
  const sent = await call(
    `/admin/offers/${offer.data.id}/status`,
    { status: "sent" },
    hr,
  );
  const jt = new URL(sent.data.link, "http://x").searchParams.get("t");
  const join = (p, b, m) => call(`/join/${jt}${p}`, b, undefined, m);
  await join("/accept", { full_name: "Riya Jain" });
  const view = (await join("")).data;
  assert.deepEqual(
    view.agreements.map((a) => [a.title, a.required, a.signed_at]),
    [
      ["Non-disclosure agreement", true, null],
      ["Welcome note", false, null],
    ],
  );
  const bad = await join("/submit", {});
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /sign "Non-disclosure agreement"/);
  assert.doesNotMatch(bad.data.error, /Welcome note/);
  assert.equal(
    (
      await join(`/agreements/${nda.data.id}/acknowledge`, {
        full_name: "Riya Jain",
        agree: false,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await join(`/agreements/${nda.data.id}/acknowledge`, {
        full_name: "Other Person",
        agree: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await join(`/agreements/${nda.data.id}/acknowledge`, {
        full_name: "riya jain",
        agree: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await join(`/agreements/${nda.data.id}/acknowledge`, {
        full_name: "riya jain",
        agree: true,
      })
    ).status,
    200,
  );
  assert.doesNotMatch((await join("/submit", {})).data.error, /Non-disclosure/);
  assert.equal(
    (
      await join("/agreements/99999/acknowledge", {
        full_name: "Riya Jain",
        agree: true,
      })
    ).status,
    404,
  );
  // What was signed is kept as it read at the time, even if the document is edited later.
  await call(
    `/admin/joining-documents/${nda.data.id}`,
    { body: "A different text." },
    hr,
    "PATCH",
  );
  assert.equal(
    (await db.prepare("SELECT text_snapshot FROM joining_acks").get())
      .text_snapshot,
    "You will keep company information confidential.",
  );
  void optional;

  // Dashboard row before joining.
  const row = (await call("/admin/onboarding/joiners", undefined, hr)).data
    .pending[0];
  assert.deepEqual([row.agreements_required, row.agreements_signed], [1, 1]);

  // Hire: welcome email with the login, owner teams told, signed document moves to the employee.
  mails.length = 0;
  const hired = await call(
    `/admin/candidates/${cid}/hire`,
    {
      password: PW,
      manager_id: people.mgr.id,
      workstation: "Desk 12, Laptop L-45",
    },
    hr,
  );
  assert.equal(hired.status, 201, JSON.stringify(hired.data));
  const welcome = mails.find((m) => /Welcome to Alpha/.test(m[2]));
  assert.ok(welcome, "welcome email sent");
  assert.equal(welcome[1], "riya@example.test");
  assert.match(welcome[3], new RegExp(`Temporary password: ${PW}`));
  assert.match(welcome[3], /Reporting manager: MGR \(mgr@example\.test\)/);
  assert.match(welcome[3], /Desk 12, Laptop L-45/);
  const itNote = await db
    .prepare(
      "SELECT title FROM notifications WHERE user_id=? AND kind='onboarding'",
    )
    .all(people.emp.id);
  assert.ok(
    itNote.some((n) => /IT task/.test(n.title)),
    JSON.stringify(itNote),
  );
  assert.equal(
    (
      await db
        .prepare(
          "SELECT COUNT(*) n FROM notifications WHERE title LIKE '%Finance task%'",
        )
        .get()
    ).n,
    0,
  );
  const acks = (
    await call(
      `/admin/employees/${hired.data.user_id}/joining-acks`,
      undefined,
      hr,
    )
  ).data;
  assert.equal(acks.length, 1);
  assert.equal(acks[0].given_name, "riya jain");

  // The IT person sees and completes IT tasks, but not HR's.
  const assigned = (
    await call("/onboarding/assigned", undefined, people.emp.token)
  ).data;
  assert.ok(assigned.length >= 2 && assigned.every((x) => x.owner === "it"));
  assert.equal(
    (
      await call(
        `/onboarding-tasks/${assigned[0].id}/done`,
        {},
        people.emp.token,
      )
    ).status,
    200,
  );
  const hrTask = (
    await call(
      `/admin/employees/${hired.data.user_id}/onboarding`,
      undefined,
      hr,
    )
  ).data.find((x) => x.owner === "hr");
  assert.equal(
    (await call(`/onboarding-tasks/${hrTask.id}/done`, {}, people.emp.token))
      .status,
    403,
  );
  assert.ok(
    (await call("/me", undefined, people.emp.token)).data.approvals_pending >=
      1,
  );

  // Welcome email can be switched off; joined dashboard shows the whole picture.
  const c2 = (
    await call(
      "/admin/candidates",
      { name: "Dev Kumar", email: "dev@example.test" },
      hr,
    )
  ).data.id;
  const o2 = await call(
    `/admin/candidates/${c2}/offers`,
    { designation: "Clerk", monthly_gross: 20000, joining_date: "2026-12-01" },
    hr,
  );
  await call(`/admin/offers/${o2.data.id}/status`, { status: "sent" }, hr);
  await call(`/admin/offers/${o2.data.id}/status`, { status: "accepted" }, hr);
  mails.length = 0;
  assert.equal(
    (
      await call(
        `/admin/candidates/${c2}/hire`,
        { password: PW, send_welcome: false },
        hr,
      )
    ).status,
    201,
  );
  assert.ok(!mails.some((m) => /Welcome to Alpha/.test(m[2])));
  const joined = (
    await call("/admin/onboarding/joiners", undefined, hr)
  ).data.joined.find((j) => j.name === "Riya Jain");
  assert.equal(joined.policies_signed, 1);
  assert.equal(joined.tasks, 11);
  assert.equal(Number(joined.tasks_done), 1);
});
