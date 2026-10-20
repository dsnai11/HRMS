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

test("question bank, panel interviews with suggested questions, invites, scorecard and analytics", async (t) => {
  const w = await world(t);
  const { call, people, db, app } = w;
  const hr = people.hr.token;
  const dept = (await call("/admin/departments", { name: "Credit" }, hr)).data
    .id;
  const other = (await call("/admin/departments", { name: "Tech" }, hr)).data
    .id;

  // Bank: only HR manages it; import skips duplicates and numbering.
  assert.equal(
    (await call("/admin/question-bank", undefined, people.emp.token)).status,
    403,
  );
  const add = (q, category, department_id) =>
    call(
      "/admin/question-bank",
      { question: q, category, department_id, difficulty: "medium" },
      hr,
    );
  assert.equal(
    (
      await add(
        "How do you assess a borrower's repayment capacity?",
        "technical",
        dept,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await add(
        "Tell us about a time you handled a difficult customer.",
        "behavioural",
        dept,
      )
    ).status,
    201,
  );
  assert.equal(
    (
      await add(
        "A client asks you to skip KYC. What do you do?",
        "situational",
        dept,
      )
    ).status,
    201,
  );
  assert.equal(
    (await add("Explain REST vs GraphQL.", "technical", other)).status,
    201,
  );
  const imp = await call(
    "/admin/question-bank/import",
    {
      text: "1. Why do you want to join us?\n2) Where do you see yourself in 5 years?\n- Why do you want to join us?\n",
      category: "behavioural",
    },
    hr,
  );
  assert.deepEqual(imp.data, { added: 2, skipped: 1 });
  assert.equal(
    (await call("/admin/question-bank?department_id=none", undefined, hr)).data
      .length,
    2,
  );
  assert.equal(
    (await call("/admin/question-bank?category=situational", undefined, hr))
      .data.length,
    1,
  );
  const first = (await call("/admin/question-bank?q=graphql", undefined, hr))
    .data[0];
  await call(
    `/admin/question-bank/${first.id}`,
    { active: false },
    hr,
    "PATCH",
  );
  assert.equal(
    (await call("/admin/question-bank?q=graphql", undefined, hr)).data.length,
    0,
  );
  assert.equal(
    (await call("/admin/question-bank?q=graphql&active=all", undefined, hr))
      .data.length,
    1,
  );

  // Schedule a panel for a Credit-department opening.
  const opening = (
    await call(
      "/admin/openings",
      { title: "Credit Officer", department_id: dept },
      hr,
    )
  ).data.id;
  const cand = (
    await call(
      "/admin/candidates",
      { name: "Riya Jain", email: "riya@example.test", opening_id: opening },
      hr,
    )
  ).data.id;
  const mails = [];
  app.notify.mail = async (...a) => (mails.push(a), true);
  const when = new Date(Date.parse("2026-11-10T11:00:00+05:30")).toISOString();
  const sched = await call(
    `/admin/candidates/${cand}/interviews`,
    {
      round_name: "Round 1",
      interviewer_ids: [people.mgr.id, people.emp.id],
      scheduled_at: when,
      mode: "video",
      location: "https://meet.example/abc",
      duration_minutes: 45,
    },
    hr,
  );
  assert.equal(sched.status, 201, JSON.stringify(sched.data));
  assert.equal(sched.data.ids.length, 2);
  assert.equal(sched.data.questions, 5);
  const qs = await db
    .prepare(
      "SELECT interview_id,question,category FROM interview_questions ORDER BY interview_id,position",
    )
    .all();
  assert.equal(qs.length, 10);
  assert.ok(
    !qs.some((q) => /GraphQL/.test(q.question)),
    "inactive / other-department questions are not used",
  );
  assert.ok(new Set(qs.map((q) => q.category)).size >= 3);
  const [a, b] = sched.data.ids;
  assert.deepEqual(
    qs.filter((q) => q.interview_id === a).map((q) => q.question),
    qs.filter((q) => q.interview_id === b).map((q) => q.question),
  );

  // Invitations carry a calendar file for each panelist and the candidate.
  assert.equal(
    mails.filter((m) => m[4]?.[0]?.filename === "interview.ics").length,
    3,
  );
  const ics = Buffer.from(mails[0][4][0].content, "base64").toString();
  assert.match(ics, /BEGIN:VEVENT/);
  assert.match(ics, /DTSTART:20261110T053000Z/);
  assert.match(ics, /DTEND:20261110T061500Z/);

  // The interviewer sees the candidate, questions and panel; others do not.
  const view = await call(`/interviews/${a}`, undefined, people.mgr.token);
  assert.equal(view.status, 200);
  assert.equal(view.data.questions.length, 5);
  assert.equal(view.data.panel.length, 2);
  assert.match(view.data.calendar_link, /calendar\.google\.com/);
  assert.equal(
    (await call(`/interviews/${a}`, undefined, people.pay.token)).status,
    404,
  );
  assert.equal((await call(`/interviews/${a}`, undefined, hr)).status, 200);

  // Timeline then feedback with per-question scores.
  const tl0 = (
    await call(`/admin/candidates/${cand}/interview-timeline`, undefined, hr)
  ).data;
  assert.equal(tl0[0].state, "upcoming");
  const feedback = (id, token, rating, rec) =>
    call(
      `/interviews/${id}/feedback`,
      {
        rating,
        recommendation: rec,
        feedback: "ok",
        scores: view.data.questions.map((q) => ({ id: q.id, rating })),
      },
      token,
    );
  const mine = (await call(`/interviews/${b}`, undefined, people.emp.token))
    .data.questions;
  assert.equal(
    (await feedback(a, people.mgr.token, 5, "strong_yes")).status,
    200,
  );
  assert.equal(
    (
      await call(
        "/admin/candidates/" + cand + "/interview-timeline",
        undefined,
        hr,
      )
    ).data[0].state,
    "partial",
  );
  // Per-question ratings only apply to the caller's own interview questions.
  const r2 = await call(
    `/interviews/${b}/feedback`,
    {
      rating: 1,
      recommendation: "no",
      feedback: "weak",
      scores: mine.map((q) => ({ id: q.id, rating: 1 })),
    },
    people.emp.token,
  );
  assert.equal(r2.status, 200);
  assert.equal(
    (await call(`/admin/candidates/${cand}/interview-timeline`, undefined, hr))
      .data[0].state,
    "complete",
  );

  const card = (
    await call(`/admin/candidates/${cand}/scorecard`, undefined, hr)
  ).data;
  assert.equal(card.rounds[0].avg_rating, 3);
  assert.equal(card.overall_rating, 3);
  assert.equal(card.feedback_given, 2);
  assert.equal(card.summary, "Mixed — discuss before deciding");
  assert.equal(card.question_scores.length, 5);
  assert.equal(card.question_scores[0].avg_rating, 3);

  const an = (await call("/admin/interviews/analytics", undefined, hr)).data;
  assert.equal(an.interviews, 2);
  assert.equal(an.feedback_rate, 100);
  assert.equal(an.departments[0].department, "Credit");
  assert.equal(an.departments[0].avg_rating, 3);
  assert.equal(an.panelists.find((p) => p.name === "MGR").avg_deviation, 4);
  assert.equal(an.questions[0].avg_rating, 3);
  assert.equal(
    (await call("/admin/interviews/analytics", undefined, people.emp.token))
      .status,
    403,
  );
});
