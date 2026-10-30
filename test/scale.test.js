import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

// Pages that would otherwise send every row for thousands of people, and actions that reach
// everyone, stay small and quick.
test("attendance records page and search; overview's working-now list is capped; announcements reach everyone", async (t) => {
  const db = await openPglite();
  await createAdmin(db, { name: "Owner", email: "owner@example.test", password: "Owner-password-123", companyName: "Alpha Ltd" });
  const { server } = createApp({ db, clock: () => Date.parse("2026-10-29T16:00:00+05:30") });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((resolve) => {
    server.close(async () => { await db.close(); resolve(); });
    server.closeAllConnections();
  }));
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, body, token) => {
    const res = await fetch(base + path, {
      method: body === undefined ? "GET" : "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "owner@example.test", password: "Owner-password-123", native: true })).data.token;
  const now = new Date().toISOString();
  await db.prepare("INSERT INTO workplaces(company_id,name,latitude,longitude,radius,max_accuracy) VALUES(1,'HO',26.9,75.8,150,50)").run();
  const hash = (await db.prepare("SELECT password_hash FROM users WHERE id=1").get()).password_hash;
  await db
    .prepare(
      `INSERT INTO users(name,email,password_hash,role,company_id,created_at,employee_code,workplace_id,active)
       SELECT 'Person '||g,'p'||g||'@example.test',?,'employee',1,?,'P'||lpad(g::text,4,'0'),1,1 FROM generate_series(1,1200) g`,
    )
    .run(hash, now);
  // 250 punches today, most still working (no punch-out yet).
  await db
    .prepare(
      `INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at)
       SELECT u.id,1,'HO',26.9,75.8,150,50,to_char(timestamp '2026-10-29 03:30' + (u.id % 60) * interval '1 minute','YYYY-MM-DD"T"HH24:MI:SS".000Z"'),26.9,75.8,10,
         CASE WHEN u.id % 5 = 0 THEN to_char(timestamp '2026-10-29 10:00','YYYY-MM-DD"T"HH24:MI:SS".000Z"') END
       FROM users u WHERE u.email LIKE 'p%' ORDER BY u.id LIMIT 250`,
    )
    .run();

  const page0 = (await call("/admin/attendance?from=2026-10-29&to=2026-10-29&page=0", undefined, admin)).data;
  assert.deepEqual([page0.rows.length, page0.total, page0.page_size], [100, 250, 100]);
  const page2 = (await call("/admin/attendance?from=2026-10-29&to=2026-10-29&page=2", undefined, admin)).data;
  assert.equal(page2.rows.length, 50);
  assert.equal(new Set([...page0.rows, ...page2.rows].map((r) => r.id)).size, 150, "pages do not overlap");
  const found = (await call("/admin/attendance?from=2026-10-29&to=2026-10-29&page=0&q=P0042", undefined, admin)).data;
  assert.deepEqual([found.total, found.rows[0].employee_code], [1, "P0042"]);
  assert.equal((await call("/admin/attendance?from=2026-10-29&to=2026-10-29&page=-1", undefined, admin)).status, 400);
  // Without "page" (CSV export, older clients) everything still comes back.
  assert.equal((await call("/admin/attendance?from=2026-10-29&to=2026-10-29", undefined, admin)).data.length, 250);
  // A day boundary is the local day: nothing from the 28th or 30th.
  assert.equal((await call("/admin/attendance?from=2026-10-30&to=2026-10-30&page=0", undefined, admin)).data.total, 0);

  assert.equal((await call("/admin/active?limit=20", undefined, admin)).data.length, 20);
  assert.equal((await call("/admin/active", undefined, admin)).data.length, 200);

  // One announcement to all 1,200 people: one notification each, written in a few statements.
  const started = Date.now();
  const a = await call("/admin/announcements", { title: "Diwali", body: "Office closed on 8 Nov." }, admin);
  assert.equal(a.status, 201, JSON.stringify(a.data));
  assert.ok(Date.now() - started < 10000);
  const n = await db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT user_id) people FROM notifications WHERE title='Diwali'").get();
  assert.equal(Number(n.n), Number(n.people));
  assert.ok(Number(n.people) >= 1200, String(n.people));
});
