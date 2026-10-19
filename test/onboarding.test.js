import { test } from "node:test";
import assert from "node:assert/strict";
import { openPglite } from "../server/pglite.js";
import { createAdmin } from "../server/db.js";
import { createApp } from "../server/index.js";

const PW = "Temporary-pass-123";
const secrets = new Map();

async function world(t) {
  let nowMs = Date.parse("2026-11-05T10:00:00+05:30");
  const db = await openPglite();
  await createAdmin(db, {
    name: "Owner",
    email: "owner@example.test",
    password: "Owner-password-123",
    companyName: "Alpha Ltd",
  });
  const { server, app } = createApp({ db, clock: () => nowMs });
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
  const call = async (path, body, token, method = "POST") => {
    const res = await fetch(base + path, {
      method: method !== "POST" ? method : body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      data:
        text.startsWith("{") || text.startsWith("[") ? JSON.parse(text) : text,
    };
  };
  const signIn = async (email, password = PW) => {
    const id = `phone-${email.replace(/[^A-Za-z0-9]/g, "-")}`
      .padEnd(16, "0")
      .slice(0, 64);
    const r = await call("/login", {
      email,
      password,
      native: true,
      device: { id, platform: "android", model: "T", secret: secrets.get(id) },
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (r.data.deviceSecret) secrets.set(id, r.data.deviceSecret);
    return r.data.token;
  };
  const owner = await signIn("owner@example.test", "Owner-password-123");
  const site = (
    await call(
      "/admin/workplaces",
      {
        name: "Office",
        latitude: 26.9,
        longitude: 75.8,
        radius: 150,
        max_accuracy: 50,
      },
      owner,
    )
  ).data.id;
  const people = {};
  const add = async (key, extra = {}) => {
    const r = await call(
      "/admin/employees",
      {
        name: key.toUpperCase(),
        email: `${key}@example.test`,
        password: PW,
        workplace_id: site,
        date_of_joining: "2026-01-01",
        ...extra,
      },
      owner,
    );
    assert.equal(r.status, 201, JSON.stringify(r.data));
    await db
      .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
      .run(r.data.id);
    people[key] = { id: r.data.id, token: await signIn(`${key}@example.test`) };
  };
  await add("hr", { role: "hr" });
  await add("pay", { role: "payroll" });
  await add("mgr");
  await add("emp");
  return {
    db,
    call,
    owner,
    people,
    site,
    add,
    signIn,
    app,
    setNow: (iso) => (nowMs = Date.parse(iso)),
  };
}

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\n").toString("base64");

test("pre-boarding: accept online, submit details, HR verifies, hire copies everything, probation is tracked", async (t) => {
  const prevKey = process.env.DATA_ENCRYPTION_KEY;
  process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
  t.after(() => {
    if (prevKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
    else process.env.DATA_ENCRYPTION_KEY = prevKey;
  });
  const w = await world(t);
  const { call, people, db, app, setNow } = w;
  const hr = people.hr.token;
  const cand = await call(
    "/admin/candidates",
    { name: "Asha Verma", email: "asha@example.test", phone: "9876543210" },
    hr,
  );
  const cid = cand.data.id;
  const offer = await call(
    `/admin/candidates/${cid}/offers`,
    {
      designation: "Branch Manager",
      monthly_gross: 50000,
      joining_date: "2026-11-20",
      probation_months: 3,
    },
    hr,
  );
  assert.equal(offer.status, 201, JSON.stringify(offer.data));
  // Cannot invite until the offer has been sent.
  assert.equal(
    (await call(`/admin/candidates/${cid}/preboarding/invite`, {}, hr)).status,
    409,
  );
  assert.equal(
    (
      await call(
        `/admin/offers/${offer.data.id}/status`,
        { status: "sent" },
        hr,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await call(
        `/admin/candidates/${cid}/preboarding/invite`,
        {},
        people.emp.token,
      )
    ).status,
    403,
  );
  const invite = await call(
    `/admin/candidates/${cid}/preboarding/invite`,
    {},
    hr,
  );
  assert.equal(invite.status, 201, JSON.stringify(invite.data));
  const token = new URL(invite.data.link, "http://x").searchParams.get("t");
  const join = (p, body, method) =>
    call(`/join/${token}${p}`, body, undefined, method);

  // The link is the credential: wrong links get nothing.
  assert.equal((await call("/join/not-a-real-token-at-all-0000")).status, 404);
  const page = await join("");
  assert.equal(page.status, 200);
  assert.equal(page.data.offer.status, "sent");
  assert.match(page.data.offer.letter.paragraphs.join(" "), /Branch Manager/);
  assert.equal(page.data.status, "invited");

  // Details cannot be submitted before the offer is accepted, and the typed name must match.
  assert.equal((await join("/submit", {})).status, 409);
  assert.equal(
    (await join("/accept", { full_name: "Someone Else" })).status,
    400,
  );
  assert.equal(
    (await join("/accept", { full_name: "  asha   VERMA " })).status,
    200,
  );
  const accepted = await db
    .prepare("SELECT * FROM offers WHERE id=?")
    .get(offer.data.id);
  assert.equal(accepted.status, "accepted");
  assert.equal(accepted.accepted_name, "asha   VERMA");
  assert.equal(
    (await join("/accept", { full_name: "Asha Verma" })).status,
    409,
  );

  // Form: bad PAN refused; good details saved; secrets are stored encrypted and shown masked.
  assert.equal((await join("/form", { pan: "nope" }, "PUT")).status, 400);
  assert.equal(
    (await join("/form", { date_of_birth: "2999-01-01" }, "PUT")).status,
    400,
  );
  const saved = await join(
    "/form",
    {
      date_of_birth: "1995-04-12",
      gender: "female",
      address: "12 MI Road, Jaipur",
      emergency_name: "Ravi Verma",
      emergency_phone: "9811111111",
      emergency_relation: "Brother",
      education: [{ degree: "B.Com", institute: "RU", year: "2016" }],
      pan: "abcde1234f",
      bank_account: "123456789012",
      ifsc: "HDFC0001234",
      account_holder: "Asha Verma",
      bank_name: "HDFC Bank",
    },
    "PUT",
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const raw = await db
    .prepare("SELECT sensitive FROM preboarding WHERE candidate_id=?")
    .get(cid);
  assert.ok(!raw.sensitive.includes("ABCDE1234F"));
  const reread = await join("");
  assert.equal(reread.data.status, "in_progress");
  assert.ok(!JSON.stringify(reread.data).includes("123456789012"));
  assert.match(reread.data.sensitive.pan, /234F$/);
  // Sending the masked value back must not overwrite the stored one.
  assert.equal(
    (
      await join(
        "/form",
        { pan: reread.data.sensitive.pan, address: "New address" },
        "PUT",
      )
    ).status,
    200,
  );

  // Documents: type is checked by content; submit needs both proofs.
  assert.equal(
    (
      await join("/documents", {
        kind: "id_proof",
        name: "aadhaar",
        mime: "application/pdf",
        data: Buffer.from("not a pdf").toString("base64"),
      })
    ).status,
    400,
  );
  const idDoc = await join("/documents", {
    kind: "id_proof",
    name: "aadhaar",
    mime: "application/pdf",
    data: PDF,
  });
  assert.equal(idDoc.status, 201);
  const early = await join("/submit", {});
  assert.equal(early.status, 400);
  assert.match(early.data.error, /address proof/);
  const addrDoc = await join("/documents", {
    kind: "address_proof",
    name: "bill",
    mime: "application/pdf",
    data: PDF,
  });
  assert.equal((await join("/submit", {})).status, 200);
  // Locked after submission.
  assert.equal((await join("/form", { address: "x" }, "PUT")).status, 409);
  assert.equal(
    (await join(`/documents/${addrDoc.data.id}`, undefined, "DELETE")).status,
    409,
  );

  // HR must verify the proofs, can send it back, and the candidate can fix and resubmit.
  const review = (body) =>
    call(`/admin/candidates/${cid}/preboarding/review`, body, hr);
  assert.equal((await review({ decision: "verified" })).status, 409);
  assert.equal((await review({ decision: "changes_requested" })).status, 400);
  assert.equal(
    (
      await review({
        decision: "changes_requested",
        note: "Photo of ID is blurred",
      })
    ).status,
    200,
  );
  assert.equal((await join("")).data.hr_note, "Photo of ID is blurred");
  assert.equal((await join("/submit", {})).status, 200);
  const view = await call(
    `/admin/candidates/${cid}/preboarding`,
    undefined,
    hr,
  );
  assert.equal(view.data.status, "submitted");
  assert.ok(!JSON.stringify(view.data).includes("123456789012"));
  for (const d of view.data.documents)
    assert.equal(
      (await call(`/admin/preboarding/documents/${d.id}/verify`, {}, hr))
        .status,
      200,
    );
  assert.equal((await review({ decision: "verified" })).status, 200);

  // Pipeline view for HR.
  const joiners = await call("/admin/onboarding/joiners", undefined, hr);
  assert.equal(joiners.data.pending[0].preboarding_status, "verified");
  assert.equal(joiners.data.pending[0].docs_verified, 2);

  // Hire: profile, documents and bank/PAN details move across; probation and buddy are set.
  const hired = await call(
    `/admin/candidates/${cid}/hire`,
    { password: PW, manager_id: people.mgr.id, buddy_id: people.emp.id },
    hr,
  );
  assert.equal(hired.status, 201, JSON.stringify(hired.data));
  const uid = hired.data.user_id;
  const u = await db.prepare("SELECT * FROM users WHERE id=?").get(uid);
  assert.equal(u.address, "New address");
  assert.equal(u.emergency_name, "Ravi Verma");
  assert.equal(u.date_of_birth, "1995-04-12");
  assert.equal(u.probation_end_date, "2027-02-20");
  assert.equal(u.buddy_id, people.emp.id);
  const docs = await db
    .prepare("SELECT * FROM documents WHERE user_id=?")
    .all(uid);
  assert.equal(docs.length, 2);
  assert.ok(docs.every((d) => d.verified_at));
  const priv = await call(
    `/admin/employees/${uid}/private?reveal=1`,
    undefined,
    people.pay.token,
  );
  assert.equal(priv.status, 200, JSON.stringify(priv.data));
  assert.match(JSON.stringify(priv.data), /234F/);
  const buddyNote = await db
    .prepare(
      "SELECT * FROM notifications WHERE user_id=? AND kind='onboarding'",
    )
    .all(people.emp.id);
  assert.equal(buddyNote.length, 1);
  // The link stops working once the person has joined.
  assert.equal((await join("")).status, 410);

  // Probation: nothing due yet; reminders go out within 15 days, once; extending resets them.
  const { sendProbationReminders } =
    await import("../server/routes/probation.js");
  assert.equal((await call("/admin/probation", undefined, hr)).data.length, 0);
  assert.equal(
    (await call("/admin/probation?days=120", undefined, hr)).data.length,
    1,
  );
  assert.equal(await sendProbationReminders(app), 0);
  setNow("2027-02-10T10:00:00+05:30");
  assert.equal(await sendProbationReminders(app), 1);
  assert.equal(await sendProbationReminders(app), 0);
  const mgrNotes = await db
    .prepare(
      "SELECT title FROM notifications WHERE user_id=? AND title LIKE '%probation%'",
    )
    .all(people.mgr.id);
  assert.equal(mgrNotes.length, 1);
  assert.equal(
    (
      await call(
        `/admin/employees/${uid}/probation`,
        { extend_months: 1 },
        people.emp.token,
      )
    ).status,
    403,
  );
  const ext = await call(
    `/admin/employees/${uid}/probation`,
    { extend_months: 1 },
    hr,
  );
  assert.equal(ext.data.probation_end_date, "2027-03-20");
  assert.equal(await sendProbationReminders(app), 0);
  // A confirmation ends probation.
  const conf = await call(
    "/admin/changes",
    { user_id: uid, kind: "confirmation", effective_date: "2027-02-10" },
    hr,
  );
  assert.equal(conf.status, 201, JSON.stringify(conf.data));
  assert.equal(
    (await call(`/admin/changes/${conf.data.id}/apply`, {}, hr)).status,
    200,
  );
  assert.equal(
    (
      await db
        .prepare("SELECT probation_end_date FROM users WHERE id=?")
        .get(uid)
    ).probation_end_date,
    null,
  );
});

test("an expired or declined pre-boarding link is closed", async (t) => {
  const w = await world(t);
  const { call, people, setNow } = w;
  const hr = people.hr.token;
  const mk = async (name) => {
    const c = await call(
      "/admin/candidates",
      { name, email: `${name.split(" ")[0].toLowerCase()}@example.test` },
      hr,
    );
    const o = await call(
      `/admin/candidates/${c.data.id}/offers`,
      {
        designation: "Clerk",
        monthly_gross: 20000,
        joining_date: "2026-11-30",
      },
      hr,
    );
    await call(`/admin/offers/${o.data.id}/status`, { status: "sent" }, hr);
    const inv = await call(
      `/admin/candidates/${c.data.id}/preboarding/invite`,
      {},
      hr,
    );
    return {
      cid: c.data.id,
      token: new URL(inv.data.link, "http://x").searchParams.get("t"),
    };
  };
  const a = await mk("Dev Kumar");
  const b = await mk("Ela Rao");
  assert.equal(
    (await call(`/join/${a.token}/decline`, { reason: "Got another job" }))
      .status,
    200,
  );
  assert.equal((await call(`/join/${a.token}`)).status, 410);
  setNow("2027-01-15T10:00:00+05:30");
  assert.equal((await call(`/join/${b.token}`)).status, 410);
  // HR can send a fresh link.
  const again = await call(
    `/admin/candidates/${b.cid}/preboarding/invite`,
    {},
    hr,
  );
  assert.equal(again.status, 201);
});
