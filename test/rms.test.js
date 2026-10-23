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


test("resumes from every source land in one inbox per job, without duplicates", async (t) => {
  const { call, owner, add } = await world(t);
  const job = (await call("/admin/openings", { title: "Branch Manager", positions: 2 }, owner)).data;
  assert.ok(job.id, JSON.stringify(job));
  const li = await call("/admin/rms/sources", { kind: "linkedin" }, owner);
  const wa = await call("/admin/rms/sources", { kind: "whatsapp", name: "WhatsApp 98290 00000" }, owner);
  assert.equal(li.status, 201, JSON.stringify(li.data));
  assert.match(li.data.key, /^rms_/);
  const list = (await call("/admin/rms/sources", undefined, owner)).data.items;
  assert.ok(list.every((s) => !("key" in s) && !("key_hash" in s)), "keys are never shown again");

  const intake = (key, b) => call(`/intake/${key}`, b);
  assert.equal((await intake("rms_wrong", { opening_id: job.id, name: "X" })).status, 401);
  const pdf = Buffer.from("%PDF-1.4\ncv\n").toString("base64");
  const first = await intake(li.data.key, { job_code: `J${job.id}`, name: "Asha Rao", email: "asha@example.com", phone: "+91 98290 11111", resume: { name: "asha.pdf", mime: "application/pdf", data: pdf } });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.equal(first.data.duplicate, false);
  // The same person from WhatsApp (phone only) joins the same record.
  const again = await intake(wa.data.key, { opening_id: job.id, name: "Asha", phone: "9829011111" });
  assert.deepEqual([again.data.id, again.data.duplicate], [first.data.id, true]);
  assert.equal((await intake(li.data.key, { opening_id: job.id, name: "Bad", resume: { name: "x.pdf", mime: "application/pdf", data: Buffer.from("nope").toString("base64") } })).status, 400);

  // HR imports two resumes from a job fair; one is the same Asha by email.
  const imp = await call(`/admin/rms/openings/${job.id}/resumes`, {
    kind: "job_fair",
    items: [
      { name: "Ravi Kumar", phone: "9000000001", resume: { name: "ravi.pdf", mime: "application/pdf", data: pdf } },
      { name: "Asha R", email: "ASHA@example.com" },
      { name: "" },
    ],
  }, owner);
  assert.equal(imp.status, 201, JSON.stringify(imp.data));
  assert.deepEqual(imp.data.results.map((r) => [r.ok, r.duplicate ?? null]), [[true, false], [true, true], [false, null]]);

  const inbox = (await call(`/admin/rms/openings/${job.id}/inbox`, undefined, owner)).data;
  assert.equal(inbox.people.length, 2);
  const asha = inbox.people.find((p) => p.id === first.data.id);
  assert.deepEqual(asha.sources.sort(), ["Job fair", "LinkedIn", "WhatsApp 98290 00000"]);
  assert.equal(asha.resumes, 1);
  const summary = (await call("/admin/rms/openings", undefined, owner)).data.find((o) => o.id === job.id);
  assert.equal(summary.candidates, 2);
  assert.ok(summary.sources.some((s) => s.name === "LinkedIn" && s.n === 1));
  // A switched-off source stops accepting.
  await call(`/admin/rms/sources/${li.data.id}`, { active: false }, owner, "PATCH");
  assert.equal((await intake(li.data.key, { opening_id: job.id, name: "Late" })).status, 401);
  // Only recruiters see the inbox.
  const emp = await add("emp");
  assert.equal((await call(`/admin/rms/openings/${job.id}/inbox`, undefined, emp.token)).status, 403);
});

test("the HR Team chat room is open only to people with the HR team chat right", async (t) => {
  const { call, owner, add } = await world(t);
  const hr = await add("hr", { role: "hr" });
  const emp = await add("emp");
  const role = await call("/admin/roles", { name: "Recruiter+", permissions: ["recruitment.manage", "hrchat.use"] }, owner);
  const rec = await add("rec", { role: "custom", custom_role_id: role.data.id });
  const room = async (who) => (await call("/chat/rooms", undefined, who.token)).data.find((r) => r.kind === "team");
  const team = await room(hr);
  assert.equal(team.title, "HR Team");
  assert.ok(await room(rec), "a custom role with the right is in");
  assert.equal(await room(emp), undefined, "an employee is not");
  assert.equal((await call(`/chat/rooms/${team.id}/messages`, { body: "Payroll cut-off is Friday" }, hr.token)).status, 201);
  assert.equal((await call(`/chat/rooms/${team.id}/messages`, undefined, emp.token)).status, 404);
  assert.equal((await call(`/chat/rooms/${team.id}/members/${rec.id}`, undefined, hr.token, "DELETE")).status, 409);
  // Taking the right away removes access straight away.
  await call(`/admin/roles/${role.data.id}`, { name: "Recruiter+", permissions: ["recruitment.manage"] }, owner, "PATCH");
  assert.equal((await call(`/chat/rooms/${team.id}/messages`, undefined, rec.token)).status, 404);
  assert.equal(await room(rec), undefined);
});
