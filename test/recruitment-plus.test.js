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

test("requisitions, careers page, skill match, tracker, templates, offer breakup and analytics", async (t) => {
  const w = await world(t);
  const { call, people, db, app } = w;
  const hr = people.hr.token;
  await db
    .prepare("UPDATE users SET manager_id=? WHERE id=?")
    .run(people.mgr.id, people.emp.id);

  // A manager with reports raises a requisition; HR decides.
  assert.equal(
    (await call("/requisitions", { title: "Clerk" }, people.emp.token)).status,
    403,
  );
  const req = await call(
    "/requisitions",
    {
      title: "Credit Officer",
      positions: 2,
      skills: "Excel, KYC, Tally",
      min_experience_years: 2,
      qualifications: "Graduate",
      salary_min: 300000,
      salary_max: 500000,
      justification: "New branch",
    },
    people.mgr.token,
  );
  assert.equal(req.status, 201, JSON.stringify(req.data));
  assert.equal(req.data.approval_status, "pending_approval");
  const oid = req.data.id;
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/approval`,
        { decision: "approved" },
        people.mgr.token,
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/details`,
        { published: true },
        hr,
        "PATCH",
      )
    ).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/approval`,
        { decision: "rejected" },
        hr,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/approval`,
        { decision: "approved" },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/approval`,
        { decision: "approved" },
        hr,
      )
    ).status,
    409,
  );
  const mine = await call("/requisitions/mine", undefined, people.mgr.token);
  assert.equal(mine.data[0].approval_status, "approved");
  assert.equal(
    (
      await call(
        `/admin/openings/${oid}/details`,
        { published: true, location: "Jaipur" },
        hr,
        "PATCH",
      )
    ).status,
    200,
  );
  const posting = await call(`/admin/openings/${oid}/posting`, undefined, hr);
  assert.match(posting.data.text, /Credit Officer/);
  assert.match(posting.data.text, /careers\.html\?c=\d+&job=/);

  // Public careers page: no login.
  const co = (await db.prepare("SELECT id FROM companies").get()).id;
  const page = await call(`/careers/${co}`);
  assert.equal(page.status, 200);
  assert.equal(page.data.jobs.length, 1);
  assert.equal(page.data.jobs[0].title, "Credit Officer");
  const apply = (extra = {}) =>
    call(`/careers/${co}/apply`, {
      opening_id: oid,
      name: "Riya Jain",
      email: "riya@example.test",
      phone: "9876500001",
      skills: "excel, KYC",
      experience_years: 1,
      qualification: "B.Com",
      resume: { name: "cv", mime: "application/pdf", data: PDF },
      ...extra,
    });
  assert.equal(
    (
      await apply({
        resume: {
          name: "cv",
          mime: "application/pdf",
          data: Buffer.from("nope").toString("base64"),
        },
      })
    ).status,
    400,
  );
  assert.equal((await apply({ opening_id: 99999 })).status, 404);
  const applied = await apply();
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  assert.equal((await apply()).status, 409);
  const cid = applied.data.id;
  const cand = await db.prepare("SELECT * FROM candidates WHERE id=?").get(cid);
  assert.equal(cand.source, "Careers page");
  // 2 of 3 skills (70%) and half the experience (30%): 0.7*0.667 + 0.3*0.5 = 0.617
  assert.equal(cand.match_score, 62);
  assert.equal(
    (
      await db
        .prepare("SELECT COUNT(*) n FROM candidate_files WHERE candidate_id=?")
        .get(cid)
    ).n,
    1,
  );
  const noted = await db
    .prepare(
      "SELECT * FROM notifications WHERE kind='hiring' AND title LIKE 'New application%'",
    )
    .all();
  assert.ok(noted.length >= 1);
  const ev = await db
    .prepare("SELECT kind FROM candidate_events WHERE candidate_id=?")
    .all(cid);
  assert.ok(ev.some((e) => e.kind === "email_not_sent"));

  // Applicant tracker follows the pipeline and never shows internals.
  const trk = (await call(`/careers/track/${applied.data.token}`)).data;
  assert.equal(trk.steps[0].state, "current");
  assert.equal(JSON.stringify(trk).includes("match"), false);
  await call(`/admin/candidates/${cid}/stage`, { stage: "screening" }, hr);
  assert.equal(
    (await call(`/careers/track/${applied.data.token}`)).data.steps[1].state,
    "current",
  );
  assert.equal(
    (await call("/careers/track/not-a-real-token-123456")).status,
    404,
  );
  assert.equal(
    (await call(`/admin/candidates/${cid}/files`, undefined, people.emp.token))
      .status,
    403,
  );
  const files = (await call(`/admin/candidates/${cid}/files`, undefined, hr))
    .data;
  assert.equal(files[0].kind, "resume");

  // Changing the skills needed re-scores everyone.
  await call(
    `/admin/openings/${oid}/details`,
    { skills: "excel, kyc" },
    hr,
    "PATCH",
  );
  assert.equal(
    (await db.prepare("SELECT match_score FROM candidates WHERE id=?").get(cid))
      .match_score,
    85,
  );

  // Templates: defaults, edits, and rendering with variables.
  const tpls = (await call("/admin/recruitment/templates", undefined, hr)).data;
  assert.deepEqual(
    tpls.map((x) => x.key),
    ["acknowledgement", "interview_call", "rejection", "welcome", "offer_sent"],
  );
  assert.equal(
    (
      await call(
        "/admin/recruitment/templates/rejection",
        {
          subject: "Sorry {{name}}",
          body: "About {{position}} at {{company}}",
        },
        hr,
        "PUT",
      )
    ).status,
    200,
  );
  const { candidateMail } =
    await import("../server/routes/recruitment-plus.js");
  let sent;
  const fake = {
    db,
    clock: () => Date.now(),
    notify: { mail: async (...a) => ((sent = a), true) },
  };
  await candidateMail(fake, cand, "rejection");
  assert.equal(sent[2], "Sorry Riya Jain");
  assert.equal(sent[3], "About Credit Officer at Alpha Ltd");
  await call(
    "/admin/recruitment/templates/rejection",
    { subject: "x", body: "y", enabled: false },
    hr,
    "PUT",
  );
  sent = null;
  await candidateMail(fake, cand, "rejection");
  assert.equal(sent, null);

  // Offer with a CTC breakup; sending it issues the joining link.
  await call(`/admin/candidates/${cid}/stage`, { stage: "interview" }, hr);
  const bad = await call(
    `/admin/candidates/${cid}/offers`,
    {
      designation: "Credit Officer",
      monthly_gross: 40000,
      joining_date: "2026-12-01",
      breakup: [{ name: "Basic", monthly: 10000 }],
    },
    hr,
  );
  assert.equal(bad.status, 400);
  const offer = await call(
    `/admin/candidates/${cid}/offers`,
    {
      designation: "Credit Officer",
      monthly_gross: 40000,
      joining_date: "2026-12-01",
      breakup: [
        { name: "Basic", monthly: 24000 },
        { name: "HRA", monthly: 12000 },
        { name: "Conveyance", monthly: 4000 },
      ],
    },
    hr,
  );
  assert.equal(offer.status, 201, JSON.stringify(offer.data));
  const letter = await call(
    `/admin/offers/${offer.data.id}/letter`,
    undefined,
    hr,
  );
  assert.match(letter.data.paragraphs.join(" "), /Conveyance Rs\. 4,000/);
  const sentOffer = await call(
    `/admin/offers/${offer.data.id}/status`,
    { status: "sent" },
    hr,
  );
  assert.match(sentOffer.data.link, /join\.html\?t=/);
  const jt = new URL(sentOffer.data.link, "http://x").searchParams.get("t");
  assert.equal((await call(`/join/${jt}`)).status, 200);
  assert.equal(
    (await call(`/join/${jt}/accept`, { full_name: "Riya Jain" })).status,
    200,
  );
  const hired = await call(
    `/admin/candidates/${cid}/hire`,
    { password: PW, manager_id: people.mgr.id },
    hr,
  );
  assert.equal(hired.status, 201, JSON.stringify(hired.data));

  // Dashboard.
  const an = (await call("/admin/recruitment/analytics", undefined, hr)).data;
  assert.equal(an.funnel.find((f) => f.stage === "Applied").count, 1);
  assert.equal(an.funnel.find((f) => f.stage === "Hired").count, 1);
  assert.equal(an.offer_acceptance_rate, 100);
  assert.equal(an.avg_days_to_hire, 0);
  assert.equal(an.sources[0].source, "Careers page");
  assert.equal(an.sources[0].hired, 1);
  assert.equal(
    (await call("/admin/recruitment/analytics", undefined, people.emp.token))
      .status,
    403,
  );
  void app;
});
