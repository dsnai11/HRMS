import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { datesIn, nextPayday } from "../server/bot.js";

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
  await add("other");
  // emp and other report to mgr
  await db
    .prepare("UPDATE users SET manager_id=? WHERE id IN (?,?)")
    .run(people.mgr.id, people.emp.id, people.other.id);
  return {
    db,
    call,
    owner,
    people,
    app,
    setNow: (iso) => (nowMs = Date.parse(iso)),
  };
}

test("dates and paydays are read the way people write them", () => {
  const today = "2026-11-05"; // a Thursday
  assert.deepEqual(datesIn("apply casual leave on 12 Nov", today), [
    "2026-11-12",
  ]);
  assert.deepEqual(datesIn("leave from 2026-11-12 to 2026-11-14", today), [
    "2026-11-12",
    "2026-11-14",
  ]);
  assert.deepEqual(datesIn("leave tomorrow", today), ["2026-11-06"]);
  assert.deepEqual(datesIn("day after tomorrow please", today), [
    "2026-11-07",
  ]);
  assert.deepEqual(datesIn("sick leave on monday", today), ["2026-11-09"]);
  assert.deepEqual(datesIn("leave on thursday", today), ["2026-11-12"]);
  assert.deepEqual(datesIn("leave on 3/12", today), ["2026-12-03"]);
  assert.deepEqual(datesIn("Jan 4 and 5th jan", today), [
    "2027-01-04",
    "2027-01-05",
  ]);
  assert.deepEqual(datesIn("31/02/2026 or 30 feb", today), []);
  assert.deepEqual(datesIn("what is my leave balance", today), []);
  assert.equal(nextPayday("2026-11-05", 7), "2026-11-07");
  assert.equal(nextPayday("2026-11-08", 7), "2026-12-07");
  assert.equal(nextPayday("2026-11-05", 31), "2026-11-30");
  assert.equal(nextPayday("2026-12-31", 31), "2026-12-31");
  assert.equal(nextPayday("2027-02-01", 30), "2027-02-28");
});

test("internal chat: direct and group conversations, unread counts, polling, privacy", async (t) => {
  const { call, people } = await world(t);
  const emp = people.emp.token,
    mgr = people.mgr.token,
    hr = people.hr.token,
    other = people.other.token;

  // People search shows colleagues, never the caller.
  const found = (await call("/chat/people?q=mg", undefined, emp)).data;
  assert.deepEqual(
    found.map((p) => p.name),
    ["MGR"],
  );
  assert.ok(
    !(await call("/chat/people", undefined, emp)).data.some(
      (p) => p.id === people.emp.id,
    ),
  );

  // The first poll only says where things stand.
  const first = (await call("/chat/updates", undefined, mgr)).data;
  assert.deepEqual(first, { messages: [], unread: 0, latest: 0 });

  // A direct conversation is created once and reused from either side.
  const room = (await call("/chat/direct", { user_id: people.mgr.id }, emp))
    .data.id;
  assert.equal(
    (await call("/chat/direct", { user_id: people.emp.id }, mgr)).data.id,
    room,
  );
  assert.equal(
    (await call("/chat/direct", { user_id: people.emp.id }, emp)).status,
    400,
  );
  const sent = await call(
    `/chat/rooms/${room}/messages`,
    { body: "  Can we meet at 3?  " },
    emp,
  );
  assert.equal(sent.status, 201);
  assert.equal(
    (await call(`/chat/rooms/${room}/messages`, { body: "   " }, emp)).status,
    400,
  );

  const upd = (await call(`/chat/updates?since=${first.latest}`, undefined, mgr))
    .data;
  assert.equal(upd.messages.length, 1);
  assert.equal(upd.messages[0].body, "Can we meet at 3?");
  assert.equal(upd.messages[0].author, "EMP");
  assert.equal(upd.unread, 1);
  assert.equal(upd.latest, sent.data.id);
  // Nothing new since then; the sender has nothing unread.
  assert.equal(
    (await call(`/chat/updates?since=${upd.latest}`, undefined, mgr)).data
      .messages.length,
    0,
  );
  assert.equal((await call("/chat/updates", undefined, emp)).data.unread, 0);

  const rooms = (await call("/chat/rooms", undefined, mgr)).data;
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].title, "EMP");
  assert.equal(Number(rooms[0].unread), 1);
  assert.equal(rooms[0].last_body, "Can we meet at 3?");

  await call(`/chat/rooms/${room}/read`, { message_id: sent.data.id }, mgr);
  assert.equal((await call("/chat/updates", undefined, mgr)).data.unread, 0);

  // Outsiders cannot see the conversation or post in it.
  assert.equal(
    (await call(`/chat/rooms/${room}/messages`, undefined, hr)).status,
    404,
  );
  assert.equal(
    (await call(`/chat/rooms/${room}/messages`, { body: "hi" }, hr)).status,
    404,
  );
  assert.equal(
    (await call(`/chat/updates?since=0`, undefined, hr)).data.messages.length,
    0,
  );

  // Only the author can delete; deleted messages disappear.
  const oops = (
    await call(`/chat/rooms/${room}/messages`, { body: "wrong chat" }, emp)
  ).data.id;
  assert.equal(
    (await call(`/chat/messages/${oops}`, undefined, mgr, "DELETE")).status,
    404,
  );
  assert.equal(
    (await call(`/chat/messages/${oops}`, undefined, emp, "DELETE")).status,
    200,
  );
  assert.deepEqual(
    (await call(`/chat/rooms/${room}/messages`, undefined, mgr)).data.messages.map(
      (m) => m.body,
    ),
    ["Can we meet at 3?"],
  );
  assert.equal(
    (await call(`/chat/rooms/${room}/members/${people.emp.id}`, undefined, emp, "DELETE"))
      .status,
    409,
  );

  // Groups: managers and HR create them, ordinary employees do not.
  assert.equal(
    (
      await call(
        "/chat/groups",
        { name: "Mine", member_ids: [people.other.id] },
        emp,
      )
    ).status,
    403,
  );
  const group = await call(
    "/chat/groups",
    { name: "Branch team", member_ids: [people.emp.id, people.other.id] },
    mgr,
  );
  assert.equal(group.status, 201, JSON.stringify(group.data));
  const gid = group.data.id;
  assert.equal(
    (await call(`/chat/rooms/${gid}/members`, { user_ids: [people.hr.id] }, emp))
      .status,
    403,
  );
  assert.equal(
    (await call(`/chat/rooms/${gid}/members`, { user_ids: [] }, mgr)).status,
    400,
  );
  assert.equal(
    (await call(`/chat/rooms/${gid}/members`, { user_ids: [people.hr.id] }, mgr))
      .status,
    200,
  );
  const info = (await call(`/chat/rooms/${gid}`, undefined, hr)).data;
  assert.equal(info.name, "Branch team");
  assert.deepEqual(
    info.members.map((m) => m.name),
    ["EMP", "HR", "MGR", "OTHER"],
  );
  await call(`/chat/rooms/${gid}/messages`, { body: "Hello team" }, mgr);
  const hrSeen = (await call("/chat/updates?since=0", undefined, hr)).data;
  assert.equal(hrSeen.messages.at(-1).room_name, "Branch team");
  assert.equal(hrSeen.unread, 1);

  // Leaving a group ends access to it.
  assert.equal(
    (
      await call(
        `/chat/rooms/${gid}/members/${people.other.id}`,
        undefined,
        other,
        "DELETE",
      )
    ).status,
    200,
  );
  assert.equal(
    (await call(`/chat/rooms/${gid}/messages`, undefined, other)).status,
    404,
  );
  // A non-admin cannot remove someone else.
  assert.equal(
    (
      await call(
        `/chat/rooms/${gid}/members/${people.hr.id}`,
        undefined,
        emp,
        "DELETE",
      )
    ).status,
    403,
  );
});

test("Laxmi: rules answer from the asker's own records, guided leave ends in the normal leave request", async (t) => {
  const { call, people, db, owner } = await world(t);
  const hr = people.hr.token,
    emp = people.emp.token,
    mgr = people.mgr.token;
  const ask = async (question, token = emp) => {
    const r = await call("/bot/ask", { question }, token);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data;
  };
  await call("/admin/leave-types/seed-defaults", {}, hr);
  const types = (await call("/admin/leave-types", undefined, hr)).data;
  const cl = types.find((x) => x.code === "CL");

  assert.equal((await ask("hello")).intent, "help");

  const bal = await ask("What is my leave balance?");
  assert.equal(bal.intent, "leave_balance");
  assert.match(bal.text, /Casual Leave: [\d.]+ day\(s\) available/);
  assert.match(bal.text, /Leave Without Pay: no limit/);

  // Guided leave: the bot fills in the request; the person confirms it through
  // the ordinary leave API.
  const draft = await ask("apply casual leave on 12 Nov because family function");
  assert.equal(draft.intent, "leave_apply");
  assert.equal(draft.action.type, "leave_request");
  assert.equal(draft.action.leave_type_id, cl.id);
  assert.equal(draft.action.from_date, "2026-11-12");
  assert.equal(draft.action.to_date, "2026-11-12");
  assert.equal(draft.action.reason, "family function");
  assert.ok(draft.action.options.some((o) => o.name === "Casual Leave"));
  const { leave_type_id, from_date, to_date, half_day, reason } = draft.action;
  const made = await call(
    "/leave/requests",
    { leave_type_id, from_date, to_date, half_day, reason },
    emp,
  );
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.match((await ask("how many leaves do I have left")).text, /1 pending approval/);

  const range = await ask("leave from 2026-11-16 to 2026-11-18");
  assert.equal(range.action.leave_type_id, null);
  assert.equal(range.action.to_date, "2026-11-18");
  assert.equal((await ask("sick leave tomorrow half day")).action.half_day, "first");
  assert.equal((await ask("I want to apply for leave")).action, null);

  // Holidays
  await call(
    "/admin/holidays",
    { items: [{ date: "2026-11-14", name: "Diwali" }] },
    hr,
  );
  const hol = await ask("Which holidays are coming up?");
  assert.equal(hol.intent, "holidays");
  assert.match(hol.text, /14 Nov 2026: Diwali/);

  // Payday, set by HR
  assert.match((await ask("When is payday?")).text, /not set a pay day/);
  assert.equal(
    (await call("/admin/bot/settings", { pay_day: 31 }, emp, "PUT")).status,
    403,
  );
  assert.equal(
    (await call("/admin/bot/settings", { pay_day: 0 }, hr, "PUT")).status,
    400,
  );
  assert.equal(
    (await call("/admin/bot/settings", { pay_day: 31 }, hr, "PUT")).status,
    200,
  );
  assert.deepEqual((await call("/admin/bot/settings", undefined, hr)).data, {
    pay_day: 31,
    ai_fallback: false,
  });
  assert.match((await ask("when will my salary be credited")).text, /30 Nov 2026/);

  // Payslip
  assert.match((await ask("show my payslip")).text, /no payslips yet/);
  const run = Number(
    (
      await db
        .prepare(
          "INSERT INTO payroll_runs(company_id,month,status,created_at,paid_on) VALUES((SELECT company_id FROM users WHERE id=?),'2026-10','paid','2026-10-31T00:00:00Z','2026-10-31')",
        )
        .run(people.emp.id)
    ).lastInsertRowid,
  );
  await db
    .prepare(
      "INSERT INTO payroll_items(run_id,company_id,user_id,gross,deductions,net,employer_cost,paid_days,lop_days,taxable_earnings,data) VALUES(?,(SELECT company_id FROM users WHERE id=?),?,50000,5000,45000,52000,31,0,50000,'{}')",
    )
    .run(run, people.emp.id, people.emp.id);
  const slip = await ask("what was my take home last month?");
  assert.equal(slip.intent, "payslip");
  assert.match(slip.text, /October 2026.*net pay ₹45,000/);
  assert.match((await ask("payday?")).text, /October 2026, was paid on Sat 31 Oct 2026/);
  // Someone else's payslip never leaks.
  assert.match((await ask("show my payslip", mgr)).text, /no payslips yet/);

  // Attendance
  const att = await ask("my attendance this month");
  assert.equal(att.intent, "attendance");
  assert.match(att.text, /November 2026/);

  // Team questions: managers see their team; others are told no.
  await call(
    "/leave/requests",
    { leave_type_id: cl.id, from_date: "2026-11-05", to_date: "2026-11-05" },
    people.other.token,
  );
  const pending = (await call("/admin/leave/requests?status=pending", undefined, hr))
    .data.items;
  const today = pending.find((r) => r.from_date === "2026-11-05");
  assert.equal(
    (await call(`/leave/requests/${today.id}/decision`, { decision: "approved" }, mgr))
      .status,
    200,
  );
  const teamA = await ask("who in my team is on leave today?", mgr);
  assert.equal(teamA.intent, "team");
  assert.match(teamA.text, /Your team today \(2 people\)/);
  assert.match(teamA.text, /On approved leave: OTHER/);
  assert.match(teamA.text, /Waiting for your approval: 1 item/);
  assert.match((await ask("who in my team is on leave today?")).text, /for managers/);

  // Leave history and training completion, only the asker's own (Bot-03).
  const hist = await ask("show my leave history");
  assert.equal(hist.intent, "leave_history");
  assert.match(hist.text, /12 Nov: Casual Leave, 1 day, waiting for approval/);
  assert.match(hist.text, /1 request still waiting for approval/);
  assert.equal((await ask("what is the status of my leave?")).intent, "leave_history");
  assert.doesNotMatch((await ask("my leave history", people.other.token)).text, /12 Nov/);
  assert.match((await ask("my training")).text, /No training has been assigned/);
  const course = async (title, extra) =>
    Number(
      (
        await db
          .prepare(
            `INSERT INTO trainings(company_id,title,mandatory,due_date,created_at) VALUES((SELECT company_id FROM users WHERE id=?),?,?,?,'2026-10-01')`,
          )
          .run(people.emp.id, title, extra.mandatory ?? 0, extra.due ?? null)
      ).lastInsertRowid,
    );
  const kyc = await course("KYC basics", { mandatory: 1, due: "2026-10-30" });
  const posh = await course("POSH awareness", {});
  await db.prepare("INSERT INTO training_records(training_id,user_id) VALUES(?,?)").run(kyc, people.emp.id);
  await db
    .prepare("INSERT INTO training_records(training_id,user_id,status,completed_on,score) VALUES(?,?,'completed','2026-10-20',90)")
    .run(posh, people.emp.id);
  const tr = await ask("which courses have I completed?");
  assert.equal(tr.intent, "training");
  assert.match(tr.text, /completed 1 of 2 courses/);
  assert.match(tr.text, /KYC basics \(mandatory\): to do, due 30 Oct \(overdue\)/);
  assert.match(tr.text, /POSH awareness: completed on 20 Oct, score 90%/);

  // Super administrators have no personal records to answer from.
  assert.equal((await call("/bot/ask", { question: "hello" }, owner)).status, 403);
  assert.equal((await call("/bot/ask", { question: "" }, emp)).status, 400);
});

test("Laxmi: knowledge base and policies, the question log, feedback, and the grounded fallback", async (t) => {
  const w = await world(t);
  const { call, people, app } = w;
  const hr = people.hr.token,
    emp = people.emp.token;
  const ask = async (question, token = emp) =>
    (await call("/bot/ask", { question }, token)).data;

  assert.equal(
    (
      await call(
        "/admin/bot/knowledge",
        { title: "Travel", body: "x" },
        emp,
      )
    ).status,
    403,
  );
  const k = await call(
    "/admin/bot/knowledge",
    {
      title: "Travel reimbursement",
      body: "Submit travel claims within 30 days with bills attached, under Claims & loans.",
      keywords: "travel, expenses, claim, cab, train",
    },
    hr,
  );
  assert.equal(k.status, 201);
  await call(
    "/admin/policies",
    {
      title: "Dress code",
      body: "Business casual from Monday to Friday. Formal wear for client meetings.",
    },
    hr,
  );

  const travel = await ask("How do I claim my cab expenses?");
  assert.equal(travel.source, "knowledge");
  assert.match(travel.text, /within 30 days/);
  const dress = await ask("what should I wear, is there a dress code?");
  assert.equal(dress.source, "policy");
  assert.deepEqual(dress.links, ["policies"]);

  // Switched off, an answer is no longer used.
  await call(
    `/admin/bot/knowledge/${k.data.id}`,
    { active: false },
    hr,
    "PATCH",
  );
  const off = await ask("How do I claim my cab expenses?");
  assert.equal(off.answered, false);
  assert.match(off.text, /Helpdesk/);

  // Feedback is the asker's own; HR sees what went unanswered.
  assert.equal(
    (await call(`/bot/log/${off.id}/feedback`, { helpful: false }, emp)).status,
    200,
  );
  assert.equal(
    (await call(`/bot/log/${off.id}/feedback`, { helpful: true }, people.mgr.token))
      .status,
    404,
  );
  const log = (await call("/admin/bot/log?unanswered=1", undefined, hr)).data;
  assert.equal(log.items.length, 1);
  assert.equal(log.items[0].question, "How do I claim my cab expenses?");
  assert.equal(log.items[0].employee_name, "EMP");
  assert.equal(log.last_30_days.questions, 3);
  assert.equal(log.last_30_days.unanswered, 1);
  assert.equal((await call("/admin/bot/log", undefined, emp)).status, 403);
  const history = (await call("/bot/history", undefined, emp)).data;
  assert.equal(history.length, 3);
  assert.equal(history.at(-1).helpful, 0);
  assert.equal((await call("/bot/history", undefined, hr)).data.length, 0);

  // The fallback sees only the asker's facts plus matching company guidance.
  let seen;
  app.botLlm = async (input) => {
    seen = input;
    return "Formal wear is expected for client meetings.";
  };
  const ai = await ask("Do I need a suit when a customer visits our dress code?");
  assert.equal(ai.source, "ai");
  assert.equal(ai.text, "Formal wear is expected for client meetings.");
  assert.equal(seen.facts.name, "EMP");
  assert.equal(seen.facts.today, "2026-11-05");
  assert.ok(Array.isArray(seen.facts.leave_balances));
  assert.equal(seen.extracts[0].title, "Dress code");
  const everything = JSON.stringify(seen);
  for (const name of ["MGR", "OTHER", "HR", "mgr@example.test"])
    assert.ok(!everything.includes(name), `fallback saw ${name}`);
  // Rules still come first.
  seen = null;
  assert.equal((await ask("leave balance")).source, "rules");
  assert.equal(seen, null);
  // A failing or declining fallback falls back to the knowledge base.
  app.botLlm = async () => {
    throw new Error("network down");
  };
  assert.equal((await ask("is there a dress code?")).source, "policy");
  app.botLlm = async () => null;
  assert.equal((await ask("tell me a joke")).answered, false);

  assert.equal(
    (await call(`/admin/bot/knowledge/${k.data.id}`, undefined, hr, "DELETE"))
      .status,
    200,
  );
  assert.equal((await call("/admin/bot/knowledge", undefined, hr)).data.length, 0);
});

test("HR guide: only the HR team can read it, and Laxmi answers them from it", async (t) => {
  const w = await world(t);
  const { call, people, owner, app } = w;
  const ask = async (question, token) =>
    (await call("/bot/ask", { question }, token)).data;

  // Employees and managers get neither the page nor guide answers.
  for (const key of ["emp", "mgr"]) {
    assert.equal((await call("/hr-guide", undefined, people[key].token)).status, 403);
    const a = await ask("How do I run monthly payroll?", people[key].token);
    assert.notEqual(a.source, "guide");
    assert.doesNotMatch(a.text, /HR guide/);
  }

  // HR, payroll and the owner can read it.
  for (const token of [people.hr.token, people.pay.token, owner]) {
    const g = await call("/hr-guide", undefined, token);
    assert.equal(g.status, 200);
    assert.ok(g.data.length >= 20);
    assert.ok(g.data.every((x) => x.title && x.area && x.steps.length));
  }

  const payroll = await ask("How do I run monthly payroll?", people.hr.token);
  assert.equal(payroll.source, "guide");
  assert.match(payroll.text, /^HR guide: Run monthly payroll/);
  assert.match(payroll.text, /1\. /);
  assert.deepEqual(payroll.links, ["hrguide"]);
  const phone = await ask("how to approve a new phone", people.pay.token);
  assert.match(phone.text, /Approve an employee's phone/);
  // HR's own questions still come from their own records first.
  assert.equal((await ask("what is my leave balance", people.hr.token)).source, "rules");

  // A custom role with any right counts as HR team.
  const role = await call(
    "/admin/roles",
    { name: "Desk", permissions: ["helpdesk.manage"] },
    owner,
  );
  assert.equal(role.status, 201, JSON.stringify(role.data));
  await setCustomRole(app, people.other.id, role.data.id);
  assert.equal((await call("/hr-guide", undefined, people.other.token)).status, 200);

  // The guide reaches the Claude fallback only for the HR team.
  const seen = [];
  app.botLlm = async (x) => {
    seen.push(x);
    return "Use the steps.";
  };
  await ask("what happens with payroll runs", people.hr.token);
  await ask("what happens with payroll runs", people.emp.token);
  assert.equal(seen[0].hrTeam, true);
  assert.ok(seen[0].extracts.some((e) => e.kind === "guide"));
  assert.equal(seen[1].hrTeam, false);
  assert.ok(!seen[1].extracts.some((e) => e.kind === "guide"));
});

async function setCustomRole(app, userId, roleId) {
  await app.db
    .prepare("UPDATE users SET role='custom',custom_role_id=? WHERE id=?")
    .run(roleId, userId);
}
