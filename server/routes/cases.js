import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { HttpError, integer, isoDate, oneOf, optionalId, optionalString, string } from "../http.js";
import { can } from "../rbac.js";
import { staffWith } from "../scope.js";
import { addDays } from "../calendar.js";

// Grievances, POSH complaints and whistleblower reports.
// - Grievances are handled by HR (the cases.manage right).
// - POSH complaints only by the Internal Committee, whistleblower reports only by the
//   vigilance committee (case_committee); HR and admins see neither unless they are members.
// - Nobody named in a case sees it as a handler, and nobody handles their own case.
// - Anonymous reports (not POSH: the law needs a named complainant) store no reporter;
//   the reporter follows up with the case code and a one-time key.
// - Every time a handler opens a case it is in the activity log.
export const KINDS = {
  grievance: { label: "Grievance", prefix: "GR", days: 30, anonymous: true },
  posh: { label: "POSH complaint", prefix: "PC", days: 90, anonymous: false },
  whistleblower: { label: "Whistleblower report", prefix: "WB", days: 60, anonymous: true },
};
export const CATEGORIES = {
  grievance: ["Pay and benefits", "Workload or working hours", "Manager or colleague", "Leave or attendance", "Transfer or role", "Facilities or safety", "Other"],
  posh: ["Unwelcome physical contact", "Request for sexual favours", "Sexually coloured remarks", "Showing pornography", "Other unwelcome conduct"],
  whistleblower: ["Fraud or misuse of funds", "Bribery or corruption", "Loan or KYC irregularity", "Data leak or misuse", "Violation of law or RBI rules", "Other unethical conduct"],
};
const STATUS = ["open", "investigating", "resolved", "closed"];
const sha = (s) => createHash("sha256").update(s).digest("hex");
const sameHash = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function caseKindsHandled(db, user) {
  const kinds = can(user, "cases.manage") ? ["grievance"] : [];
  const rows = await db.prepare("SELECT kind FROM case_committee WHERE company_id=? AND user_id=?").all(user.company_id, user.id);
  return [...kinds, ...rows.map((r) => r.kind)];
}

export function registerCases(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const today = () => app.dayOf(nowIso());

  const handlers = async (companyId, kind, exclude = []) => {
    const ids =
      kind === "grievance"
        ? (await staffWith(db, companyId, ["cases.manage"])).map((r) => r.id)
        : (await db.prepare("SELECT user_id FROM case_committee WHERE company_id=? AND kind=?").all(companyId, kind)).map((r) => r.user_id);
    return ids.filter((id) => !exclude.includes(id));
  };
  // A case as its handler may see it: never one that names them or that they raised.
  async function handledCase(user, id) {
    const c = await db.prepare("SELECT * FROM cases WHERE id=? AND company_id=?").get(integer(Number(id)), user.company_id);
    const kinds = await caseKindsHandled(db, user);
    if (!c || !kinds.includes(c.kind) || c.against_user_id === user.id || c.reporter_id === user.id)
      throw new HttpError(404, "Case not found.");
    return c;
  }
  const messagesOf = async (caseId, withInternal) =>
    db
      .prepare(
        `SELECT m.id,m.body,m.from_reporter,m.internal,m.created_at,CASE WHEN m.from_reporter=1 THEN NULL ELSE u.name END author
         FROM case_messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.case_id=?${withInternal ? "" : " AND m.internal=0"} ORDER BY m.id`,
      )
      .all(caseId);
  // What the reporter sees: status, outcome and the replies, never internal notes or handlers' notes.
  const reporterView = async (c) => ({
    id: c.id,
    code: c.code,
    kind: c.kind,
    category: c.category,
    subject: c.subject,
    description: c.description,
    anonymous: Boolean(c.anonymous),
    status: c.status,
    outcome: c.status === "resolved" || c.status === "closed" ? c.outcome : null,
    created_at: c.created_at,
    updated_at: c.updated_at,
    messages: (await messagesOf(c.id, false)).map((m) => ({ ...m, author: m.from_reporter ? "You" : "Committee / HR" })),
  });

  router.get("/api/cases/options", async ({ send }) =>
    send(200, Object.fromEntries(Object.entries(KINDS).map(([k, v]) => [k, { ...v, categories: CATEGORIES[k] }]))),
  );

  router.post("/api/cases", async ({ user, body, send }) => {
    app.rateLimit(`case:${user.id}`, 10, 86400000);
    const b = await body();
    const kind = oneOf(b.kind, "Type", Object.keys(KINDS));
    const category = oneOf(b.category, "Category", CATEGORIES[kind]);
    const anonymous = b.anonymous === true;
    if (anonymous && !KINDS[kind].anonymous)
      throw new HttpError(400, "A POSH complaint needs your name so the Internal Committee can inquire. It stays confidential to the committee.");
    const against = optionalId(b.against_user_id, "Person");
    if (against) {
      const p = await db.prepare("SELECT id FROM users WHERE id=? AND company_id=?").get(against, user.company_id);
      if (!p) throw new HttpError(404, "That person was not found.");
      if (against === user.id) throw new HttpError(400, "Choose someone else.");
    }
    const incident = isoDate(b.incident_date, "Date of the incident");
    if (incident && incident > today()) throw new HttpError(400, "The date of the incident cannot be in the future.");
    const key = anonymous ? randomBytes(18).toString("base64url") : null;
    const at = nowIso();
    const created = await transaction(async () => {
      let code, id;
      for (let tries = 0; !id && tries < 5; tries++) {
        code = `${KINDS[kind].prefix}-${randomBytes(4).toString("hex").toUpperCase()}`;
        if (await db.prepare("SELECT id FROM cases WHERE code=?").get(code)) continue;
        id = Number(
          (
            await db
              .prepare(
                `INSERT INTO cases(company_id,kind,code,reporter_id,anonymous,follow_key_hash,category,subject,description,against_user_id,against_text,incident_date,branch_id,due_date,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                user.company_id,
                kind,
                code,
                anonymous ? null : user.id,
                anonymous ? 1 : 0,
                key ? sha(key) : null,
                category,
                string(b.subject, "Subject", 150),
                string(b.description, "What happened", 5000),
                against,
                optionalString(b.against_text, "Who is involved", 200),
                incident,
                anonymous ? null : user.branch_id ?? null,
                addDays(today(), KINDS[kind].days),
                at,
                at,
              )
          ).lastInsertRowid,
        );
      }
      // The log says a case was raised, never by whom when it is anonymous.
      await app.audit(anonymous ? null : user, "case_raised", { id, kind, anonymous }, user.company_id);
      return { id, code };
    });
    const to = await handlers(user.company_id, kind, [user.id, against].filter(Boolean));
    if (to.length)
      await app.notify(to, {
        companyId: user.company_id,
        kind: "approval",
        title: `New ${KINDS[kind].label.toLowerCase()} ${created.code}`,
        body: `${category}. Open Administration → Cases.`,
        link: "cases",
      });
    else
      await app.notify((await staffWith(db, user.company_id, ["roles.assign"])).map((r) => r.id), {
        companyId: user.company_id,
        kind: "approval",
        title: `A ${KINDS[kind].label.toLowerCase()} was raised, but nobody is set up to handle it`,
        body: kind === "grievance" ? "Give someone the Cases right." : "Name the committee under Administration → Cases.",
        link: "cases",
      });
    return send(201, { ...created, ...(key ? { follow_key: key } : {}) });
  });

  router.get("/api/cases/mine", async ({ user, send }) => {
    const rows = await db.prepare("SELECT * FROM cases WHERE reporter_id=? ORDER BY id DESC LIMIT 50").all(user.id);
    const out = [];
    for (const c of rows) out.push(await reporterView(c));
    return send(200, out);
  });

  // An anonymous reporter follows up with the code and key; wrong pairs all look the same.
  const followed = async (b, user) => {
    app.rateLimit(`case-follow:${user.id}`, 30);
    const c = await db
      .prepare("SELECT * FROM cases WHERE code=? AND company_id=? AND anonymous=1")
      .get(String(b.code ?? "").trim().toUpperCase(), user.company_id);
    if (!c || !sameHash(c.follow_key_hash, sha(String(b.key ?? "").trim())))
      throw new HttpError(404, "No case matches that code and key.");
    return c;
  };
  router.post("/api/cases/follow", async ({ user, body, send }) => send(200, await reporterView(await followed(await body(), user))));

  async function reporterReply(c, text, user) {
    if (c.status === "closed") throw new HttpError(409, "This case is closed.");
    await db
      .prepare("INSERT INTO case_messages(case_id,author_id,from_reporter,body,created_at) VALUES(?,?,1,?,?)")
      .run(c.id, c.anonymous ? null : user.id, text, nowIso());
    await db.prepare("UPDATE cases SET updated_at=? WHERE id=?").run(nowIso(), c.id);
    const to = c.assigned_to ? [c.assigned_to] : await handlers(c.company_id, c.kind, [c.reporter_id, c.against_user_id].filter(Boolean));
    await app.notify(to, { companyId: c.company_id, kind: "approval", title: `New message on case ${c.code}`, link: "cases" });
  }
  router.post("/api/cases/follow/reply", async ({ user, body, send }) => {
    const b = await body();
    const c = await followed(b, user);
    await reporterReply(c, string(b.body, "Message", 3000), user);
    return send(201, { ok: true });
  });
  router.post("/api/cases/:id/reply", async ({ user, params, body, send }) => {
    const c = await db.prepare("SELECT * FROM cases WHERE id=? AND reporter_id=?").get(integer(Number(params.id)), user.id);
    if (!c) throw new HttpError(404, "Case not found.");
    await reporterReply(c, string((await body()).body, "Message", 3000), user);
    return send(201, { ok: true });
  });

  // ---- handlers ------------------------------------------------------------------------------
  router.get("/api/admin/cases", async ({ user, query, send }) => {
    const kinds = await caseKindsHandled(db, user);
    if (!kinds.length) throw new HttpError(403, "You do not handle cases.");
    const kind = query.get("kind") ? oneOf(query.get("kind"), "Type", kinds) : null;
    const status = query.get("status") ? oneOf(query.get("status"), "Status", STATUS) : null;
    const rows = await db
      .prepare(
        `SELECT c.id,c.code,c.kind,c.category,c.subject,c.status,c.anonymous,c.due_date,c.created_at,c.updated_at,c.assigned_to,a.name assigned_name,
           CASE WHEN c.anonymous=1 THEN NULL ELSE r.name END reporter_name
         FROM cases c LEFT JOIN users r ON r.id=c.reporter_id LEFT JOIN users a ON a.id=c.assigned_to
         WHERE c.company_id=? AND c.kind IN (${kinds.map(() => "?").join(",")})${kind ? " AND c.kind=?" : ""}${status ? " AND c.status=?" : ""}
           AND (c.against_user_id IS NULL OR c.against_user_id<>?) AND (c.reporter_id IS NULL OR c.reporter_id<>?)
         ORDER BY CASE c.status WHEN 'open' THEN 0 WHEN 'investigating' THEN 1 ELSE 2 END, c.due_date, c.id LIMIT 500`,
      )
      .all(user.company_id, ...kinds, ...(kind ? [kind] : []), ...(status ? [status] : []), user.id, user.id);
    const t = today();
    return send(200, {
      kinds,
      cases: rows.map((c) => ({ ...c, anonymous: Boolean(c.anonymous), overdue: ["open", "investigating"].includes(c.status) && c.due_date < t })),
    });
  });

  router.get("/api/admin/cases/:id", async ({ user, params, send, audit }) => {
    const c = await handledCase(user, params.id);
    const people = await db
      .prepare("SELECT id,name,employee_code FROM users WHERE id IN (?,?,?)")
      .all(c.reporter_id ?? 0, c.against_user_id ?? 0, c.assigned_to ?? 0);
    const who = (id) => people.find((p) => p.id === id) ?? null;
    await audit("case_viewed", { id: c.id, kind: c.kind });
    return send(200, {
      ...c,
      follow_key_hash: undefined,
      anonymous: Boolean(c.anonymous),
      reporter: c.anonymous ? null : who(c.reporter_id),
      against: who(c.against_user_id),
      assigned: who(c.assigned_to),
      messages: await messagesOf(c.id, true),
      handlers: (
        await db
          .prepare(`SELECT id,name FROM users WHERE id IN (${(await handlers(c.company_id, c.kind, [c.reporter_id, c.against_user_id].filter(Boolean))).concat(0).join(",")}) ORDER BY name`)
          .all()
      ),
    });
  });

  router.patch("/api/admin/cases/:id", async ({ user, params, body, send, audit }) => {
    const b = await body();
    const c = await handledCase(user, params.id);
    if (c.status === "closed") throw new HttpError(409, "This case is closed.");
    const set = { updated_at: nowIso() };
    if (b.assigned_to !== undefined) {
      const to = optionalId(b.assigned_to, "Assigned to");
      if (to && !(await handlers(c.company_id, c.kind, [c.reporter_id, c.against_user_id].filter(Boolean))).includes(to))
        throw new HttpError(400, "Assign the case to someone who handles this kind of case and is not named in it.");
      set.assigned_to = to;
    }
    if (b.status !== undefined) {
      set.status = oneOf(b.status, "Status", STATUS);
      if (["resolved", "closed"].includes(set.status)) {
        set.outcome = string(b.outcome ?? c.outcome, "Outcome", 3000);
        set.resolved_at = c.resolved_at ?? nowIso();
      }
    }
    const keys = Object.keys(set);
    await db.prepare(`UPDATE cases SET ${keys.map((k) => `${k}=?`).join(",")} WHERE id=?`).run(...keys.map((k) => set[k]), c.id);
    await audit("case_updated", { id: c.id, status: set.status ?? c.status, assigned_to: set.assigned_to ?? c.assigned_to });
    if (set.status && set.status !== c.status && c.reporter_id)
      await app.notify([c.reporter_id], {
        companyId: c.company_id,
        kind: "approval",
        title: `Your case ${c.code} is now ${set.status}`,
        link: "concerns",
      });
    return send(200, { ok: true });
  });

  router.post("/api/admin/cases/:id/messages", async ({ user, params, body, send, audit }) => {
    const b = await body();
    const c = await handledCase(user, params.id);
    if (c.status === "closed") throw new HttpError(409, "This case is closed.");
    const internal = b.internal === true;
    await db
      .prepare("INSERT INTO case_messages(case_id,author_id,from_reporter,internal,body,created_at) VALUES(?,?,0,?,?,?)")
      .run(c.id, user.id, internal ? 1 : 0, string(b.body, "Message", 3000), nowIso());
    await db.prepare("UPDATE cases SET updated_at=? WHERE id=?").run(nowIso(), c.id);
    await audit(internal ? "case_note_added" : "case_reply_sent", { id: c.id });
    if (!internal && c.reporter_id)
      await app.notify([c.reporter_id], { companyId: c.company_id, kind: "approval", title: `Reply on your case ${c.code}`, link: "concerns" });
    return send(201, { ok: true });
  });

  // ---- committees ------------------------------------------------------------------------------
  router.get("/api/admin/case-committees", { perm: "roles.assign" }, async ({ companyId, send }) => {
    const rows = await db
      .prepare("SELECT k.kind,u.id,u.name,u.employee_code FROM case_committee k JOIN users u ON u.id=k.user_id WHERE k.company_id=? ORDER BY u.name")
      .all(companyId);
    return send(200, {
      posh: rows.filter((r) => r.kind === "posh"),
      whistleblower: rows.filter((r) => r.kind === "whistleblower"),
    });
  });
  router.put("/api/admin/case-committees/:kind", { perm: "roles.assign" }, async ({ companyId, params, body, send, audit }) => {
    const kind = oneOf(params.kind, "Committee", ["posh", "whistleblower"]);
    const ids = [...new Set(((await body()).user_ids ?? []).map((v) => integer(Number(v))))];
    if (ids.length > 25) throw new HttpError(400, "A committee can have up to 25 members.");
    if (ids.length) {
      const found = await db
        .prepare(`SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1 AND id IN (${ids.map(() => "?").join(",")})`)
        .get(companyId, ...ids);
      if (Number(found.n) !== ids.length) throw new HttpError(404, "Employee not found.");
    }
    await transaction(async () => {
      await db.prepare("DELETE FROM case_committee WHERE company_id=? AND kind=?").run(companyId, kind);
      for (const id of ids) await db.prepare("INSERT INTO case_committee(company_id,kind,user_id) VALUES(?,?,?)").run(companyId, kind, id);
    });
    await audit("case_committee_set", { kind, members: ids.length });
    return send(200, { ok: true });
  });
}
