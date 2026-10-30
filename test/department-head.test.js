import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

test("department head: default manager for the department, without circular reporting", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  let owner = null;
  owner = (await (await fetch(`${base}/login`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "owner@example.test", password: "Owner-password-123", native: true }) })).json()).token;
  const sales = (await call("/admin/departments", { name: "Sales" })).data.id;
  const ops = (await call("/admin/departments", { name: "Operations" })).data.id;
  const add = async (name, extra = {}) =>
    (await call("/admin/employees", { name, email: `${name.toLowerCase()}@example.test`, password: "Temporary-pass-123", ...extra })).data.id;
  const managerOf = async (id) => (await db.prepare("SELECT manager_id FROM users WHERE id=?").get(id)).manager_id;

  const zonal = await add("Zonal", { department_id: sales });
  const head = await add("Head", { department_id: sales, manager_id: zonal });
  const early = await add("Early", { department_id: sales });
  const withBoss = await add("Kept", { department_id: sales, manager_id: zonal });

  const set = await call(`/admin/departments/${sales}/head`, { head_id: head, assign_unassigned: true }, "PATCH");
  assert.equal(set.status, 200, JSON.stringify(set.data));
  assert.equal(set.data.moved, 1, "only Early: Zonal is above the head, Kept already has a manager");
  assert.equal(await managerOf(early), head);
  assert.equal(await managerOf(zonal), null, "no circular reporting");
  assert.equal(await managerOf(withBoss), zonal);
  assert.equal((await call("/admin/departments")).data.find((d) => d.id === sales).head_name, "Head");

  // New people in the department report to the head unless a manager is given.
  assert.equal(await managerOf(await add("Joiner", { department_id: sales })), head);
  assert.equal(await managerOf(await add("Chosen", { department_id: sales, manager_id: zonal })), zonal);
  assert.equal(await managerOf(await add("NoDept")), null);
  // Moving someone with no manager into the department.
  const mover = await add("Mover", { department_id: ops });
  assert.equal((await call(`/admin/employees/${mover}`, { department_id: sales }, "PATCH")).status, 200);
  assert.equal(await managerOf(mover), head);
  // The head appears as the Supervisor of their department's people.
  assert.equal((await db.prepare("SELECT COUNT(*) n FROM users WHERE manager_id=?").get(head)).n, 3);
  assert.equal((await call(`/admin/departments/${sales}/head`, { head_id: null }, "PATCH")).status, 200);
  assert.equal((await call("/admin/departments")).data.find((d) => d.id === sales).head_name, null);
});
