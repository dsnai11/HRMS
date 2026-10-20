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

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n").toString("base64");

test("bank change requests need someone else's approval", async (t) => {
  const prev = process.env.DATA_ENCRYPTION_KEY;
  delete process.env.DATA_ENCRYPTION_KEY;
  t.after(() =>
    prev === undefined
      ? delete process.env.DATA_ENCRYPTION_KEY
      : (process.env.DATA_ENCRYPTION_KEY = prev),
  );
  const w = await world(t);
  const { call, people } = w;
  const emp = people.emp.token;
  const form = {
    account_holder: "Esha Employee",
    bank_name: "HDFC Bank",
    bank_account: "123456789012",
    ifsc: "HDFC0001234",
  };
  assert.equal((await call("/profile/bank-change", form, emp)).status, 503);
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 5).toString("base64");
  const doc = await call(
    "/documents",
    { kind: "bank", name: "Cheque", mime: "application/pdf", data: PDF },
    emp,
  );
  const theirs = await call(
    "/documents",
    { kind: "bank", name: "Other", mime: "application/pdf", data: PDF },
    people.mgr.token,
  );
  assert.equal(
    (
      await call(
        "/profile/bank-change",
        { ...form, ifsc: "bad", document_id: doc.data.id },
        emp,
      )
    ).status,
    400,
  );
  assert.equal(
    (await call("/profile/bank-change", form, emp)).status,
    400,
    "proof is required",
  );
  assert.equal(
    (
      await call(
        "/profile/bank-change",
        { ...form, document_id: theirs.data.id },
        emp,
      )
    ).status,
    400,
  );
  const req = await call(
    "/profile/bank-change",
    { ...form, document_id: doc.data.id },
    emp,
  );
  assert.equal(req.status, 201, JSON.stringify(req.data));
  assert.equal(
    (
      await call(
        "/profile/bank-change",
        { ...form, document_id: doc.data.id },
        emp,
      )
    ).status,
    409,
  );
  const mine = (await call("/profile/bank-change", undefined, emp)).data[0];
  assert.match(mine.summary, /HDFC Bank · •+9012 · HDFC0001234/);
  assert.equal(JSON.stringify(mine).includes("123456789012"), false);

  // Reviewers see it with a masked number; others do not.
  assert.equal((await call("/admin/bank-changes", undefined, emp)).status, 403);
  const list = (await call("/admin/bank-changes", undefined, people.pay.token))
    .data;
  assert.equal(list.length, 1);
  assert.equal(JSON.stringify(list).includes("123456789012"), false);
  assert.equal(
    (await call(`/admin/bank-changes/${req.data.id}/proof`, undefined, emp))
      .status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${req.data.id}/proof`,
        undefined,
        people.hr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${req.data.id}/decision`,
        { decision: "rejected" },
        people.pay.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${req.data.id}/decision`,
        { decision: "approved" },
        emp,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${req.data.id}/decision`,
        { decision: "approved" },
        people.pay.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${req.data.id}/decision`,
        { decision: "approved" },
        people.pay.token,
      )
    ).status,
    409,
  );
  const stored = await call(
    `/admin/employees/${people.emp.id}/private`,
    undefined,
    people.pay.token,
  );
  assert.match(stored.data.data.bank_account, /9012$/);
  assert.equal(stored.data.data.ifsc, "HDFC0001234");
  assert.equal(
    (await call("/profile/bank-change", undefined, emp)).data[0].status,
    "approved",
  );

  // A reviewer cannot approve their own change.
  const hrDoc = await call(
    "/documents",
    { kind: "bank", name: "Cheque", mime: "application/pdf", data: PDF },
    people.hr.token,
  );
  const own = await call(
    "/profile/bank-change",
    { ...form, document_id: hrDoc.data.id },
    people.hr.token,
  );
  assert.equal(own.status, 201);
  assert.equal(
    (
      await call(
        `/admin/bank-changes/${own.data.id}/decision`,
        { decision: "approved" },
        people.hr.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (await call("/admin/bank-changes", undefined, people.hr.token)).data.length,
    0,
    "not shown to the requester",
  );
  assert.equal(
    (
      await call(
        `/profile/bank-change/${own.data.id}/cancel`,
        {},
        people.hr.token,
      )
    ).status,
    200,
  );
});

test("employees can read their own employment letters, and no one else's", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token;
  const des = (
    await call("/admin/designations", { name: "Branch Manager" }, hr)
  ).data.id;
  await db
    .prepare(
      "UPDATE users SET designation_id=?,probation_end_date='2026-07-01' WHERE id=?",
    )
    .run(des, people.emp.id);
  const list = (await call("/my-letters", undefined, people.emp.token)).data;
  assert.deepEqual(
    list.map((l) => l.kind),
    ["appointment"],
  );
  const appt = (
    await call(
      `/my-letters/appointment/${people.emp.id}`,
      undefined,
      people.emp.token,
    )
  ).data;
  assert.equal(appt.title, "Appointment letter");
  assert.match(appt.paragraphs.join(" "), /Branch Manager/);
  assert.match(appt.paragraphs.join(" "), /probation until 1 July 2026/);
  assert.equal(
    (
      await call(
        `/my-letters/appointment/${people.mgr.id}`,
        undefined,
        people.emp.token,
      )
    ).status,
    404,
  );
  // A promotion letter appears once applied.
  const ch = await call(
    "/admin/changes",
    {
      user_id: people.emp.id,
      kind: "confirmation",
      effective_date: "2026-11-05",
    },
    hr,
  );
  assert.equal(
    (await call("/my-letters", undefined, people.emp.token)).data.length,
    1,
    "not before it is applied",
  );
  await call(`/admin/changes/${ch.data.id}/apply`, {}, hr);
  const after = (await call("/my-letters", undefined, people.emp.token)).data;
  assert.deepEqual(after.map((l) => l.title).sort(), [
    "Appointment letter",
    "Confirmation letter",
  ]);
  const conf = after.find((l) => l.kind === "change");
  assert.match(
    (
      await call(`/my-letters/change/${conf.id}`, undefined, people.emp.token)
    ).data.paragraphs.join(" "),
    /confirm your services/,
  );
  assert.equal(
    (await call(`/my-letters/change/${conf.id}`, undefined, people.mgr.token))
      .status,
    404,
  );
  // The accepted offer of someone hired from the pipeline.
  const c = await db
    .prepare(
      "INSERT INTO candidates(company_id,name,stage,user_id,created_at,updated_at) VALUES(1,'EMP','hired',?,'2026-01-01','2026-01-01')",
    )
    .run(people.emp.id);
  await db
    .prepare(
      "INSERT INTO offers(company_id,candidate_id,designation,monthly_gross,joining_date,status,created_at,decided_at) VALUES(1,?,?,?,?,?,?,?)",
    )
    .run(
      c.lastInsertRowid,
      "Branch Manager",
      50000,
      "2026-01-01",
      "accepted",
      "2025-12-20",
      "2025-12-22T10:00:00Z",
    );
  const offer = (
    await call("/my-letters", undefined, people.emp.token)
  ).data.find((l) => l.kind === "offer");
  assert.match(
    (
      await call(`/my-letters/offer/${offer.id}`, undefined, people.emp.token)
    ).data.paragraphs.join(" "),
    /Branch Manager/,
  );
  assert.equal(
    (await call(`/my-letters/offer/${offer.id}`, undefined, people.mgr.token))
      .status,
    404,
  );
});

test("helpdesk tickets carry response times and new request types", async (t) => {
  const w = await world(t);
  const { call, people, setNow } = w;
  const hr = people.hr.token;
  assert.equal(
    (await call("/admin/helpdesk/sla", undefined, people.emp.token)).status,
    403,
  );
  assert.deepEqual((await call("/admin/helpdesk/sla", undefined, hr)).data, {
    low: 72,
    normal: 48,
    high: 24,
  });
  assert.equal(
    (
      await call(
        "/admin/helpdesk/sla",
        { low: 72, normal: 0, high: 24 },
        hr,
        "PUT",
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        "/admin/helpdesk/sla",
        { low: 72, normal: 36, high: 8 },
        hr,
        "PUT",
      )
    ).status,
    200,
  );
  const mk = (subject, priority = "normal", category = "id_card") =>
    call(
      "/tickets",
      { subject, body: "Please help", priority, category },
      people.emp.token,
    );
  const a = await mk("ID card reprint");
  const b = await mk("Experience certificate", "high", "certificate");
  assert.equal(a.status, 201, JSON.stringify(a.data));
  const first = (await call("/tickets", undefined, people.emp.token)).data.find(
    (x) => x.id === a.data.id,
  );
  assert.equal(first.due_at, "2026-11-06T16:30:00.000Z");
  assert.equal(first.sla_state, "due");
  // Time passes: the high-priority one is breached first and listed first.
  setNow("2026-11-06T12:00:00+05:30");
  const open = (await call("/admin/tickets", undefined, hr)).data;
  assert.deepEqual(
    open.map((x) => [x.subject, x.sla_state]),
    [
      ["Experience certificate", "breached"],
      ["ID card reprint", "due"],
    ],
  );
  // A staff reply counts as the first response; resolving in time is "met", late is "missed".
  assert.equal(
    (await call(`/tickets/${a.data.id}/reply`, { body: "On it" }, hr)).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/tickets/${a.data.id}`,
        { status: "resolved" },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/tickets/${b.data.id}`,
        { status: "resolved" },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  const done = (await call("/tickets", undefined, people.emp.token)).data;
  assert.equal(done.find((x) => x.id === a.data.id).sla_state, "met");
  assert.equal(done.find((x) => x.id === b.data.id).sla_state, "missed");
  assert.ok(done.find((x) => x.id === a.data.id).first_response_at);
  assert.equal(
    (
      await call(
        "/tickets",
        { subject: "x", body: "y", category: "nope" },
        people.emp.token,
      )
    ).status,
    400,
  );
});
