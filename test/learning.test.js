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

const COURSE = {
  lessons: [
    {
      title: "Know your customer",
      kind: "text",
      body: "Verify identity before every loan.",
    },
    { title: "Policy video", kind: "video", body: "https://example.com/video" },
  ],
  questions: [
    {
      question: "When do you verify identity?",
      options: ["Never", "Before every loan", "Sometimes"],
      correct: 1,
      explanation: "Always.",
    },
    { question: "Cash limit?", options: ["Rs 2 lakh", "None"], correct: 0 },
  ],
};

test("a course is built, assigned, learned, quizzed and certified", async (t) => {
  const w = await world(t);
  const { call, people, db } = w;
  const hr = people.hr.token;
  const emp = people.emp.token;
  assert.equal(
    (await call("/admin/trainings", { title: "KYC", kind: "course" }, emp))
      .status,
    403,
  );
  const made = await call(
    "/admin/trainings",
    { title: "KYC basics", kind: "course", hours: 1 },
    hr,
  );
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.assigned, 0);
  const id = made.data.id;
  // Needs content before it can be assigned; bad quiz definitions are refused.
  assert.equal(
    (await call(`/admin/learning/${id}/assign`, {}, hr)).status,
    409,
  );
  const bad = {
    ...COURSE,
    questions: [{ question: "Q", options: ["a", "b"], correct: 5 }],
  };
  assert.equal(
    (await call(`/admin/learning/${id}/content`, bad, hr, "PUT")).status,
    400,
  );
  const badLink = {
    lessons: [{ title: "x", kind: "link", body: "javascript:alert(1)" }],
  };
  assert.equal(
    (await call(`/admin/learning/${id}/content`, badLink, hr, "PUT")).status,
    400,
  );
  assert.equal(
    (await call(`/admin/learning/${id}/content`, COURSE, hr, "PUT")).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/learning/${id}`,
        { max_attempts: 2, pass_mark: 100 },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/learning/${id}/assign`,
        { user_ids: [people.emp.id] },
        hr,
      )
    ).data.assigned,
    1,
  );
  assert.equal(
    (
      await call(
        `/admin/learning/${id}/assign`,
        { user_ids: [people.emp.id] },
        hr,
      )
    ).data.assigned,
    0,
  );

  const mine = (await call("/trainings/mine", undefined, emp)).data[0];
  assert.equal(mine.kind, "course");
  const rid = mine.id;
  const view = await call(`/learning/${rid}`, undefined, emp);
  assert.equal(view.data.lessons.length, 2);
  assert.ok(!JSON.stringify(view.data.questions).includes("correct"));
  // Others cannot open or complete it; the learner cannot just tick it off.
  assert.equal(
    (await call(`/learning/${rid}`, undefined, people.mgr.token)).status,
    404,
  );
  assert.equal(
    (await call(`/trainings/records/${rid}/complete`, {}, emp)).status,
    403,
  );
  // Quiz is locked until every lesson is read.
  assert.equal(
    (await call(`/learning/${rid}/quiz`, { answers: [1, 0] }, emp)).status,
    409,
  );
  for (const l of view.data.lessons)
    assert.equal(
      (await call(`/learning/${rid}/lessons/${l.id}/done`, {}, emp)).status,
      200,
    );
  // Wrong answer fails (pass mark 100), attempts run out, HR resets them.
  const fail = await call(`/learning/${rid}/quiz`, { answers: [1, 1] }, emp);
  assert.equal(fail.data.passed, false);
  assert.deepEqual(fail.data.correct, [true, false]);
  assert.equal(fail.data.attempts_left, 1);
  assert.equal(fail.data.explanations, undefined);
  assert.equal(
    (await call(`/learning/${rid}/quiz`, { answers: [0] }, emp)).status,
    400,
  );
  assert.equal(
    (await call(`/learning/${rid}/quiz`, { answers: [0, 1] }, emp)).data
      .attempts_left,
    0,
  );
  assert.equal(
    (await call(`/learning/${rid}/quiz`, { answers: [1, 0] }, emp)).status,
    409,
  );
  assert.equal(
    (await call(`/admin/trainings/records/${rid}/reset`, {}, emp)).status,
    403,
  );
  assert.equal(
    (await call(`/admin/trainings/records/${rid}/reset`, {}, hr)).status,
    200,
  );
  const pass = await call(`/learning/${rid}/quiz`, { answers: [1, 0] }, emp);
  assert.equal(pass.data.passed, true);
  assert.equal(pass.data.explanations[0], "Always.");
  const done = (await call("/trainings/mine", undefined, emp)).data[0];
  assert.equal(done.status, "completed");
  assert.equal(done.score, 100);
  const cert = await call(
    `/trainings/records/${rid}/certificate`,
    undefined,
    emp,
  );
  assert.equal(cert.status, 200);
  assert.match(cert.data.paragraphs[0], /KYC basics/);
  assert.equal(
    (
      await call(
        `/trainings/records/${rid}/certificate`,
        undefined,
        people.mgr.token,
      )
    ).status,
    404,
  );
  assert.equal(
    (await call(`/trainings/records/${rid}/certificate`, undefined, hr)).status,
    200,
  );
  // Once people have started, the content is locked.
  assert.equal(
    (await call(`/admin/learning/${id}/content`, COURSE, hr, "PUT")).status,
    409,
  );
  assert.equal(
    (await db.prepare("SELECT COUNT(*) n FROM training_attempts").get()).n,
    3,
  );
});

test("a course without a quiz completes when the last lesson is read; new joiners get auto-assigned courses; reminders fire once", async (t) => {
  const w = await world(t);
  const { call, people, db, app, setNow } = w;
  const hr = people.hr.token;
  const made = await call(
    "/admin/trainings",
    { title: "Fire safety", kind: "course", mandatory: true },
    hr,
  );
  const id = made.data.id;
  await call(
    `/admin/learning/${id}/content`,
    { lessons: [{ title: "Exits", kind: "text", body: "Know your exits." }] },
    hr,
    "PUT",
  );
  await call(
    `/admin/learning/${id}`,
    { auto_assign: true, due_days: 10 },
    hr,
    "PATCH",
  );
  // Hire someone: the course is assigned with a due date 10 days after joining.
  const c = await call(
    "/admin/candidates",
    { name: "Neel Shah", email: "neel@example.test" },
    hr,
  );
  const o = await call(
    `/admin/candidates/${c.data.id}/offers`,
    { designation: "Clerk", monthly_gross: 20000, joining_date: "2026-11-20" },
    hr,
  );
  await call(`/admin/offers/${o.data.id}/status`, { status: "sent" }, hr);
  await call(`/admin/offers/${o.data.id}/status`, { status: "accepted" }, hr);
  const hired = await call(
    `/admin/candidates/${c.data.id}/hire`,
    { password: PW },
    hr,
  );
  assert.equal(hired.status, 201, JSON.stringify(hired.data));
  const rec = await db
    .prepare("SELECT * FROM training_records WHERE user_id=?")
    .get(hired.data.user_id);
  assert.equal(rec.training_id, id);
  assert.equal(rec.due_date, "2026-11-30");

  const { sendTrainingReminders } =
    await import("../server/routes/learning.js");
  assert.equal(await sendTrainingReminders(app), 0);
  setNow("2026-11-28T10:00:00+05:30");
  assert.equal(await sendTrainingReminders(app), 1);
  assert.equal(await sendTrainingReminders(app), 0);
  const notes = await db
    .prepare(
      "SELECT title FROM notifications WHERE user_id=? AND kind='training'",
    )
    .all(hired.data.user_id);
  assert.ok(notes.some((n) => /Due 2026-11-30/.test(n.title)));

  // Reading the only lesson completes a quiz-less course.
  await call(
    "/admin/learning/" + id + "/assign",
    { user_ids: [people.emp.id] },
    hr,
  );
  const mine = (await call("/trainings/mine", undefined, people.emp.token))
    .data[0];
  const lessons = (
    await call(`/learning/${mine.id}`, undefined, people.emp.token)
  ).data.lessons;
  const r = await call(
    `/learning/${mine.id}/lessons/${lessons[0].id}/done`,
    {},
    people.emp.token,
  );
  assert.equal(r.data.completed, true);
  assert.equal(
    (await call("/trainings/mine", undefined, people.emp.token)).data[0].status,
    "completed",
  );
});

test("classroom sessions: scheduled, invited, attended, and the training completes", async (t) => {
  const w = await world(t);
  const { call, people, db, setNow } = w;
  const hr = people.hr.token;
  // A tracked training assigned to everyone; MGR has already done it.
  const tr = await call("/admin/trainings", { title: "Fire drill", hours: 2, mandatory: true }, hr);
  assert.equal(tr.status, 201, JSON.stringify(tr.data));
  await db.prepare("UPDATE training_records SET status='completed',completed_on='2026-10-01' WHERE training_id=? AND user_id=?").run(tr.data.id, people.mgr.id);

  const base = { training_id: tr.data.id, trainer: "Safety officer", venue: "Jaipur HO, 2nd floor", starts_at: "2026-11-12T10:00", ends_at: "2026-11-12T12:00" };
  assert.equal((await call("/admin/training-sessions", base, people.emp.token)).status, 403);
  assert.equal((await call("/admin/training-sessions", { ...base, starts_at: "2026-11-01T10:00", ends_at: "2026-11-01T11:00" }, hr)).status, 400, "in the past");
  assert.equal((await call("/admin/training-sessions", { ...base, ends_at: "2026-11-12T09:00" }, hr)).status, 400);
  assert.equal((await call("/admin/training-sessions", { ...base, starts_at: "12/11/2026" }, hr)).status, 400);
  const s = await call("/admin/training-sessions", base, hr);
  assert.equal(s.status, 201, JSON.stringify(s.data));
  assert.equal(s.data.invited, 3, "everyone with the training still to do: HR, payroll and EMP");
  const detail = (await call(`/admin/training-sessions/${s.data.id}`, undefined, hr)).data;
  assert.equal(detail.title, "Fire drill", "takes the training's title");
  assert.equal(detail.starts_at, "2026-11-12T04:30:00.000Z", "IST to UTC");
  assert.ok(!detail.attendees.some((a) => a.user_id === people.mgr.id), "MGR already did it");
  const note = await db.prepare("SELECT title FROM notifications WHERE user_id=? ORDER BY id DESC").get(people.emp.id);
  assert.match(note.title, /Training session: Fire drill/);

  // Capacity, extra invites, the employee's view.
  const small = (await call("/admin/training-sessions", { title: "Excel basics", starts_at: "2026-11-20T15:00", ends_at: "2026-11-20T16:00", capacity: 1, user_ids: [people.emp.id] }, hr)).data.id;
  assert.equal((await call(`/admin/training-sessions/${small}/invite`, { user_ids: [people.mgr.id] }, hr)).status, 409, "full");
  assert.equal((await call(`/admin/training-sessions/${s.data.id}/invite`, { user_ids: [people.mgr.id] }, hr)).data.invited, 1);
  const mine = (await call("/training-sessions/mine", undefined, people.emp.token)).data;
  assert.deepEqual(mine.upcoming.map((x) => x.title), ["Fire drill", "Excel basics"]);
  assert.equal((await call("/admin/training-sessions", undefined, hr)).data.length, 2);

  // Attendance only once it has started; it completes the training for those who came.
  const marks = [{ user_id: people.emp.id, attended: true }, { user_id: people.pay.id, attended: false }];
  assert.equal((await call(`/admin/training-sessions/${s.data.id}/attendance`, { marks }, hr)).status, 409);
  assert.equal((await call(`/admin/training-sessions/${small}/cancel`, { reason: "Trainer unwell" }, hr)).status, 200);
  setNow("2026-11-12T13:00:00+05:30");
  assert.equal((await call(`/admin/training-sessions/${s.data.id}/attendance`, { marks: [{ user_id: people.hr.id, attended: true }] }, hr)).status, 403, "not your own");
  assert.equal((await call(`/admin/training-sessions/${s.data.id}/attendance`, { marks: [{ user_id: people.mgr.id + 999, attended: true }] }, hr)).status, 400);
  const done = await call(`/admin/training-sessions/${s.data.id}/attendance`, { marks }, hr);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.completed, 1);
  const rec = await db.prepare("SELECT status,completed_on FROM training_records WHERE training_id=? AND user_id=?").get(tr.data.id, people.emp.id);
  assert.deepEqual([rec.status, rec.completed_on], ["completed", "2026-11-12"]);
  assert.equal((await db.prepare("SELECT status FROM training_records WHERE training_id=? AND user_id=?").get(tr.data.id, people.pay.id)).status, "assigned");
  const after = (await call("/training-sessions/mine", undefined, people.emp.token)).data;
  assert.deepEqual(after.past.map((x) => [x.title, x.status, x.attendance]), [["Excel basics", "cancelled", "invited"], ["Fire drill", "completed", "attended"]]);
  assert.equal((await call("/admin/training-sessions?when=past", undefined, hr)).data.length, 1);
});
