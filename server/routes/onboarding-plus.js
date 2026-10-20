import { HttpError, integer, oneOf, optionalString, string } from "../http.js";
import { requireOwned } from "../scope.js";

const GROUPS = ["it", "finance", "admin"];
export const GROUP_LABEL = { it: "IT", finance: "Finance", admin: "Admin" };
const KINDS = ["nda", "policy", "other"];

/** Tells the IT, Finance and Admin teams what is waiting for them when someone is hired. */
export async function notifyOwnerGroups(
  app,
  companyId,
  userId,
  name,
  joiningDate,
) {
  const { db } = app;
  const counts = await db
    .prepare(
      "SELECT owner,COUNT(*) n FROM onboarding_tasks WHERE user_id=? AND done=0 AND owner IN ('it','finance','admin') GROUP BY owner",
    )
    .all(userId);
  for (const c of counts) {
    const members = (
      await db
        .prepare(
          "SELECT user_id FROM onboarding_owner_members WHERE company_id=? AND owner=?",
        )
        .all(companyId, c.owner)
    ).map((m) => m.user_id);
    if (members.length)
      await app.notify(members, {
        companyId,
        kind: "onboarding",
        title: `New joiner ${name}: ${c.n} ${GROUP_LABEL[c.owner]} task${c.n > 1 ? "s" : ""}`,
        body: `Joining on ${joiningDate}. Please have these ready before day one.`,
        link: "approvals",
        email: true,
      });
  }
}

export function registerOnboardingPlus(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();

  // ---- which people handle IT, Finance and Admin tasks ----------------------------------------
  router.get(
    "/api/admin/onboarding/owners",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) => {
      const rows = await db
        .prepare(
          "SELECT m.owner,m.user_id,u.name FROM onboarding_owner_members m JOIN users u ON u.id=m.user_id WHERE m.company_id=? ORDER BY u.name",
        )
        .all(companyId);
      return send(
        200,
        Object.fromEntries(
          GROUPS.map((g) => [
            g,
            rows
              .filter((r) => r.owner === g)
              .map((r) => ({ id: r.user_id, name: r.name })),
          ]),
        ),
      );
    },
  );
  router.put(
    "/api/admin/onboarding/owners/:group",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const group = oneOf(params.group, "Team", GROUPS);
      const b = await body();
      const ids = [
        ...new Set((Array.isArray(b.user_ids) ? b.user_ids : []).map(integer)),
      ];
      if (ids.length > 20)
        throw new HttpError(400, "Choose up to 20 people per team.");
      for (const id of ids) {
        const u = await requireOwned(db, "users", id, companyId, "person");
        if (!u.active) throw new HttpError(400, "Choose active people.");
      }
      await db
        .prepare(
          "DELETE FROM onboarding_owner_members WHERE company_id=? AND owner=?",
        )
        .run(companyId, group);
      for (const id of ids)
        await db
          .prepare(
            "INSERT INTO onboarding_owner_members(company_id,owner,user_id) VALUES(?,?,?)",
          )
          .run(companyId, group, id);
      await audit("onboarding_owners_saved", { group, people: ids.length });
      return send(200, { ok: true });
    },
  );

  // ---- NDA and policy documents candidates sign before joining --------------------------------
  router.get(
    "/api/admin/joining-documents",
    { perm: "recruitment.manage" },
    async ({ companyId, send }) =>
      send(
        200,
        await db
          .prepare(
            `SELECT d.*,(SELECT COUNT(*) FROM joining_acks a WHERE a.document_id=d.id) signed
             FROM joining_documents d WHERE d.company_id=? ORDER BY d.active DESC,d.id`,
          )
          .all(companyId),
      ),
  );
  const fields = (b, cur = {}) => ({
    title: b.title === undefined ? cur.title : string(b.title, "Title", 150),
    body: b.body === undefined ? cur.body : string(b.body, "Text", 20000),
    kind:
      b.kind === undefined
        ? (cur.kind ?? "policy")
        : oneOf(b.kind, "Type", KINDS),
    required:
      b.required === undefined ? (cur.required ?? 1) : b.required ? 1 : 0,
    active: b.active === undefined ? (cur.active ?? 1) : b.active ? 1 : 0,
  });
  router.post(
    "/api/admin/joining-documents",
    { perm: "recruitment.manage" },
    async ({ companyId, body, send, audit }) => {
      const f = fields(await body(60_000));
      if (!f.title || !f.body)
        throw new HttpError(400, "Add a title and the text.");
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO joining_documents(company_id,title,body,kind,required,active,created_at) VALUES(?,?,?,?,?,?,?)",
            )
            .run(
              companyId,
              f.title,
              f.body,
              f.kind,
              f.required,
              f.active,
              nowIso(),
            )
        ).lastInsertRowid,
      );
      await audit("joining_document_added", { id });
      return send(201, { id });
    },
  );
  router.patch(
    "/api/admin/joining-documents/:id",
    { perm: "recruitment.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const d = await requireOwned(
        db,
        "joining_documents",
        integer(Number(params.id)),
        companyId,
        "document",
      );
      const f = fields(await body(60_000), d);
      await db
        .prepare(
          "UPDATE joining_documents SET title=?,body=?,kind=?,required=?,active=? WHERE id=?",
        )
        .run(f.title, f.body, f.kind, f.required, f.active, d.id);
      await audit("joining_document_updated", { id: d.id });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/employees/:id/joining-acks",
    { perm: "employees.read" },
    async ({ params, companyId, send }) => {
      const u = await requireOwned(
        db,
        "users",
        integer(Number(params.id)),
        companyId,
        "employee",
      );
      return send(
        200,
        await db
          .prepare(
            "SELECT id,title,given_name,given_ip,given_at FROM joining_acks WHERE user_id=? ORDER BY id",
          )
          .all(u.id),
      );
    },
  );
}

/** The documents a candidate must or may sign, with whether they already have. */
export async function agreementsFor(db, companyId, candidateId) {
  return db
    .prepare(
      `SELECT d.id,d.title,d.body,d.kind,d.required,a.given_at
       FROM joining_documents d LEFT JOIN joining_acks a ON a.document_id=d.id AND a.candidate_id=?
       WHERE d.company_id=? AND d.active=1 ORDER BY d.id`,
    )
    .all(candidateId, companyId);
}
export const optionalText = optionalString;
