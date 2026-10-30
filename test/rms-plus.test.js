import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

test("RMS: screening knock-outs, talent pool, add to another job, bulk moves, agency portal, interview slots, report", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const owner = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const job = async (title, extra = {}) => {
    const o = (await call("/admin/openings", { title, positions: 2 }, owner)).data;
    assert.ok(o.id, JSON.stringify(o));
    const d = await call(`/admin/openings/${o.id}/details`, { published: true, skills: ["kyc", "gold loans"], ...extra }, owner, "PATCH");
    assert.equal(d.status, 200, JSON.stringify(d.data));
    return o.id;
  };

  // Screening questions: the careers page shows them without the knock-out rules.
  const screening = [
    { type: "yes_no", text: "Do you have a two-wheeler licence?", knockout: { equals: "no" } },
    { type: "number", text: "Years in field sales", knockout: { min: 1 } },
    { type: "choice", text: "Preferred city", options: ["Jaipur", "Kota"] },
  ];
  const sales = await job("Field Officer", { screening });
  assert.equal((await call(`/admin/openings/${sales}/details`, { screening: [{ type: "choice", text: "x", options: ["one"] }] }, owner, "PATCH")).status, 400, "a choice needs two options");
  const pub = (await call("/careers/1")).data.jobs.find((j) => j.id === sales);
  assert.deepEqual(pub.screening.map((q) => [q.id, q.knockout]), [["s1", undefined], ["s2", undefined], ["s3", undefined]]);
  const apply = (name, email, s) =>
    call("/careers/1/apply", { opening_id: sales, name, email, phone: "9876543210", screening: s });
  assert.equal((await apply("Asha", "asha@example.test", { s1: "yes", s2: 3 })).status, 400, "every question needs an answer");
  const out = await apply("Bina", "bina@example.test", { s1: "no", s2: 4, s3: "Kota" });
  assert.equal(out.status, 201, JSON.stringify(out.data));
  const bina = await db.prepare("SELECT stage,closed_reason,screening FROM candidates WHERE id=?").get(out.data.id);
  assert.equal(bina.stage, "rejected");
  assert.match(bina.closed_reason, /two-wheeler/);
  const ok = await apply("Asha Rao", "asha@example.test", { s1: "yes", s2: 3, s3: "Jaipur" });
  assert.equal((await db.prepare("SELECT stage FROM candidates WHERE id=?").get(ok.data.id)).stage, "applied");
  await db.prepare("UPDATE candidates SET skills='[\"kyc\",\"gold loans\"]',experience_years=3,location='Jaipur' WHERE id=?").run(ok.data.id);

  // Talent pool: across jobs, by words, skills, experience and stage.
  const pool = async (q) => (await call(`/admin/rms/talent?${q}`, undefined, owner)).data;
  assert.equal((await pool("q=asha")).total, 1);
  assert.equal((await pool("skills=gold loans&min_exp=2&location=jaipur")).rows[0].name, "Asha Rao");
  assert.equal((await pool("stage=open")).total, 1);
  assert.equal((await pool("stage=rejected")).rows[0].name, "Bina");

  // Add Asha to another job, with her resume and details; not twice.
  const ops = await job("Branch Operations");
  const copy = await call(`/admin/candidates/${ok.data.id}/copy`, { opening_id: ops }, owner);
  assert.equal(copy.status, 201, JSON.stringify(copy.data));
  const twin = await db.prepare("SELECT opening_id,source,experience_years,location FROM candidates WHERE id=?").get(copy.data.id);
  assert.deepEqual([twin.opening_id, twin.source, twin.experience_years, twin.location], [ops, "Talent pool", 3, "Jaipur"]);
  assert.equal((await call(`/admin/candidates/${ok.data.id}/copy`, { opening_id: ops }, owner)).status, 409);
  assert.equal((await call(`/admin/candidates/${ok.data.id}/copy`, { opening_id: sales }, owner)).status, 409);

  // Bulk: shortlist both; rejecting needs a reason, each result is reported.
  const bulk = await call("/admin/candidates/bulk", { ids: [ok.data.id, copy.data.id], stage: "screening" }, owner);
  assert.equal(bulk.data.moved, 2);
  const noReason = await call("/admin/candidates/bulk", { ids: [copy.data.id], stage: "rejected" }, owner);
  assert.deepEqual([noReason.data.moved, noReason.data.results[0].ok], [0, false]);
  assert.equal((await call("/admin/candidates/bulk", { ids: [] }, owner)).status, 400);

  // Agency portal: open jobs, and only the agency's own candidates.
  const agency = (await call("/admin/rms/sources", { kind: "agency", name: "TalentFirst" }, owner)).data;
  const other = (await call("/admin/rms/sources", { kind: "naukri" }, owner)).data;
  assert.ok(agency.key && other.key);
  assert.equal((await call(`/intake/${agency.key}`, { opening_id: sales, name: "Chetan", phone: "9811122233" })).status, 201);
  assert.equal((await call(`/intake/${other.key}`, { opening_id: sales, name: "Deepa", phone: "9822233344" })).status, 201);
  const portal = (await call(`/agency/${agency.key}`)).data;
  assert.equal(portal.agency, "TalentFirst");
  assert.ok(portal.jobs.some((j) => j.code === `J${sales}`));
  assert.deepEqual(portal.submitted.map((c) => [c.name, c.status]), [["Chetan", "Received"]]);
  assert.equal((await call(`/agency/${other.key}`)).status, 401, "only agency sources open the portal");
  assert.equal((await call("/agency/not-a-key")).status, 401);

  // Interview slots: the candidate picks one; it books the panel once.
  const iv = (await call("/admin/employees", { name: "Interviewer", email: "iv@example.test", password: "Temporary-pass-123" }, owner)).data.id;
  const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
  const inv = await call(`/admin/candidates/${ok.data.id}/interview-invites`, { slots: [`${day(2)}T05:00:00.000Z`, `${day(3)}T05:00:00.000Z`], interviewer_ids: [iv], round_name: "HR round", mode: "video", location: "https://meet.example/abc" }, owner);
  assert.equal(inv.status, 201, JSON.stringify(inv.data));
  const token = new URL(inv.data.link).searchParams.get("slot");
  const view = (await call(`/careers/slots/${token}`)).data;
  assert.deepEqual([view.name, view.round, view.slots.length], ["Asha Rao", "HR round", 2]);
  assert.equal((await call(`/careers/slots/${token}`, { slot: `${day(9)}T05:00:00.000Z` })).status, 409, "only offered slots");
  const booked = await call(`/careers/slots/${token}`, { slot: view.slots[1] });
  assert.equal(booked.status, 201, JSON.stringify(booked.data));
  const interview = await db.prepare("SELECT interviewer_id,scheduled_at,round_name FROM interviews WHERE candidate_id=?").get(ok.data.id);
  assert.deepEqual([interview.interviewer_id, interview.scheduled_at, interview.round_name], [iv, view.slots[1], "HR round"]);
  assert.equal((await call(`/careers/slots/${token}`, { slot: view.slots[0] })).status, 409, "booked once");
  assert.equal((await call(`/careers/slots/${token}`)).data.status, "booked");
  // The panel's booked time is not offered to the next candidate.
  const next = await call(`/admin/candidates/${copy.data.id}/interview-invites`, { slots: [view.slots[1], view.slots[0]], interviewer_ids: [iv] }, owner);
  const t2 = new URL(next.data.link).searchParams.get("slot");
  assert.deepEqual((await call(`/careers/slots/${t2}`)).data.slots, [view.slots[0]]);
  assert.equal((await call("/careers/slots/nope")).status, 404);

  // Report by source with cost per hire from the source's costs.
  assert.equal((await call(`/admin/rms/sources/${agency.id}/costs`, { fee_per_hire: 15000, monthly_cost: 2000 }, owner, "PATCH")).status, 200);
  const rep = (await call("/admin/rms/report", undefined, owner)).data;
  const careers = rep.by_source.find((s) => s.name === "Careers page");
  assert.deepEqual([careers.received, careers.shortlisted, careers.hired], [2, 2, 0]);
  const tf = rep.by_source.find((s) => s.name === "TalentFirst");
  assert.equal(tf.received, 1);
  assert.ok(tf.cost >= 2000, "monthly cost counted");
  assert.equal(rep.total, 5);
});
