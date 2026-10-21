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
  return { db, call, owner, add };
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
