import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const IST = (local) => Date.parse(`${local}+05:30`);

async function world(t, nowMs = IST("2026-11-09T10:00:00")) {
  const db = await openPglite();
  await createAdmin(db, { name: "Admin", email: "admin@example.test", password: "Admin-password-123" });
  const { server, app } = createApp({ db, clock: () => nowMs });
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
  const call = async (path, body, token, method) => {
    const res = await fetch(base + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: await res.json() };
  };
  const admin = (await call("/login", { email: "admin@example.test", password: "Admin-password-123", native: true })).data.token;
  // Web sign-in (cookie) is not needed: employees sign in on a phone with a device.
  const person = async (name, extra = {}) => {
    const email = `${name.toLowerCase()}@example.test`;
    const id = (await call("/admin/employees", { name, email, password: PW, ...extra }, admin)).data.id;
    await db.prepare("UPDATE users SET must_change_password=0 WHERE id=?").run(id);
    const token = (
      await call("/login", { email, password: PW, native: true, device: { id: `${name.toLowerCase()}-phone-000000001`, platform: "android", model: "Pixel" } })
    ).data.token;
    return { id, token };
  };
  return { db, app, call, admin, person };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n").toString("base64");

test("bulk HR documents: matched by employee code, private to each employee", async (t) => {
  const { call, admin, person } = await world(t);
  const ravi = await person("Ravi", { employee_code: "LIFC0101" });
  const sita = await person("Sita", { employee_code: "LIFC0102" });

  const m = await call("/admin/documents/match", { files: ["LIFC0101 increment.pdf", "lifc0102_ESI.pdf", "unknown.pdf"] }, admin);
  assert.equal(m.status, 200, JSON.stringify(m.data));
  assert.deepEqual(m.data.matches.map((x) => x.user?.employee_code ?? null), ["LIFC0101", "LIFC0102", null]);
  assert.ok(m.data.people.some((p) => p.id === ravi.id));
  // Only HR may match or upload.
  assert.equal((await call("/admin/documents/match", { files: ["a.pdf"] }, ravi.token)).status, 403);
  assert.equal((await call("/admin/documents/bulk", { user_id: sita.id, mime: "application/pdf", data: PDF }, ravi.token)).status, 403);

  const up = await call("/admin/documents/bulk", { user_id: ravi.id, kind: "hr_document", title: "Increment letter 2026", file_name: "LIFC0101 increment.pdf", mime: "application/pdf", data: PDF }, admin);
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const esi1 = (await call("/admin/documents/bulk", { user_id: sita.id, kind: "esi_card", file_name: "lifc0102_ESI.pdf", mime: "application/pdf", data: PDF }, admin)).data.id;
  const esi2 = (await call("/admin/documents/bulk", { user_id: sita.id, kind: "esi_card", file_name: "lifc0102_ESI.pdf", mime: "application/pdf", data: PDF }, admin)).data.id;

  // Ravi sees his letter, named by HR's title, and nothing of Sita's.
  const raviDocs = (await call("/my-hr-documents", undefined, ravi.token)).data;
  assert.deepEqual(raviDocs.map((d) => d.name), ["Increment letter 2026"]);
  assert.equal((await call(`/documents/${esi2}/file`, undefined, ravi.token)).status, 404);
  assert.equal((await call(`/documents?user_id=${sita.id}`, undefined, ravi.token)).status, 403);
  // Sita has one ESI card: the second replaced the first; the file name is the title when none given.
  const sitaDocs = (await call("/my-hr-documents", undefined, sita.token)).data;
  assert.deepEqual(sitaDocs.map((d) => [d.id, d.kind, d.name]), [[esi2, "esi_card", "lifc0102_ESI"]]);
  assert.equal((await call("/my-esi", undefined, sita.token)).data.card.id, esi2);
  assert.notEqual(esi1, esi2);
  assert.equal((await call(`/documents/${up.data.id}/file`, undefined, sita.token)).status, 404);
  // Employees cannot delete what HR gave them.
  assert.equal((await call(`/documents/${up.data.id}`, undefined, ravi.token, "DELETE")).status, 403);
});

test("bulk HR documents: ESIC certificates named by ESI number go to the right employee", async (t) => {
  const prevKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  t.after(() => {
    if (prevKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = prevKey;
  });
  const { call, admin, person } = await world(t);
  const asha = await person("Asha", { employee_code: "E0003" });
  const ravi = await person("Ravi", { employee_code: "E0004" });
  assert.equal((await call(`/admin/employees/${asha.id}/private`, { esi_ip: "1234567890", pan: "ABCDE1234F" }, admin, "PUT")).status, 200);
  assert.equal((await call(`/admin/employees/${ravi.id}/private`, { esi_ip: "2233445566" }, admin, "PUT")).status, 200);
  const m = (await call("/admin/documents/match", { files: ["1234567890.pdf", "ESIC_2233445566_ePehchan.pdf", "9999999999.pdf", "Asha_ABCDE1234F.pdf"] }, admin)).data.matches;
  assert.deepEqual(
    m.map((x) => [x.user?.employee_code ?? null, x.by]),
    [["E0003", "esi"], ["E0004", "esi"], [null, null], ["E0003", "pan"]],
  );
});
