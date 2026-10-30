import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";
import { delegationDay } from "../server/delegation.js";

test("a manager hands their approvals to a colleague for a period; nobody decides their own", async (t) => {
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
  const signIn = async (email, password) =>
    (await call("/login", { email, password, native: true, device: { id: `dev-${email.replace(/[^a-z0-9]/gi, "-")}`.slice(0, 60), platform: "android", model: "T" } })).data.token;
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (await call("/admin/workplaces", { name: "HO", latitude: 26.9, longitude: 75.8, radius: 150, max_accuracy: 50 }, owner)).data.id;
  const add = async (key, extra = {}) => {
    const r = await call("/admin/employees", { name: key.toUpperCase(), email: `${key}@example.test`, password: "Temporary-pass-123", workplace_id: site, ...extra }, owner);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(r.data.id);
    return { id: r.data.id, token: await signIn(`${key}@example.test`, "Temporary-pass-123") };
  };
  const hr = await add("hr", { role: "hr" });
  const boss = await add("boss");
  const emp = await add("emp", { manager_id: boss.id });
  const cover = await add("cover", { manager_id: boss.id });
  const other = await add("other");
  const day = delegationDay();
  const plus = (n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  const inbox = async (who) => (await call("/approvals", undefined, who.token)).data.regularizations.map((r) => r.employee_name);

  const req = (await call("/regularizations", { kind: "on_duty", date: day, reason: "Client visit" }, emp.token)).data.id;
  assert.ok(req);
  assert.deepEqual(await inbox(cover), []);
  assert.equal((await call(`/regularizations/${req}/decision`, { decision: "approved" }, cover.token)).status, 403);

  // Rules for a hand-over.
  assert.equal((await call("/delegations", { delegate_id: boss.id, starts_on: day, ends_on: plus(2) }, cover.token)).status, 409, "no team, nothing to hand over");
  assert.equal((await call("/delegations", { delegate_id: boss.id, starts_on: day, ends_on: plus(2) }, boss.token)).status, 400, "not to yourself");
  assert.equal((await call("/delegations", { delegate_id: cover.id, starts_on: plus(-1), ends_on: plus(2) }, boss.token)).status, 400, "not in the past");
  assert.equal((await call("/delegations", { delegate_id: cover.id, starts_on: day, ends_on: plus(95) }, boss.token)).status, 400, "up to 90 days");
  assert.equal((await call("/delegations", { delegate_id: cover.id, starts_on: day, ends_on: plus(2) }, other.token)).status, 409);
  assert.equal((await call("/delegations", { user_id: boss.id, delegate_id: cover.id, starts_on: day, ends_on: plus(2) }, other.token)).status, 403, "only HR sets one up for someone else");
  const d = await call("/delegations", { delegate_id: cover.id, starts_on: day, ends_on: plus(3), reason: "On leave" }, boss.token);
  assert.equal(d.status, 201, JSON.stringify(d.data));
  assert.equal((await call("/delegations", { delegate_id: other.id, starts_on: plus(1), ends_on: plus(5) }, boss.token)).status, 409, "no overlapping hand-overs");
  const mine = (await call("/delegations", undefined, cover.token)).data;
  assert.deepEqual([mine.received[0].delegator_name, mine.received[0].state], ["BOSS", "active"]);

  // The stand-in sees and decides the team's requests, but not their own.
  const own = (await call("/regularizations", { kind: "on_duty", date: day, reason: "Bank visit" }, cover.token)).data.id;
  assert.deepEqual((await inbox(cover)).sort(), ["EMP"]);
  assert.equal((await call(`/regularizations/${own}/decision`, { decision: "approved" }, cover.token)).status, 403);
  const dec = await call(`/regularizations/${req}/decision`, { decision: "approved" }, cover.token);
  assert.equal(dec.status, 200, JSON.stringify(dec.data));
  assert.equal((await db.prepare("SELECT status,decided_by FROM regularizations WHERE id=?").get(req)).decided_by, cover.id);
  // The manager still can, and someone with no hand-over still cannot.
  assert.equal((await call(`/regularizations/${own}/decision`, { decision: "approved" }, other.token)).status, 403);
  assert.equal((await call(`/regularizations/${own}/decision`, { decision: "approved" }, boss.token)).status, 200);

  // Cancelled: the access stops at once.
  const next = (await call("/regularizations", { kind: "on_duty", date: plus(-1), reason: "Audit" }, emp.token)).data.id;
  assert.equal((await call(`/delegations/${d.data.id}/cancel`, {}, cover.token)).status, 404, "only the manager or HR cancels");
  assert.equal((await call(`/delegations/${d.data.id}/cancel`, {}, boss.token)).status, 200);
  assert.deepEqual(await inbox(cover), []);
  assert.equal((await call(`/regularizations/${next}/decision`, { decision: "approved" }, cover.token)).status, 403);
  // HR can set one up for a manager, and sees all of them.
  assert.equal((await call("/delegations", { user_id: boss.id, delegate_id: other.id, starts_on: plus(1), ends_on: plus(4) }, hr.token)).status, 201);
  assert.deepEqual((await call("/admin/delegations", undefined, hr.token)).data.map((x) => [x.delegate_name, x.state]), [["OTHER", "upcoming"]]);
  assert.ok((await db.prepare("SELECT COUNT(*) n FROM audit WHERE action='approvals_delegated'").get()).n >= 2);
});
