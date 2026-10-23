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

test("administrators define roles with chosen rights and give them to people", async (t) => {
  const { call, owner, add } = await world(t);

  const list = (await call("/admin/roles", undefined, owner)).data;
  assert.ok(list.permissions.some((p) => p.key === "leave.approve"));
  assert.ok(!list.permissions.some((p) => p.key === "roles.assign"));
  assert.deepEqual(
    list.built_in.map((r) => r.role),
    ["admin", "hr", "payroll", "employee"],
  );

  // Bad input is refused.
  assert.equal((await call("/admin/roles", { name: "HR", permissions: ["leave.read"] }, owner)).status, 409);
  assert.equal((await call("/admin/roles", { name: "X", permissions: [] }, owner)).status, 400);
  assert.equal((await call("/admin/roles", { name: "X", permissions: ["roles.assign"] }, owner)).status, 400);

  const made = await call(
    "/admin/roles",
    { name: "Leave desk", description: "Handles leave only", permissions: ["leave.read", "leave.approve", "employees.read"] },
    owner,
  );
  assert.equal(made.status, 201, JSON.stringify(made.data));
  const roleId = made.data.id;
  assert.equal((await call("/admin/roles", { name: "leave DESK", permissions: ["leave.read"] }, owner)).status, 409);

  // A custom role needs a real role id.
  assert.equal((await add("bad", { role: "custom" })).status, 400);
  const desk = await add("desk", { role: "custom", custom_role_id: roleId });
  const me = (await call("/me", undefined, desk.token)).data;
  assert.equal(me.user.role, "custom");
  assert.equal(me.user.role_name, "Leave desk");
  // Organisation lists come with every custom role: the staff pages need them.
  assert.deepEqual(me.permissions.sort(), ["employees.read", "leave.approve", "leave.read", "org.read"]);
  assert.equal((await call("/admin/org", undefined, desk.token)).status, 200);

  // The rights work, and only those rights.
  assert.equal((await call("/admin/employees", undefined, desk.token)).status, 200);
  assert.equal((await call("/admin/workplaces", { name: "X" }, desk.token)).status, 403);
  assert.equal((await call("/admin/roles", undefined, desk.token)).status, 403);

  // Changing the role applies on the next request.
  assert.equal(
    (await call(`/admin/roles/${roleId}`, { name: "Leave desk", permissions: ["leave.read"] }, owner, "PATCH")).status,
    200,
  );
  assert.equal((await call("/admin/employees", undefined, desk.token)).status, 403);
  assert.equal((await call("/admin/roles", undefined, owner)).data.custom[0].members, 1);

  // A role in use cannot be deleted; after moving the person it can.
  assert.equal((await call(`/admin/roles/${roleId}`, undefined, owner, "DELETE")).status, 409);
  const edit = await call(`/admin/employees/${desk.id}`, { role: "hr" }, owner, "PATCH");
  assert.equal(edit.status, 200, JSON.stringify(edit.data));
  const after = (await call(`/admin/employees/${desk.id}`, undefined, owner)).data;
  assert.equal(after.role, "hr");
  assert.equal(after.custom_role_id, null);
  assert.equal((await call(`/admin/roles/${roleId}`, undefined, owner, "DELETE")).status, 200);

  // HR cannot manage roles or hand out custom roles.
  const hr = await add("hr", { role: "hr" });
  assert.equal((await call("/admin/roles", { name: "Y", permissions: ["leave.read"] }, hr.token)).status, 403);
  // Administrators can create HR team and payroll accounts directly.
  assert.ok((await add("pay", { role: "payroll" })).token);
});

test("a role limited to branches sees and decides only for those branches", async (t) => {
  const { db, call, owner, add } = await world(t);
  const now = new Date().toISOString();
  const branch = async (name) =>
    Number((await db.prepare("INSERT INTO branches(company_id,name,created_at) VALUES(1,?,?)").run(name, now)).lastInsertRowid);
  const jaipur = await branch("Jaipur");
  const indore = await branch("Indore");
  const role = await call("/admin/roles", { name: "Jaipur HR", permissions: ["employees.read", "employees.write", "attendance.read", "leave.approve"], branch_ids: [jaipur] }, owner);
  assert.equal(role.status, 201, JSON.stringify(role.data));
  assert.equal((await call("/admin/roles", { name: "Bad", permissions: ["leave.read"], branch_ids: [9999] }, owner)).status, 400);
  assert.deepEqual((await call("/admin/roles", undefined, owner)).data.custom[0].branch_ids, [jaipur]);

  const hr = await add("jhr", { role: "custom", custom_role_id: role.data.id, branch_id: jaipur });
  const a = await add("ajay", { branch_id: jaipur });
  const b = await add("bina", { branch_id: indore });

  const names = (await call("/admin/employees", undefined, hr.token)).data.items.map((p) => p.name);
  assert.ok(names.includes("AJAY") && !names.includes("BINA"), names.join());
  assert.equal((await call(`/admin/employees/${b.id}`, undefined, hr.token)).status, 404);
  assert.equal((await call(`/admin/employees/${b.id}`, { name: "X" }, hr.token, "PATCH")).status, 404);
  assert.equal((await call(`/admin/employees/${a.id}`, { branch_id: indore }, hr.token, "PATCH")).status, 403);
  assert.equal((await call("/admin/overview", undefined, hr.token)).data.employees, 2); // jhr and ajay
  assert.equal((await call("/admin/overview", undefined, owner)).data.employees > 2, true);

  // Leave: the Indore request is not in the inbox and cannot be decided.
  await call("/admin/leave-types/seed-defaults", {}, owner);
  const lwp = (await call("/leave/balances", undefined, b.token)).data.find((x) => x.unlimited);
  const y = now.slice(0, 4);
  const reqB = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29` }, b.token);
  const reqA = await call("/leave/requests", { leave_type_id: lwp.leave_type_id, from_date: `${y}-12-29`, to_date: `${y}-12-29` }, a.token);
  const inbox = (await call("/approvals", undefined, hr.token)).data.leave.map((r) => r.id);
  assert.deepEqual(inbox, [reqA.data.id]);
  const decide = (id) => call(`/leave/requests/${id}/decision`, { decision: "approved" }, hr.token);
  assert.equal((await decide(reqB.data.id)).status, 403);
});

test("standard HR roles are added in one step and work like any role", async (t) => {
  const { call, owner, add } = await world(t);
  const list = (await call("/admin/roles/templates", undefined, owner)).data;
  assert.ok(list.some((r) => r.name === "HR Executive"));
  const made = await call("/admin/roles/templates", { names: ["HR Executive", "Payroll Executive"] }, owner);
  assert.equal(made.data.created, 2);
  assert.equal((await call("/admin/roles/templates", { names: ["HR Executive"] }, owner)).data.created, 0, "no duplicates");
  const roles = (await call("/admin/roles", undefined, owner)).data.custom;
  const exec = roles.find((r) => r.name === "HR Executive");
  assert.ok(exec.permissions.includes("leave.approve") && !exec.permissions.includes("payroll.read"));
  const pay = roles.find((r) => r.name === "Payroll Executive");
  assert.ok(pay.permissions.includes("payroll.manage") && !pay.permissions.includes("payroll.approve"));
  const person = await add("execu", { role: "custom", custom_role_id: exec.id });
  assert.equal((await call("/admin/employees", undefined, person.token)).status, 200);
  assert.equal((await call("/admin/roles/templates", {}, person.token)).status, 403);
  // Everything at once adds the rest.
  assert.equal((await call("/admin/roles/templates", {}, owner)).data.created, list.length - 2);
});

test("saving an employee does not get stuck: shifts close, teams move, admins may change themselves", async (t) => {
  const { db, call, owner, add } = await world(t);
  const boss = await add("boss");
  const lead = await add("lead", { manager_id: boss.id });
  const a = await add("a", { manager_id: lead.id });
  const b = await add("b", { manager_id: lead.id });
  // lead is punched in right now
  const now = new Date().toISOString();
  const site = (await call("/admin/workplaces", { name: "Office", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, owner)).data.id;
  await db
    .prepare("INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(lead.id, site, "Office", 26.9, 75.8, 150, 50, now, 26.9, 75.8, 10);

  const off = await call(`/admin/employees/${lead.id}`, { active: false }, owner, "PATCH");
  assert.equal(off.status, 200, JSON.stringify(off.data));
  const shift = await db.prepare("SELECT out_at FROM shifts WHERE user_id=?").get(lead.id);
  assert.ok(shift.out_at, "the open shift was closed");
  const managers = await db.prepare("SELECT manager_id FROM users WHERE id IN (?,?)").all(a.id, b.id);
  assert.deepEqual(managers.map((m) => m.manager_id), [boss.id, boss.id], "the team moved up to lead's manager");

  // A company's only admin cannot remove themselves; with a second admin they can.
  const adm = await add("adm", { role: "admin" });
  const self = (body) => call(`/admin/employees/${adm.id}`, body, adm.token, "PATCH");
  assert.equal((await self({ role: "hr" })).status, 409);
  await add("adm2", { role: "admin" });
  assert.equal((await self({ role: "hr" })).status, 200);
});
