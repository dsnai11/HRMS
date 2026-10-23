import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const { server } = createApp({ db });
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
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  // Phone-style sign-in, as in the other tests.
  const signIn = async (email, password = PW) => {
    const r = await call("/login", { email, password, native: true, device: { id: `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`.padEnd(16, "0").slice(0, 64), platform: "android", model: "T" } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      { name: key.toUpperCase(), email: `${key}@example.test`, password: PW, ...extra },
      owner,
    );
    if (r.status !== 201) return r;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  return { db, call, owner, add, base };
}


test("home page data, optional holidays and leave contact details", async (t) => {
  const { db, call, owner, add } = await world(t);
  const today = new Date().toISOString().slice(0, 10);
  const boss = await add("boss", { role: "hr" });
  const emp = await add("emp", { manager_id: boss.id, date_of_birth: `1995-${today.slice(5, 7)}-03`, date_of_joining: today });
  const mate = await add("mate", { manager_id: boss.id });

  const home = (await call("/home", undefined, emp.token)).data;
  assert.equal(home.me.name, "EMP");
  assert.equal(home.org.manager.name, "BOSS");
  assert.deepEqual(home.birthdays.map((b) => [b.name, b.day]), [["EMP", 3]]);
  assert.ok(!("date_of_birth" in home.birthdays[0]), "only the day is shared");
  assert.ok(home.joiners.some((j) => j.name === "EMP"));
  assert.deepEqual((await call("/home", undefined, boss.token)).data.org.reports.map((p) => p.name), ["EMP", "MATE"]);

  // Optional holidays are listed but are not days off.
  const y = today.slice(0, 4);
  assert.equal((await call("/admin/holidays", { items: [{ date: `${y}-12-30`, name: "Fixed day" }] }, owner)).status, 201);
  assert.equal((await call("/admin/holidays", { items: [{ date: `${y}-12-29`, name: "Choice day" }], optional: true }, owner)).status, 201);
  const hol = (await call(`/holidays?year=${y}`, undefined, emp.token)).data;
  assert.deepEqual(hol.map((h) => [h.name, h.optional]), [["Choice day", true], ["Fixed day", false]]);

  // Leave with where to reach the person and who covers for them.
  await call("/admin/leave-types/seed-defaults", {}, owner);
  const cl = (await call("/leave/balances", undefined, emp.token)).data.find((b) => b.unlimited);
  assert.equal((await call("/leave/requests", { leave_type_id: cl.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29`, handover_to: emp.id }, emp.token)).status, 400);
  const made = await call("/leave/requests", { leave_type_id: cl.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29`, address_on_leave: "Jaipur", contact_on_leave: "98290", handover_to: mate.id }, emp.token);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.days, 1, "an optional holiday is still a working day");
  const mine = (await call("/leave/requests", undefined, emp.token)).data[0];
  assert.deepEqual([mine.address_on_leave, mine.contact_on_leave, mine.handover_name], ["Jaipur", "98290", "MATE"]);
  const inbox = (await call("/approvals", undefined, boss.token)).data.leave[0];
  assert.equal(inbox.handover_name, "MATE");
});

test("a medical document travels with a leave request to its approver only", async (t) => {
  const { call, owner, add, base } = await world(t);
  const mgr = await add("mgr");
  const emp = await add("emp", { manager_id: mgr.id });
  const other = await add("other");
  await call("/admin/leave-types/seed-defaults", {}, owner);
  const pdf = Buffer.from("%PDF-1.4\n%test\n").toString("base64");
  const doc = await call("/documents", { kind: "medical", name: "Medical", mime: "application/pdf", data: pdf }, emp.token);
  assert.equal(doc.status, 201, JSON.stringify(doc.data));
  const lwp = (await call("/leave/balances", undefined, emp.token)).data.find((b) => b.unlimited);
  const y = new Date().getFullYear();
  // Someone else's document cannot be attached.
  const foreign = await call("/documents", { kind: "medical", name: "X", mime: "application/pdf", data: pdf }, other.token);
  assert.equal((await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29`, document_id: foreign.data.id }, emp.token)).status, 400);
  const made = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29`, document_id: doc.data.id }, emp.token);
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const open = (who) => fetch(`${base}/documents/${doc.data.id}/file`, { headers: { Authorization: `Bearer ${who.token}` } }).then((r) => r.status);
  assert.equal(await open(mgr), 200);
  assert.equal(await open(other), 404);
  assert.equal((await call("/leave/requests", undefined, emp.token)).data[0].document_id, doc.data.id);
});

test("payroll uploads Form 16 by employee code and the employee downloads it", async (t) => {
  const { call, owner, add, base } = await world(t);
  const emp = await add("emp", { employee_code: "LIF101" });
  const other = await add("other");
  const pdf = (s) => Buffer.from(`%PDF-1.4\n${s}\n`).toString("base64");
  const up = (b) => call("/admin/form16", { mime: "application/pdf", ...b }, owner);
  assert.equal((await up({ fy: "2025-27", employee_code: "LIF101", data: pdf("a") })).status, 400);
  assert.equal((await up({ fy: "2025-26", employee_code: "NOPE", data: pdf("a") })).status, 404);
  assert.equal((await up({ fy: "2025-26", employee_code: "lif101", data: Buffer.from("not a pdf").toString("base64") })).status, 400);
  assert.equal((await up({ fy: "2025-26", employee_code: "lif101", data: pdf("first") })).status, 201);
  const again = await up({ fy: "2025-26", employee_code: "LIF101", data: pdf("second") });
  assert.equal(again.data.employee, "EMP");
  const mine = (await call("/form16", undefined, emp.token)).data;
  assert.deepEqual(mine.map((d) => d.name), ["Form 16 FY 2025-26"], "the new upload replaces the old");
  const file = await fetch(`${base}/documents/${mine[0].id}/file`, { headers: { Authorization: `Bearer ${emp.token}` } });
  assert.match(await file.text(), /second/);
  assert.equal((await call("/form16", undefined, other.token)).data.length, 0);
  assert.equal((await call("/admin/form16", { fy: "2025-26", employee_code: "LIF101", mime: "application/pdf", data: pdf("x") }, emp.token)).status, 403);
  assert.equal((await call("/admin/form16?fy=2025-26", undefined, owner)).data.length, 1);
});

test("extra profile sections: personal, medical, nominees and HR-only insurance", async (t) => {
  const { call, owner, add } = await world(t);
  const emp = await add("emp");
  const put = (b, token = emp.token) => call("/profile/details", b, token, "PUT");
  assert.equal((await put({ personal: { blood_group: "Z+" } })).status, 400);
  assert.equal((await put({ nominees: [{ name: "Ma", share: 60 }] })).status, 400, "shares add to 100");
  assert.equal((await put({ insurance: [] })).status, 403, "insurance is HR's");
  const ok = await put({
    personal: { father_name: "Ram", blood_group: "B+", marital_status: "married", children: 2 },
    medical: { allergies: "Penicillin" },
    nominees: [{ name: "Sita", relation: "Wife", share: 60 }, { name: "Ma", relation: "Mother", share: 40 }],
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  // Only what is sent changes.
  await put({ medical: { allergies: "None" } });
  const mine = (await call("/profile/details", undefined, emp.token)).data;
  assert.equal(mine.personal.blood_group, "B+");
  assert.equal(mine.medical.allergies, "None");
  assert.equal(mine.nominees.length, 2);
  const hr = await call(`/admin/employees/${emp.id}/details`, { insurance: [{ type: "health", provider: "Star", sum_insured: 500000, valid_till: "2027-03-31" }] }, owner, "PUT");
  assert.equal(hr.status, 200, JSON.stringify(hr.data));
  assert.equal((await call("/profile/details", undefined, emp.token)).data.insurance[0].provider, "Star");
  assert.equal(hr.data.nominees.length, 2, "HR's save keeps the employee's sections");
});
