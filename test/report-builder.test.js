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
  call.base = base;
  return { db, call, owner, add };
}



test("custom reports: columns, filters, summaries, CSV, saved reports and rights", async (t) => {
  const { db, call, owner, add } = await world(t);
  const now = new Date().toISOString();
  const branch = async (name) =>
    Number((await db.prepare("INSERT INTO branches(company_id,name,created_at) VALUES(1,?,?)").run(name, now)).lastInsertRowid);
  const dept = async (name) =>
    Number((await db.prepare("INSERT INTO departments(company_id,name,created_at) VALUES(1,?,?)").run(name, now)).lastInsertRowid);
  const [jaipur, delhi] = [await branch("Jaipur"), await branch("Delhi")];
  const [sales, ops] = [await dept("Sales"), await dept("Operations")];
  await add("a1", { branch_id: jaipur, department_id: sales, date_of_joining: "2024-04-01" });
  await add("a2", { branch_id: jaipur, department_id: ops, date_of_joining: "2025-06-10" });
  await add("a3", { branch_id: delhi, department_id: sales, date_of_joining: "2026-01-05" });

  const meta = (await call("/admin/report-builder", undefined, owner)).data;
  assert.deepEqual(meta.datasets.map((d) => d.key), ["employees", "attendance", "leave", "payroll"]);
  const run = (def, token = owner) => call("/admin/report-builder/run", def, token);

  const r = await run({
    dataset: "employees",
    columns: ["employee_name", "branch", "department", "date_of_joining"],
    filters: [{ field: "department", op: "is", value: "sales" }, { field: "date_of_joining", op: "from", value: "2024-01-01" }],
    sort: { field: "date_of_joining", dir: "desc" },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.columns.map((c) => c.label), ["Employee", "Branch", "Department", "Date of joining"]);
  assert.deepEqual(r.data.rows, [["A3", "Delhi", "Sales", "2026-01-05"], ["A1", "Jaipur", "Sales", "2024-04-01"]]);

  // Headcount by branch.
  const g = await run({ dataset: "employees", group_by: "branch", filters: [{ field: "branch", op: "not_empty" }], sort: { field: "count", dir: "desc" } });
  assert.deepEqual(g.data.rows, [["Jaipur", 2], ["Delhi", 1]]);

  // Leave days summed per leave type.
  await call("/admin/leave-types/seed-defaults", {}, owner);
  const cl = (await call("/admin/leave-types", undefined, owner)).data.find((x) => x.code === "CL");
  const a1 = (await db.prepare("SELECT id FROM users WHERE email='a1@example.test'").get()).id;
  await db
    .prepare("INSERT INTO leave_requests(company_id,user_id,leave_type_id,from_date,to_date,days,leave_year,status,created_at) VALUES(1,?,?,?,?,?,2026,'approved',?)")
    .run(a1, cl.id, "2026-10-01", "2026-10-02", 2, now);
  const lv = await run({ dataset: "leave", columns: ["leave_type", "days"], group_by: "leave_type" });
  assert.deepEqual(lv.data.rows, [["Casual Leave", 1, 2]]);
  assert.deepEqual(lv.data.columns.map((c) => c.label), ["Leave type", "Count", "Total days"]);

  // CSV download.
  const csv = await fetch(call.base + "/admin/report-builder/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${owner}` },
    body: JSON.stringify({ dataset: "employees", columns: ["employee_name", "branch"], filters: [{ field: "branch", op: "is", value: "Delhi" }], format: "csv" }),
  });
  assert.equal(csv.headers.get("content-type"), "text/csv; charset=utf-8");
  const bytes = Buffer.from(await csv.arrayBuffer());
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], "starts with a BOM so Excel reads it as UTF-8");
  assert.equal(bytes.subarray(3).toString(), '"Employee","Branch"\r\n"A3","Delhi"');

  // Only listed columns and operators; values are data, never SQL.
  assert.equal((await run({ dataset: "employees", columns: ["u.password_hash"] })).status, 400);
  assert.equal((await run({ dataset: "employees", filters: [{ field: "branch", op: "from", value: "x" }] })).status, 400);
  assert.equal((await run({ dataset: "nope" })).status, 400);
  const sneaky = await run({ dataset: "employees", columns: ["employee_name"], filters: [{ field: "employee_name", op: "contains", value: "' OR 1=1 --" }] });
  assert.deepEqual([sneaky.status, sneaky.data.rows], [200, []]);

  // Saved reports.
  const saved = await call("/admin/report-builder/saved", { name: "Sales joiners", definition: { dataset: "employees", columns: ["employee_name"], filters: [{ field: "department", op: "is", value: "Sales" }] } }, owner);
  assert.equal(saved.status, 201, JSON.stringify(saved.data));
  assert.deepEqual((await call("/admin/report-builder", undefined, owner)).data.saved.map((s) => s.name), ["Sales joiners"]);

  // Rights: an employee has no reports; a leave-only role sees only leave; a branch role only its branch.
  const emp = await add("emp");
  assert.equal((await call("/admin/report-builder", undefined, emp.token)).status, 403);
  const leaveRole = (await call("/admin/roles", { name: "Leave desk", permissions: ["leave.read"] }, owner)).data.id;
  const desk = await add("desk", { role: "custom", custom_role_id: leaveRole });
  const deskMeta = (await call("/admin/report-builder", undefined, desk.token)).data;
  assert.deepEqual([deskMeta.datasets.map((d) => d.key), deskMeta.saved], [["leave"], []]);
  assert.equal((await run({ dataset: "employees" }, desk.token)).status, 403);
  assert.equal((await call(`/admin/report-builder/saved/${saved.data.id}`, undefined, desk.token, "DELETE")).status, 404);
  const jaipurRole = (await call("/admin/roles", { name: "Jaipur HR", permissions: ["employees.read"], branch_ids: [jaipur] }, owner)).data.id;
  const jhr = await add("jhr", { role: "custom", custom_role_id: jaipurRole, branch_id: jaipur });
  const scoped = await run({ dataset: "employees", group_by: "branch" }, jhr.token);
  assert.deepEqual(scoped.data.rows, [["Jaipur", 3]]);
  assert.equal((await call(`/admin/report-builder/saved/${saved.data.id}`, undefined, owner, "DELETE")).status, 200);
});
