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

test("a candidate moves from opening to hired employee with an onboarding checklist", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const hr = people.hr.token;

  // Only HR and admin run recruitment.
  assert.equal(
    (await call("/admin/openings", undefined, people.emp.token)).status,
    403,
  );
  assert.equal(
    (await call("/admin/openings", undefined, people.pay.token)).status,
    403,
  );

  const opening = await call(
    "/admin/openings",
    {
      title: "Branch Manager",
      positions: 2,
      hiring_manager_id: people.mgr.id,
      employment_type: "full_time",
    },
    hr,
  );
  assert.equal(opening.status, 201, JSON.stringify(opening.data));
  const cand = await call(
    "/admin/candidates",
    {
      name: "Asha Verma",
      email: "asha@example.test",
      phone: "9876543210",
      opening_id: opening.data.id,
      source: "Referral",
      expected_ctc: 600000,
    },
    hr,
  );
  assert.equal(cand.status, 201, JSON.stringify(cand.data));
  const id = cand.data.id;
  assert.equal(
    (
      await call(
        "/admin/candidates",
        {
          name: "Asha Verma",
          email: "ASHA@example.test",
          opening_id: opening.data.id,
        },
        hr,
      )
    ).status,
    409,
    "no duplicate in the same pipeline",
  );
  assert.equal(
    (await call("/admin/candidates", { name: "X", email: "bad" }, hr)).status,
    400,
  );

  // Hiring before an accepted offer is refused.
  assert.equal(
    (await call(`/admin/candidates/${id}/hire`, { password: PW }, hr)).status,
    409,
  );

  // Scheduling an interview moves the candidate into the interview stage; the interviewer gives feedback.
  const iv = await call(
    `/admin/candidates/${id}/interviews`,
    {
      interviewer_id: people.mgr.id,
      round_name: "Round 1",
      scheduled_at: "2026-11-10T11:00:00+05:30",
      mode: "video",
      location: "meet.example/abc",
    },
    hr,
  );
  assert.equal(iv.status, 201, JSON.stringify(iv.data));
  assert.equal(
    (await call(`/admin/candidates/${id}`, undefined, hr)).data.stage,
    "interview",
  );
  const mine = (await call("/interviews/mine", undefined, people.mgr.token))
    .data;
  assert.deepEqual(
    mine.map((i) => [i.candidate_name, i.status]),
    [["Asha Verma", "scheduled"]],
  );
  assert.equal(
    (
      await call(
        `/interviews/${iv.data.id}/feedback`,
        { rating: 4, recommendation: "yes", feedback: "Strong" },
        people.emp.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/interviews/${iv.data.id}/feedback`,
        { rating: 9, recommendation: "yes", feedback: "x" },
        people.mgr.token,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/interviews/${iv.data.id}/feedback`,
        { rating: 4, recommendation: "yes", feedback: "Strong" },
        people.mgr.token,
      )
    ).status,
    200,
  );
  const detail = (await call(`/admin/candidates/${id}`, undefined, hr)).data;
  assert.deepEqual(
    [detail.interviews[0].status, detail.interviews[0].rating],
    ["completed", 4],
  );

  // Offer: needs a future joining date; letter is generated; status follows its lifecycle.
  assert.equal(
    (
      await call(
        `/admin/candidates/${id}/offers`,
        { designation: "BM", monthly_gross: 50000, joining_date: "2026-10-01" },
        hr,
      )
    ).status,
    400,
  );
  const offer = await call(
    `/admin/candidates/${id}/offers`,
    {
      designation: "Branch Manager",
      monthly_gross: 50000,
      joining_date: "2026-12-01",
      valid_until: "2026-11-20",
    },
    hr,
  );
  assert.equal(offer.status, 201, JSON.stringify(offer.data));
  assert.equal(
    (await call(`/admin/candidates/${id}`, undefined, hr)).data.stage,
    "offer",
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${id}/offers`,
        { designation: "BM", monthly_gross: 1, joining_date: "2026-12-01" },
        hr,
      )
    ).status,
    409,
    "one live offer at a time",
  );
  const letter = (
    await call(`/admin/offers/${offer.data.id}/letter`, undefined, hr)
  ).data;
  assert.equal(letter.company, "Alpha Ltd");
  assert.match(letter.paragraphs.join(" "), /Branch Manager/);
  assert.match(letter.paragraphs.join(" "), /Rs\. 50,000/);
  assert.match(letter.paragraphs.join(" "), /6,00,000/);
  assert.equal(
    (
      await call(
        `/admin/offers/${offer.data.id}/status`,
        { status: "accepted" },
        hr,
      )
    ).status,
    409,
    "must be sent first",
  );
  assert.equal(
    (
      await call(
        `/admin/offers/${offer.data.id}/status`,
        { status: "sent" },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/offers/${offer.data.id}/status`,
        { status: "accepted" },
        hr,
      )
    ).status,
    200,
  );

  // Hire creates the employee with the offer's joining date, opening details and a checklist.
  const hire = await call(
    `/admin/candidates/${id}/hire`,
    { password: PW, workplace_id: w.site },
    hr,
  );
  assert.equal(hire.status, 201, JSON.stringify(hire.data));
  const emp = (
    await call(`/admin/employees/${hire.data.user_id}`, undefined, hr)
  ).data;
  assert.deepEqual(
    [
      emp.name,
      emp.email,
      emp.date_of_joining,
      emp.manager_id,
      emp.employment_type,
    ],
    [
      "Asha Verma",
      "asha@example.test",
      "2026-12-01",
      people.mgr.id,
      "full_time",
    ],
  );
  assert.equal(
    (await call(`/admin/candidates/${id}`, undefined, hr)).data.stage,
    "hired",
  );
  assert.equal(
    (await call(`/admin/candidates/${id}/hire`, { password: PW }, hr)).status,
    409,
    "only once",
  );
  const open = (await call("/admin/openings", undefined, hr)).data[0];
  assert.deepEqual([open.candidates, open.filled, open.in_process], [1, 1, 0]);

  const tasks = (
    await call(
      `/admin/employees/${hire.data.user_id}/onboarding`,
      undefined,
      hr,
    )
  ).data;
  assert.equal(tasks.length, 9);
  assert.equal(tasks[0].due_date, "2026-12-01");
  // The new joiner completes only their own tasks; their manager the manager's.
  await w.db
    .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
    .run(hire.data.user_id);
  const joiner = await w.signIn("asha@example.test");
  const own = (await call("/onboarding/mine", undefined, joiner)).data;
  const byOwner = (o) => own.find((x) => x.owner === o);
  assert.equal(
    (await call(`/onboarding-tasks/${byOwner("hr").id}/done`, {}, joiner))
      .status,
    403,
  );
  assert.equal(
    (await call(`/onboarding-tasks/${byOwner("employee").id}/done`, {}, joiner))
      .status,
    200,
  );
  assert.equal(
    (
      await call(
        `/onboarding-tasks/${byOwner("manager").id}/done`,
        {},
        people.mgr.token,
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/onboarding-tasks/${byOwner("hr").id}/done`, {}, hr)).status,
    200,
  );
  const progress = (await call("/admin/onboarding", undefined, hr)).data.find(
    (p) => p.name === "Asha Verma",
  );
  assert.deepEqual([progress.total, Number(progress.done)], [9, 3]);
});

test("rejections, declined offers and the company's own checklist", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const hr = people.hr.token;
  const a = (await call("/admin/candidates", { name: "Ravi" }, hr)).data.id;
  assert.equal(
    (await call(`/admin/candidates/${a}/stage`, { stage: "rejected" }, hr))
      .status,
    400,
    "a reason is required",
  );
  assert.equal(
    (await call(`/admin/candidates/${a}/stage`, { stage: "offer" }, hr)).status,
    400,
    "offer follows from an offer, not by hand",
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${a}/stage`,
        { stage: "rejected", reason: "Not a fit" },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${a}/interviews`,
        { interviewer_id: people.mgr.id, scheduled_at: "2026-11-10T11:00:00Z" },
        hr,
      )
    ).status,
    409,
  );

  const b = (await call("/admin/candidates", { name: "Sita" }, hr)).data.id;
  const o = (
    await call(
      `/admin/candidates/${b}/offers`,
      {
        designation: "Clerk",
        monthly_gross: 20000,
        joining_date: "2026-12-01",
      },
      hr,
    )
  ).data.id;
  await call(`/admin/offers/${o}/status`, { status: "sent" }, hr);
  await call(`/admin/offers/${o}/status`, { status: "declined" }, hr);
  const sita = (await call(`/admin/candidates/${b}`, undefined, hr)).data;
  assert.deepEqual(
    [sita.stage, sita.closed_reason],
    ["rejected", "Declined the offer"],
  );
  const summary = (await call("/admin/recruitment/summary", undefined, hr))
    .data;
  assert.equal(summary.stages.rejected, 2);

  // A company checklist replaces the standard one.
  assert.equal(
    (
      await call(
        "/admin/onboarding/template",
        { title: "Collect photo", owner: "hr", due_days: 2 },
        hr,
      )
    ).status,
    201,
  );
  const c = (
    await call(
      "/admin/candidates",
      { name: "Tara", email: "tara@example.test" },
      hr,
    )
  ).data.id;
  const o2 = (
    await call(
      `/admin/candidates/${c}/offers`,
      {
        designation: "Clerk",
        monthly_gross: 20000,
        joining_date: "2026-12-01",
      },
      hr,
    )
  ).data.id;
  await call(`/admin/offers/${o2}/status`, { status: "sent" }, hr);
  await call(`/admin/offers/${o2}/status`, { status: "accepted" }, hr);
  const hired = (
    await call(
      `/admin/candidates/${c}/hire`,
      { password: PW, workplace_id: w.site },
      hr,
    )
  ).data.user_id;
  const tasks = (
    await call(`/admin/employees/${hired}/onboarding`, undefined, hr)
  ).data;
  assert.deepEqual(
    tasks.map((x) => [x.title, x.due_date]),
    [["Collect photo", "2026-12-03"]],
  );
  // Payroll staff cannot hire.
  assert.equal(
    (
      await call(
        `/admin/candidates/${c}/hire`,
        { password: PW },
        people.pay.token,
      )
    ).status,
    403,
  );
});

test("assets are issued to one person at a time and shown to them", async (t) => {
  const w = await world(t);
  const { call, people } = w;
  const hr = people.hr.token;
  const a = (
    await call(
      "/admin/assets",
      { name: "Laptop", tag: "LT-001", category: "IT" },
      hr,
    )
  ).data.id;
  assert.equal(
    (await call("/admin/assets", { name: "Laptop 2", tag: "lt-001" }, hr))
      .status,
    409,
    "tags are unique",
  );
  assert.equal(
    (await call(`/admin/assets/${a}/assign`, { user_id: people.emp.id }, hr))
      .status,
    200,
  );
  assert.equal(
    (await call(`/admin/assets/${a}/assign`, { user_id: people.mgr.id }, hr))
      .status,
    409,
  );
  assert.deepEqual(
    (await call("/assets/mine", undefined, people.emp.token)).data.map(
      (x) => x.tag,
    ),
    ["LT-001"],
  );
  assert.equal(
    (await call("/admin/assets", undefined, people.emp.token)).status,
    403,
  );
  assert.equal((await call(`/admin/assets/${a}/return`, {}, hr)).status, 200);
  assert.deepEqual(
    (await call("/assets/mine", undefined, people.emp.token)).data,
    [],
  );
});
