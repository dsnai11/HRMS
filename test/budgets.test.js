import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { fyMonths, spread } from "../server/routes/budgets.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  const nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Laxmi Test" });
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
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, data: text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text, res };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64);
    const r = await call("/login", { email, password, native: true, device: { id, platform: "android", model: "T", secret: secrets.get(id) } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (await call("/admin/workplaces", { name: "Office", latitude: 26.9124, longitude: 75.7873, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const branch = async (name, code, zone, region) =>
    (await call("/admin/branches", { name, code, state: "Rajasthan", zone, region }, owner)).data.id;
  const ho = await branch("Jaipur HO", "HO", "North", "Jaipur");
  const kota = await branch("Kota", "KOT01", "North", "Hadoti");
  const indore = await branch("Indore", "IND01", "Central", "Malwa");
  const people = {};
  const add = async (key, extra = {}) => {
    const email = `${key}@example.test`;
    const r = await call("/admin/employees", { name: key.toUpperCase(), email, password: PW, workplace_id: site, branch_id: kota, date_of_joining: "2026-01-01", gender: "male", ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(email) };
    return people[key];
  };
  await add("maker", { role: "admin", branch_id: ho });
  await add("checker", { role: "admin", branch_id: ho });
  await add("hr", { role: "hr", branch_id: ho });
  await add("staff");
  return { db, call, owner, people, branches: { ho, kota, indore } };
}

test("spread keeps whole rupees and the yearly total", () => {
  assert.deepEqual(spread(1200), Array(12).fill(100));
  const s = spread(1000);
  assert.equal(s.reduce((a, b) => a + b, 0), 1000);
  assert.equal(s[0], 83);
  assert.equal(s[11], 87);
  assert.deepEqual(fyMonths(2026).slice(0, 2), ["2026-04", "2026-05"]);
  assert.equal(fyMonths(2026)[11], "2027-03");
});

test("branch budgets: plan, approval by someone else, revisions and budget vs actual", async (t) => {
  const { db, call, people, branches } = await world(t);
  const { maker, checker, hr, staff } = people;

  // Default heads, current financial year.
  const plan = (await call("/admin/budgets", undefined, maker.token)).data;
  assert.equal(plan.fy, 2026);
  assert.equal(plan.label, "2026-27");
  assert.equal(plan.status, "draft");
  const head = Object.fromEntries(plan.heads.map((h) => [h.code, h]));
  assert.deepEqual(Object.keys(head), ["SAL", "REIMB", "INC", "REC", "TRN", "WEL"]);
  assert.equal(head.SAL.source, "payroll");
  // HR can see but not change budgets; employees cannot see them.
  assert.equal((await call("/admin/budgets", undefined, hr.token)).status, 200);
  assert.equal((await call("/admin/budgets/line", { fy: 2026, branch_id: branches.kota, head_id: head.SAL.id, annual: 1 }, hr.token, "PUT")).status, 403);
  assert.equal((await call("/admin/budgets", undefined, staff.token)).status, 403);

  // Head office marked; zones from the branch form.
  assert.equal((await call("/admin/budgets/head-office", { branch_id: branches.ho }, people.maker.token, "PUT")).status, 200);
  const p2 = (await call("/admin/budgets", undefined, maker.token)).data;
  assert.equal(p2.branches[0].name, "Jaipur HO");
  assert.equal(p2.branches[0].head_office, 1);

  // One line by hand: a yearly amount is spread over the months.
  let r = await call("/admin/budgets/line", { fy: 2026, branch_id: branches.kota, head_id: head.SAL.id, annual: 1200000 }, maker.token, "PUT");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const line = (await call(`/admin/budgets/line?fy=2026&branch_id=${branches.kota}&head_id=${head.SAL.id}`, undefined, maker.token)).data;
  assert.equal(line.months.length, 12);
  assert.ok(line.months.every((m) => m.amount === 100000));

  // Import: a bad row stops the whole file; a clean file saves.
  r = await call("/admin/budgets/import", { fy: 2026, kind: "lines", rows: [{ branch: "KOT01", head: "TRN", annual: "60,000" }, { branch: "Nowhere", head: "TRN", annual: "1" }] }, maker.token);
  assert.equal(r.data.failed, 1, JSON.stringify(r.data));
  assert.equal(r.data.saved, false);
  r = await call(
    "/admin/budgets/import",
    {
      fy: 2026,
      kind: "lines",
      rows: [
        { branch: "KOT01", head: "TRN", annual: "60,000" },
        { branch: "Kota", head: "REIMB", annual: "120000" },
        { branch_code: "IND01", head: "SAL", apr: "50000", may: "50000" },
        { branch: "HO", head: "SAL", annual: "2400000" },
      ],
    },
    maker.token,
  );
  assert.equal(r.data.saved, true, JSON.stringify(r.data));
  r = await call("/admin/budgets/import", { fy: 2026, kind: "posts", rows: [{ branch: "KOT01", designation: "Nope", sanctioned: "3" }] }, maker.token);
  assert.equal(r.data.failed, 1);

  // Manpower plan for Kota.
  const org = (await call("/admin/designations", { name: "Branch Manager" }, maker.token)).data.id;
  r = await call("/admin/budgets/posts", { fy: 2026, branch_id: branches.kota, rows: [{ designation_id: org, sanctioned: 3 }] }, maker.token, "PUT");
  assert.equal(r.status, 200);

  // Maker-checker.
  assert.equal((await call("/admin/budgets/status", { fy: 2026, action: "approve" }, checker.token)).status, 409);
  r = await call("/admin/budgets/status", { fy: 2026, action: "submit" }, maker.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  // Locked while waiting.
  assert.equal((await call("/admin/budgets/line", { fy: 2026, branch_id: branches.kota, head_id: head.SAL.id, annual: 1 }, maker.token, "PUT")).status, 409);
  assert.equal((await call("/admin/budgets/status", { fy: 2026, action: "approve" }, maker.token)).status, 403);
  assert.equal((await call("/admin/budgets/status", { fy: 2026, action: "return" }, checker.token)).status, 400);
  const told = await db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND kind='budget'").get(checker.id);
  assert.equal(Number(told.n), 1);
  r = await call("/admin/budgets/status", { fy: 2026, action: "approve" }, checker.token);
  assert.equal(r.status, 200);

  // After approval, a change needs a reason and is kept.
  assert.equal((await call("/admin/budgets/line", { fy: 2026, branch_id: branches.kota, head_id: head.TRN.id, annual: 90000 }, maker.token, "PUT")).status, 400);
  r = await call("/admin/budgets/line", { fy: 2026, branch_id: branches.kota, head_id: head.TRN.id, annual: 90000, reason: "Two more induction batches" }, maker.token, "PUT");
  assert.equal(r.status, 200);
  const revs = (await call("/admin/budgets/revisions?fy=2026", undefined, maker.token)).data;
  assert.equal(revs.length, 1);
  assert.equal(revs[0].old_amount, 60000);
  assert.equal(revs[0].new_amount, 90000);

  // Actuals: payroll for October (approved) and November (draft, not counted), a claim, a manual entry.
  const run = async (month, status, userId, cost) => {
    const id = Number(
      (await db.prepare("INSERT INTO payroll_runs(company_id,month,status,created_at) VALUES(1,?,?,?)").run(month, status, "2026-11-01T00:00:00Z")).lastInsertRowid,
    );
    await db
      .prepare("INSERT INTO payroll_items(run_id,company_id,user_id,gross,deductions,net,employer_cost,paid_days,lop_days,taxable_earnings,data) VALUES(?,1,?,?,0,?,?,30,0,?,'{}')")
      .run(id, userId, cost, cost, cost, cost);
  };
  await run("2026-10", "approved", staff.id, 150000);
  await run("2026-11", "draft", staff.id, 999999);
  const type = Number((await db.prepare("INSERT INTO claim_types(company_id,name,created_at) VALUES(1,'Travel','x')").run()).lastInsertRowid);
  await db
    .prepare("INSERT INTO reimbursement_claims(company_id,user_id,claim_type_id,expense_date,amount,approved_amount,description,status,created_at) VALUES(1,?,?,?,?,?,?,?,?)")
    .run(staff.id, type, "2026-09-10", 5000, 4000, "Field visit", "approved", "x");
  assert.equal((await call("/admin/budgets/spend", { branch_id: branches.kota, head_id: head.SAL.id, spent_on: "2026-10-01", amount: 5, description: "x" }, maker.token)).status, 400);
  assert.equal((await call("/admin/budgets/spend", { branch_id: branches.kota, head_id: head.TRN.id, spent_on: "2026-12-01", amount: 5, description: "x" }, maker.token)).status, 400);
  r = await call("/admin/budgets/spend", { branch_id: branches.kota, head_id: head.TRN.id, spent_on: "2026-10-15", amount: 80000, description: "Induction batch", reference: "V-101" }, maker.token);
  assert.equal(r.status, 201);
  const repRes = await call("/admin/budgets/report?fy=2026", undefined, hr.token);
  const rep = repRes.data;
  assert.equal(repRes.status, 200, JSON.stringify(rep));
  assert.equal(rep.upto, "2026-11");
  const kota = rep.branches.find((b) => b.id === branches.kota);
  assert.equal(kota.heads[head.SAL.id].budget_fy, 1200000);
  assert.equal(kota.heads[head.SAL.id].budget_ytd, 800000); // April to November
  assert.equal(kota.heads[head.SAL.id].actual_ytd, 150000); // the draft run is left out
  assert.equal(kota.heads[head.REIMB.id].actual_ytd, 4000); // the approved amount
  assert.equal(kota.heads[head.TRN.id].budget_ytd, 60000);
  assert.equal(kota.heads[head.TRN.id].actual_ytd, 80000);
  assert.equal(kota.heads[head.TRN.id].flag, "over");
  assert.equal(kota.sanctioned, 3);
  assert.equal(kota.filled, 1);
  assert.equal(kota.vacant, 2);
  const indore = rep.branches.find((b) => b.id === branches.indore);
  assert.equal(indore.budget_fy, 100000);
  assert.equal(rep.zones.find((z) => z.name === "Head office").branches, 1);
  assert.equal(rep.zones.find((z) => z.name === "North").branches, 1);
  assert.equal(rep.total.actual_ytd, 150000 + 4000 + 80000);
  assert.equal(rep.monthly.find((m) => m.month === "2026-10").actual, 230000);

  const csv = await call("/admin/budgets/report?fy=2026&group=zones&format=csv", undefined, hr.token);
  assert.equal(csv.status, 200);
  assert.match(csv.data, /"Zone","Branches","Budget for the year"/);
  assert.match(csv.data, /Head office/);

  // Copy into next year, 10% up; only a draft year can be filled.
  r = await call("/admin/budgets/copy", { fy: 2027, from_fy: 2026, change_pct: 10 }, maker.token);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const next = (await call("/admin/budgets?fy=2027", undefined, maker.token)).data;
  assert.equal(next.lines[branches.kota][head.SAL.id], 1320000);
  assert.equal((await call("/admin/budgets/copy", { fy: 2026, from_fy: 2027 }, maker.token)).status, 409);

  // Heads: one payroll-fed head at most.
  assert.equal((await call("/admin/budgets/heads", { name: "Bonus", code: "BON", source: "payroll" }, maker.token)).status, 400);
  assert.equal((await call("/admin/budgets/heads", { name: "Branch rent", code: "rent", source: "manual" }, maker.token)).status, 201);
  assert.equal((await call("/admin/budgets/heads", { name: "Rent again", code: "RENT", source: "manual" }, maker.token)).status, 409);

  // Zones and regions from a sheet.
  r = await call("/admin/budgets/branch-groups", { rows: [{ branch: "IND01", zone: "West", region: "Indore" }] }, maker.token);
  assert.equal(r.data.saved, true);
  assert.equal((await db.prepare("SELECT zone FROM branches WHERE id=?").get(branches.indore)).zone, "West");
});
