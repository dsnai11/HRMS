import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const IST = (local) => Date.parse(`${local}+05:30`);

async function world(t, nowMs = IST("2026-11-09T10:00:00")) {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => nowMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
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
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  // Web sign-in (cookie) is not needed: employees sign in on a phone with a device.
  const person = async (name, extra = {}) => {
    const email = `${name.toLowerCase()}@example.test`;
    const id = (await call("/admin/employees", { name, email, password: PW, ...extra }, admin)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const token = (
      await call("/login", { email, password: PW, native: true, device: { id: `${name.toLowerCase()}-phone-000000001`, platform: "android", model: "Pixel" } })
    ).data.token;
    return { id, token };
  };
  return { db, app, call, admin, person };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n").toString("base64");

test("ATS score: job description words, qualification level and screening count", async () => {
  const { atsScore, degreeLevel } = await import("../server/ats.js");
  assert.equal(degreeLevel("MBA in finance"), 5);
  assert.equal(degreeLevel("B.Com graduate"), 4);
  assert.equal(degreeLevel("12th pass"), 2);
  const job = {
    title: "Accounts Executive",
    description: "GST filing, TDS returns, bank reconciliation and Tally entries for branches",
    qualifications: "Graduate",
    skills: JSON.stringify(["tally", "gst"]),
    min_experience_years: 2,
    screening: JSON.stringify([{ id: "s1", type: "yes_no", text: "Can you join in 30 days?", knockout: { equals: "no" } }]),
  };
  const strong = atsScore(job, {
    skills: "[]",
    experience_years: 3,
    qualification: "M.Com",
    resume_text: "Accounts executive. Tally ERP, GST filing, TDS returns, bank reconciliation for branches.",
    screening: JSON.stringify({ answers: { s1: "yes" }, failed: [] }),
  });
  const weak = atsScore(job, { skills: "[]", experience_years: 0, qualification: "12th", resume_text: "Sales and marketing, field visits.", screening: JSON.stringify({ answers: { s1: "yes" }, failed: [] }) });
  assert.deepEqual(strong.parts.map((p) => p.key), ["skills", "experience", "jd_keywords", "qualification", "screening"]);
  // Skills found in the resume text count even when not typed in.
  assert.equal(strong.parts[0].got, 1);
  assert.ok(strong.score >= 85, String(strong.score));
  assert.ok(weak.score < 30, String(weak.score));
  assert.equal(weak.parts.find((p) => p.key === "qualification").detail, "lower than asked");
  // Nothing to compare: no score.
  assert.equal(atsScore({ skills: "[]" }, { skills: "[]" }), null);
});

test("apply link: a new opening is public at once; hiring manager and department head see applicants", async (t) => {
  const { db, call, admin, person } = await world(t);
  const head = await person("Meera");
  const boss = await person("Arun");
  const other = await person("Kiran");
  const hrPerson = await person("Nisha", { role: "hr" });
  const dep = (await db.prepare("INSERT INTO departments(company_id,name,head_id,created_at) VALUES(1,'Accounts',?,?) RETURNING id").get(head.id, new Date().toISOString())).id;

  const created = await call(
    "/admin/openings",
    { title: "Accounts Executive", department_id: dep, hiring_manager_id: boss.id, description: "Tally, GST and TDS work", skills: "tally, gst", qualifications: "Graduate", min_experience_years: 1 },
    admin,
  );
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const jobId = created.data.id;
  // On the careers page straight away: the link careers.html?c=1&job=<id> works.
  const careers = (await call("/careers/1")).data;
  assert.ok(careers.jobs.some((j) => j.id === jobId));
  // HR can still create one that is not public.
  const hidden = (await call("/admin/openings", { title: "Internal role", published: false }, admin)).data.id;
  assert.ok(!(await call("/careers/1")).data.jobs.some((j) => j.id === hidden));

  const applied = await call("/careers/1/apply", {
    opening_id: jobId,
    name: "Asha Rao",
    email: "asha@mail.test",
    phone: "9876543210",
    skills: "Tally",
    experience_years: 2,
    qualification: "B.Com",
    resume: { name: "asha-cv.pdf", mime: "application/pdf", data: PDF },
  });
  assert.equal(applied.status, 201, JSON.stringify(applied.data));
  const cand = await db.prepare("SELECT * FROM candidates WHERE id=?").get(applied.data.id);
  assert.ok(cand.match_score > 0);
  assert.ok(JSON.parse(cand.match_detail).some((p) => p.key === "qualification"));

  // The department head and the hiring manager were told, and both see the applicant.
  for (const who of [head, boss]) {
    const n = await db.prepare("SELECT title,link FROM notifications WHERE user_id=? ORDER BY id DESC").get(who.id);
    assert.match(n.title, /New applicant for Accounts Executive/);
    const view = (await call("/team-hiring", undefined, who.token)).data;
    assert.deepEqual(view.openings.map((o) => o.id), [jobId]);
    assert.equal(view.candidates.length, 1);
    assert.equal(view.candidates[0].name, "Asha Rao");
    assert.ok(view.candidates[0].match_detail.length > 0);
    assert.ok(view.candidates[0].resume_id);
  }
  // Someone else sees nothing and cannot open the resume or give a view.
  const outsider = (await call("/team-hiring", undefined, other.token)).data;
  assert.deepEqual([outsider.openings.length, outsider.candidates.length], [0, 0]);
  const resumeId = (await call("/team-hiring", undefined, head.token)).data.candidates[0].resume_id;
  assert.equal((await call(`/team-hiring/files/${resumeId}`, undefined, other.token)).status, 404);
  assert.equal((await call(`/team-hiring/candidates/${cand.id}/view`, { view: "shortlist" }, other.token)).status, 404);

  // The head gives a view; "not suitable" needs a reason; HR is told and sees it on the candidate.
  assert.equal((await call(`/team-hiring/candidates/${cand.id}/view`, { view: "not_suitable" }, head.token)).status, 400);
  assert.equal((await call(`/team-hiring/candidates/${cand.id}/view`, { view: "shortlist", note: "Good Tally" }, head.token)).status, 200);
  const hr = (await call(`/admin/candidates/${cand.id}`, undefined, admin)).data;
  assert.equal(hr.team_view, "shortlist");
  assert.equal(hr.team_view_note, "Good Tally");
  assert.ok(hr.events.some((e) => e.detail.startsWith("Meera: Shortlist")));
  const told = await db.prepare("SELECT n.title,u.role FROM notifications n JOIN users u ON u.id=n.user_id WHERE n.title LIKE 'Meera:%'").all();
  assert.deepEqual(told, [{ title: "Meera: Shortlist · Asha Rao", role: "hr" }]);
  void hrPerson;
});
