import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";

async function world(t) {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server } = createApp({ db, clock: () => Date.parse("2026-11-09T10:00:00+05:30") });
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
  const call = async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${admin}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  let admin = null;
  admin = (
    await (
      await fetch(`${base}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "admin@example.test", password: "Admin-password-123", native: true }),
      })
    ).json()
  ).token;
  return { db, call };
}

test("employee codes follow the company's own series: E0001… or plain numbers", async (t) => {
  const { call } = await world(t);
  const add = (name, extra = {}) => call("/admin/employees", { name, email: `${name.toLowerCase()}@example.test`, password: PW, ...extra });
  // No numeric codes yet: the E series.
  assert.match((await call("/admin/employees/next-code")).data.employee_code, /^E\d{4}$/);
  // Laxmi's staff have plain numbers: the next one follows the highest.
  await add("Poonam", { employee_code: "3367" });
  await add("Dinesh", { employee_code: "9441" });
  assert.equal((await call("/admin/employees/next-code")).data.employee_code, "9442");
  const auto = (await add("Ravi")).data.id;
  assert.equal((await call(`/admin/employees/${auto}`)).data.employee_code, "9442");
  assert.equal((await call("/admin/employees/next-code")).data.employee_code, "9443");
  assert.equal((await add("Copy", { employee_code: "9441" })).status, 409, "a code in use is refused");
});

test("hire with the employee code and grade; a grade outside the designation warns", async (t) => {
  const { db, call } = await world(t);
  await call("/admin/employees", { name: "Old", email: "old@example.test", password: PW, employee_code: "9441" });
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 })).data.id;
  const ro = (await call("/admin/designations", { name: "Relationship Officer" })).data.id;
  const [o1, s1] = [(await call("/admin/grades", { name: "O1" })).data.id, (await call("/admin/grades", { name: "S1" })).data.id];
  await call(`/admin/designations/${ro}/grades`, { grade_ids: [o1] }, "PUT");
  const hireOne = async (name, body) => {
    const opening = (await call("/admin/openings", { title: "RO", designation_id: ro, positions: 1 })).data.id;
    const cand = (await call("/admin/candidates", { name, email: `${name.toLowerCase()}@example.test`, opening_id: opening })).data.id;
    const offer = (await call(`/admin/candidates/${cand}/offers`, { designation: "RO", monthly_gross: 30000, joining_date: "2026-12-01" })).data.id;
    await call(`/admin/offers/${offer}/status`, { status: "sent" });
    await call(`/admin/offers/${offer}/status`, { status: "accepted" });
    return call(`/admin/candidates/${cand}/hire`, { password: PW, workplace_id: site, designation_id: ro, ...body });
  };

  // HR keeps the suggested next code and picks a fitting grade: no warning.
  const first = await hireOne("Asha", { employee_code: "9442", grade_id: o1 });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.deepEqual([first.data.employee_code, first.data.warning], ["9442", null]);
  const asha = await db.prepare("SELECT employee_code,grade_id,designation_id FROM users WHERE id=?").get(first.data.user_id);
  assert.deepEqual(asha, { employee_code: "9442", grade_id: o1, designation_id: ro });

  // A grade outside the designation's: hired anyway, with the warning.
  const second = await hireOne("Bala", { employee_code: "9443", grade_id: s1 });
  assert.equal(second.status, 201);
  assert.match(second.data.warning, /grade S1 is not one of the grades for Relationship Officer \(O1\)/);

  // No code given: the next in the series.
  const third = await hireOne("Chitra", {});
  assert.equal(third.data.employee_code, "9444");

  // A code already in use is refused, and nobody is hired.
  const dup = await hireOne("Dev", { employee_code: "9442" });
  assert.equal(dup.status, 409);
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users WHERE email='dev@example.test'").get()).n, 0);
});
