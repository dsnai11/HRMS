import {
  HttpError,
  integer,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned, staffWith } from "../scope.js";
import {
  ageCategory,
  incomeTax,
  standardDeduction,
  taxYearOf,
} from "../payroll/tax.js";

export const SECTIONS = {
  "80C": {
    label:
      "Section 80C (PF, PPF, LIC, ELSS, tuition fees, home loan principal)",
    cap: 150000,
  },
  "80CCD1B": { label: "NPS additional contribution (80CCD(1B))", cap: 50000 },
  "80D": { label: "Medical insurance premium (80D)", cap: 100000 },
  "24B": { label: "Home loan interest (24(b))", cap: 200000 },
  "80E": { label: "Education loan interest (80E)", cap: null },
  "80G": { label: "Donations (80G)", cap: null },
  "80TTA": { label: "Savings account interest (80TTA/80TTB)", cap: 50000 },
  HRA: { label: "House rent allowance exemption", cap: null },
};
const MAX_ITEMS = 30;

/** What counts towards deductions: verified amounts, pending ones provisionally, rejected ones not at all; capped per section. */
export function allowedDeductions(items) {
  const per = {};
  for (const it of items) {
    const used =
      it.status === "verified"
        ? (it.verified_amount ?? 0)
        : it.status === "rejected"
          ? 0
          : it.amount;
    per[it.section] = (per[it.section] ?? 0) + used;
  }
  let total = 0;
  const bySection = {};
  for (const [s, v] of Object.entries(per)) {
    const cap = SECTIONS[s]?.cap;
    bySection[s] = Math.round(cap == null ? v : Math.min(v, cap));
    total += bySection[s];
  }
  return { total, bySection };
}

export function registerTaxDeclarations(router, app) {
  const { db, transaction, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const currentYear = () => taxYearOf(nowIso().slice(0, 7));
  const yearOf = (q) => {
    const y = q.get("year") ? Number(q.get("year")) : currentYear();
    if (!Number.isInteger(y) || y < 2020 || y > 2100)
      throw new HttpError(400, "Choose a valid tax year.");
    return y;
  };

  const itemsOf = (id) =>
    db
      .prepare(
        `SELECT i.*,d.name proof_name FROM tax_declaration_items i LEFT JOIN documents d ON d.id=i.document_id WHERE i.declaration_id=? ORDER BY i.id`,
      )
      .all(id);
  const loadOrNew = async (user, year) =>
    (await db
      .prepare("SELECT * FROM tax_declarations WHERE user_id=? AND tax_year=?")
      .get(user.id, year)) ?? null;

  // Pushes the allowed total and the chosen regime into the salary record that payroll reads.
  async function apply(decl) {
    if (
      decl.tax_year !== currentYear() ||
      !["submitted", "verified"].includes(decl.status)
    )
      return;
    const { total } = allowedDeductions(await itemsOf(decl.id));
    await db
      .prepare(
        "UPDATE employee_salaries SET declared_deductions=?,tax_regime=? WHERE id=(SELECT id FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC,id DESC LIMIT 1)",
      )
      .run(decl.regime === "old" ? total : 0, decl.regime, decl.user_id);
  }

  // A rough comparison of tax under both regimes, so the choice is informed.
  async function compare(user, year, items) {
    const sal = await db
      .prepare(
        "SELECT monthly_gross FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC,id DESC LIMIT 1",
      )
      .get(user.id);
    if (!sal) return null;
    const annual = sal.monthly_gross * 12;
    const age = ageCategory(user.date_of_birth, year);
    const { total } = allowedDeductions(items);
    const tax = (regime, deductions) =>
      incomeTax(
        regime,
        Math.max(0, annual - standardDeduction(regime, year) - deductions),
        { taxYear: year, age },
      );
    return {
      annual_gross: Math.round(annual),
      old: tax("old", total),
      new: tax("new", 0),
      declared: total,
    };
  }

  const view = async (user, year) => {
    const d = await loadOrNew(user, year);
    const items = d ? await itemsOf(d.id) : [];
    const company = await db
      .prepare("SELECT declaration_open FROM companies WHERE id=?")
      .get(user.company_id);
    return {
      tax_year: year,
      label: `${year}-${String(year + 1).slice(2)}`,
      open: Boolean(company.declaration_open),
      declaration: d && {
        id: d.id,
        status: d.status,
        regime: d.regime,
        review_note: d.review_note,
        submitted_at: d.submitted_at,
      },
      editable:
        Boolean(company.declaration_open) &&
        (!d || ["draft", "changes_requested"].includes(d.status)),
      items,
      allowed: allowedDeductions(items),
      sections: Object.entries(SECTIONS).map(([key, s]) => ({
        key,
        label: s.label,
        cap: s.cap,
      })),
      comparison: await compare(user, year, items),
    };
  };
  router.get("/api/tax-declaration", async ({ user, query, send }) =>
    send(200, await view(user, yearOf(query))),
  );

  router.put(
    "/api/tax-declaration",
    async ({ user, query, body, send, audit }) => {
      const year = yearOf(query);
      const b = await body(64_000);
      const company = await db
        .prepare("SELECT declaration_open FROM companies WHERE id=?")
        .get(user.company_id);
      if (!company.declaration_open)
        throw new HttpError(
          409,
          "Declarations are closed for now. Ask payroll.",
        );
      let d = await loadOrNew(user, year);
      if (d && !["draft", "changes_requested"].includes(d.status))
        throw new HttpError(
          409,
          "This declaration has been submitted. Payroll is reviewing it.",
        );
      const regime =
        b.regime === undefined
          ? (d?.regime ?? "new")
          : oneOf(b.regime, "Tax regime", ["new", "old"]);
      const list = Array.isArray(b.items) ? b.items : [];
      if (list.length > MAX_ITEMS)
        throw new HttpError(400, `Add up to ${MAX_ITEMS} items.`);
      const clean = [];
      for (const [i, it] of list.entries()) {
        const section = oneOf(
          it?.section,
          `Item ${i + 1} section`,
          Object.keys(SECTIONS),
        );
        const amount = Math.round(
          number(it?.amount, `Item ${i + 1} amount`, 0, 1e8),
        );
        let docId = null;
        if (it?.document_id) {
          const doc = await db
            .prepare("SELECT id,user_id,deleted_at FROM documents WHERE id=?")
            .get(integer(Number(it.document_id)));
          if (!doc || doc.user_id !== user.id || doc.deleted_at)
            throw new HttpError(
              400,
              `Item ${i + 1}: the proof document is not yours.`,
            );
          docId = doc.id;
        }
        clean.push({
          section,
          amount,
          description:
            optionalString(it?.description, "Description", 150) || null,
          document_id: docId,
        });
      }
      await transaction(async () => {
        if (!d) {
          const id = Number(
            (
              await db
                .prepare(
                  "INSERT INTO tax_declarations(company_id,user_id,tax_year,regime,created_at) VALUES(?,?,?,?,?)",
                )
                .run(user.company_id, user.id, year, regime, nowIso())
            ).lastInsertRowid,
          );
          d = { id };
        } else
          await db
            .prepare("UPDATE tax_declarations SET regime=? WHERE id=?")
            .run(regime, d.id);
        await db
          .prepare("DELETE FROM tax_declaration_items WHERE declaration_id=?")
          .run(d.id);
        for (const it of clean)
          await db
            .prepare(
              "INSERT INTO tax_declaration_items(declaration_id,section,description,amount,document_id) VALUES(?,?,?,?,?)",
            )
            .run(d.id, it.section, it.description, it.amount, it.document_id);
        await audit("tax_declaration_saved", { year, items: clean.length });
      });
      return send(200, await view(user, year));
    },
  );
  router.post(
    "/api/tax-declaration/submit",
    async ({ user, query, send, audit }) => {
      const year = yearOf(query);
      const d = await loadOrNew(user, year);
      if (!d) throw new HttpError(409, "Add your declaration first.");
      if (!["draft", "changes_requested"].includes(d.status))
        throw new HttpError(409, "Already submitted.");
      const company = await db
        .prepare("SELECT declaration_open FROM companies WHERE id=?")
        .get(user.company_id);
      if (!company.declaration_open)
        throw new HttpError(
          409,
          "Declarations are closed for now. Ask payroll.",
        );
      // Items sent back for correction start again from pending.
      await db
        .prepare(
          "UPDATE tax_declaration_items SET status='pending' WHERE declaration_id=? AND status='rejected'",
        )
        .run(d.id);
      await db
        .prepare(
          "UPDATE tax_declarations SET status='submitted',submitted_at=?,review_note=NULL WHERE id=?",
        )
        .run(nowIso(), d.id);
      await apply({ ...d, status: "submitted" });
      await audit("tax_declaration_submitted", { year });
      const payroll = await staffWith(db, user.company_id, ["payroll.manage"]);
      await app.notify(
        payroll.map((p) => p.id),
        {
          companyId: user.company_id,
          kind: "payroll",
          title: `${user.name} submitted a tax declaration`,
          link: "payroll",
        },
      );
      return send(200, await view(user, year));
    },
  );

  // ---- payroll side ----------------------------------------------------------------------------
  router.get(
    "/api/admin/tax-declarations",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const year = yearOf(query);
      const rows = await db
        .prepare(
          `SELECT d.id,d.status,d.regime,d.submitted_at,u.id user_id,u.name,u.employee_code,
             (SELECT COUNT(*) FROM tax_declaration_items i WHERE i.declaration_id=d.id) items,
             (SELECT COUNT(*) FROM tax_declaration_items i WHERE i.declaration_id=d.id AND i.status='pending') pending_items
           FROM tax_declarations d JOIN users u ON u.id=d.user_id WHERE d.company_id=? AND d.tax_year=? ORDER BY (d.status='submitted') DESC,u.name`,
        )
        .all(companyId, year);
      const people = (
        await db
          .prepare(
            "SELECT COUNT(*) n FROM users WHERE company_id=? AND active=1 AND role<>'super_admin'",
          )
          .get(companyId)
      ).n;
      const company = await db
        .prepare("SELECT declaration_open FROM companies WHERE id=?")
        .get(companyId);
      return send(200, {
        year,
        label: `${year}-${String(year + 1).slice(2)}`,
        open: Boolean(company.declaration_open),
        people,
        rows,
      });
    },
  );
  router.get(
    "/api/admin/tax-declarations/:id",
    { perm: "payroll.read" },
    async ({ params, companyId, send }) => {
      const d = await requireOwned(
        db,
        "tax_declarations",
        integer(Number(params.id)),
        companyId,
        "declaration",
      );
      const person = await db
        .prepare(
          "SELECT id,name,employee_code,date_of_birth FROM users WHERE id=?",
        )
        .get(d.user_id);
      const items = await itemsOf(d.id);
      return send(200, {
        declaration: d,
        employee: person,
        items,
        allowed: allowedDeductions(items),
        sections: Object.fromEntries(
          Object.entries(SECTIONS).map(([k, s]) => [k, s]),
        ),
        comparison: await compare(
          { ...person, id: d.user_id },
          d.tax_year,
          items,
        ),
      });
    },
  );
  router.get(
    "/api/admin/tax-declarations/items/:id/proof",
    { perm: "payroll.read" },
    async ({ params, companyId, res, headers, audit }) => {
      const row = await db
        .prepare(
          "SELECT i.document_id,d.company_id FROM tax_declaration_items i JOIN tax_declarations d ON d.id=i.declaration_id WHERE i.id=?",
        )
        .get(integer(Number(params.id)));
      if (!row || row.company_id !== companyId || !row.document_id)
        throw new HttpError(404, "No proof attached.");
      const doc = await db
        .prepare("SELECT * FROM documents WHERE id=? AND deleted_at IS NULL")
        .get(row.document_id);
      if (!doc) throw new HttpError(404, "The proof was removed.");
      await audit("tax_proof_viewed", {
        itemId: Number(params.id),
        employeeId: doc.user_id,
      });
      const ext = {
        "application/pdf": "pdf",
        "image/jpeg": "jpg",
        "image/png": "png",
      }[doc.mime];
      res.writeHead(200, {
        ...headers,
        "Content-Type": doc.mime,
        "Content-Disposition": `inline; filename="${doc.name}.${ext}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(Buffer.from(doc.data, "base64"));
    },
  );
  router.post(
    "/api/admin/tax-declarations/:id/review",
    { perm: "payroll.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const d = await requireOwned(
        db,
        "tax_declarations",
        integer(Number(params.id)),
        companyId,
        "declaration",
      );
      if (d.status !== "submitted")
        throw new HttpError(409, "This declaration is not waiting for review.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", [
        "verified",
        "changes_requested",
      ]);
      const note = optionalString(b.note, "Note", 500) || null;
      if (decision === "changes_requested" && !note)
        throw new HttpError(400, "Tell the employee what to correct.");
      const items = await itemsOf(d.id);
      await transaction(async () => {
        for (const r of Array.isArray(b.items) ? b.items : []) {
          const it = items.find((x) => x.id === Number(r?.id));
          if (!it)
            throw new HttpError(
              400,
              "An item does not belong to this declaration.",
            );
          const status = oneOf(r.status, "Item status", [
            "pending",
            "verified",
            "rejected",
          ]);
          const verified =
            status === "verified"
              ? Math.round(
                  number(
                    r.verified_amount ?? it.amount,
                    "Verified amount",
                    0,
                    it.amount,
                  ),
                )
              : null;
          await db
            .prepare(
              "UPDATE tax_declaration_items SET status=?,verified_amount=?,note=? WHERE id=?",
            )
            .run(
              status,
              verified,
              optionalString(r.note, "Item note", 300) || null,
              it.id,
            );
        }
        const left = await db
          .prepare(
            "SELECT COUNT(*) n FROM tax_declaration_items WHERE declaration_id=? AND status='pending'",
          )
          .get(d.id);
        if (decision === "verified" && left.n > 0)
          throw new HttpError(
            409,
            "Verify or reject every item before approving.",
          );
        await db
          .prepare(
            "UPDATE tax_declarations SET status=?,reviewed_by=?,reviewed_at=?,review_note=? WHERE id=?",
          )
          .run(decision, user.id, nowIso(), note, d.id);
        await audit("tax_declaration_reviewed", { id: d.id, decision });
      });
      await apply({
        ...d,
        status: decision === "verified" ? "verified" : "submitted",
      });
      await app.notify([d.user_id], {
        companyId,
        kind: "payroll",
        title:
          decision === "verified"
            ? "Your tax declaration was verified"
            : "Please correct your tax declaration",
        body: note,
        link: "payslips",
        email: true,
      });
      return send(200, { ok: true });
    },
  );
  router.put(
    "/api/admin/tax-declarations/settings",
    { perm: "payroll.manage" },
    async ({ companyId, body, send, audit }) => {
      const open = (await body()).open === false ? 0 : 1;
      await db
        .prepare("UPDATE companies SET declaration_open=? WHERE id=?")
        .run(open, companyId);
      await audit("tax_declaration_window", { open: Boolean(open) });
      return send(200, { open: Boolean(open) });
    },
  );
}
