import {
  HttpError,
  integer,
  isoDate,
  number,
  oneOf,
  optionalString,
  string,
} from "../http.js";
import { requireOwned } from "../scope.js";
import { taxYearOf } from "../payroll/tax.js";

// Bills against bill-backed salary components (see migration 057). An employee adds bills for
// a component in their salary; payroll verifies (possibly a lower amount) or rejects each one.
// The verified total for the tax year, capped at twelve months of the component, is left out
// of taxable income when TDS is worked out. Pending bills do not count until verified.
const round = (n) => Math.round(n * 100) / 100;

/** Map user_id → exempt amount for the tax year, from verified bills and current salary lines. */
export async function billExemptions(db, companyId, taxYear, salaryIds = null) {
  const lines = await db
    .prepare(
      `SELECT s.user_id,l.component_id,l.amount FROM employee_salary_lines l
       JOIN employee_salaries s ON s.id=l.salary_id JOIN salary_components c ON c.id=l.component_id
       WHERE s.company_id=? AND c.bill_based=1 ${salaryIds ? `AND s.id IN (${salaryIds.map(() => "?").join(",") || "NULL"})` : `AND s.id=(SELECT id FROM employee_salaries x WHERE x.user_id=s.user_id ORDER BY effective_from DESC,id DESC LIMIT 1)`}`,
    )
    .all(companyId, ...(salaryIds ?? []));
  if (!lines.length) return new Map();
  const verified = new Map(
    (
      await db
        .prepare(
          "SELECT user_id,component_id,SUM(verified_amount) total FROM salary_bills WHERE company_id=? AND tax_year=? AND status='verified' GROUP BY user_id,component_id",
        )
        .all(companyId, taxYear)
    ).map((r) => [`${r.user_id}:${r.component_id}`, Number(r.total)]),
  );
  const out = new Map();
  for (const l of lines) {
    const v = verified.get(`${l.user_id}:${l.component_id}`) ?? 0;
    out.set(l.user_id, round((out.get(l.user_id) ?? 0) + Math.min(v, l.amount * 12)));
  }
  return out;
}

export function registerSalaryBills(router, app) {
  const { db, clock } = app;
  const nowIso = () => new Date(clock()).toISOString();
  const currentYear = () => taxYearOf(app.dayOf(nowIso()).slice(0, 7));
  const yearOf = (q) => {
    const y = q.get("year") ? Number(q.get("year")) : currentYear();
    if (!Number.isInteger(y) || y < 2020 || y > 2100)
      throw new HttpError(400, "Choose a valid tax year.");
    return y;
  };
  const yearRange = (y) => [`${y}-04-01`, `${y + 1}-03-31`];
  // The employee's bill-backed components in their current salary.
  const componentsOf = (userId) =>
    db
      .prepare(
        `SELECT c.id,c.name,c.code,l.amount monthly FROM employee_salary_lines l JOIN salary_components c ON c.id=l.component_id
         WHERE c.bill_based=1 AND l.salary_id=(SELECT id FROM employee_salaries WHERE user_id=? ORDER BY effective_from DESC,id DESC LIMIT 1)
         ORDER BY c.sort_order,c.id`,
      )
      .all(userId);

  async function summary(userId, year) {
    const components = await componentsOf(userId);
    const bills = await db
      .prepare(
        `SELECT b.*,c.name component_name,d.name proof_name FROM salary_bills b JOIN salary_components c ON c.id=b.component_id
         LEFT JOIN documents d ON d.id=b.document_id WHERE b.user_id=? AND b.tax_year=? ORDER BY b.bill_date DESC,b.id DESC`,
      )
      .all(userId, year);
    return {
      tax_year: year,
      label: `${year}-${String(year + 1).slice(2)}`,
      components: components.map((c) => {
        const mine = bills.filter((b) => b.component_id === c.id);
        const sum = (status, field = "amount") =>
          round(mine.filter((b) => b.status === status).reduce((s, b) => s + (b[field] ?? 0), 0));
        const verified = sum("verified", "verified_amount");
        return {
          ...c,
          yearly: round(c.monthly * 12),
          verified,
          pending: sum("pending"),
          exempt: Math.min(verified, round(c.monthly * 12)),
        };
      }),
      bills,
    };
  }

  router.get("/api/salary-bills", async ({ user, query, send }) =>
    send(200, await summary(user.id, yearOf(query))),
  );
  router.post("/api/salary-bills", async ({ user, body, send, audit }) => {
    const b = await body();
    const componentId = integer(Number(b.component_id));
    const c = (await componentsOf(user.id)).find((x) => x.id === componentId);
    if (!c) throw new HttpError(400, "Choose a reimbursement that is part of your salary.");
    const date = isoDate(b.bill_date, "Bill date");
    if (!date) throw new HttpError(400, "Bill date is required.");
    if (date > app.dayOf(nowIso())) throw new HttpError(400, "The bill date cannot be in the future.");
    const year = taxYearOf(date.slice(0, 7));
    if (year !== currentYear())
      throw new HttpError(400, "Only bills from the current tax year can be added.");
    let docId = null;
    if (b.document_id) {
      const doc = await db
        .prepare("SELECT id,user_id,deleted_at FROM documents WHERE id=?")
        .get(integer(Number(b.document_id)));
      if (!doc || doc.user_id !== user.id || doc.deleted_at)
        throw new HttpError(400, "The bill copy is not one of your documents.");
      docId = doc.id;
    }
    const id = Number(
      (
        await db
          .prepare(
            "INSERT INTO salary_bills(company_id,user_id,component_id,tax_year,bill_date,bill_no,amount,description,document_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
          )
          .run(
            user.company_id,
            user.id,
            c.id,
            year,
            date,
            optionalString(b.bill_no, "Bill number", 60),
            number(b.amount, "Amount", 1, 10000000),
            string(b.description, "Description", 300),
            docId,
            nowIso(),
          )
      ).lastInsertRowid,
    );
    await audit("salary_bill_added", { id, component: c.code });
    return send(201, { id });
  });
  router.post("/api/salary-bills/:id/cancel", async ({ user, params, send, audit }) => {
    const bill = await requireOwned(db, "salary_bills", integer(Number(params.id)), user.company_id, "bill");
    if (bill.user_id !== user.id) throw new HttpError(404, "Bill not found.");
    if (bill.status !== "pending") throw new HttpError(409, "Only bills waiting for verification can be withdrawn.");
    await db.prepare("UPDATE salary_bills SET status='cancelled' WHERE id=?").run(bill.id);
    await audit("salary_bill_cancelled", { id: bill.id });
    return send(200, { ok: true });
  });

  // ---- payroll ---------------------------------------------------------------------------------
  router.put(
    "/api/admin/salary-components/:id/bill-based",
    { perm: "payroll.manage" },
    async ({ params, companyId, body, send, audit }) => {
      const c = await requireOwned(db, "salary_components", integer(Number(params.id)), companyId, "component");
      const on = Boolean((await body()).bill_based);
      if (on && (c.is_basic || c.calc === "balance"))
        throw new HttpError(400, "Basic pay and the balancing component cannot be bill-backed.");
      // HRA has its own exemption, through the tax declaration.
      if (on && c.code.toUpperCase() === "HRA")
        throw new HttpError(400, "HRA is exempted through the tax declaration, not bills.");
      await db.prepare("UPDATE salary_components SET bill_based=? WHERE id=?").run(on ? 1 : 0, c.id);
      await audit("salary_component_bill_based", { id: c.id, on });
      return send(200, { ok: true });
    },
  );
  router.get(
    "/api/admin/salary-bills",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const year = yearOf(query);
      const status = query.get("status");
      if (status) oneOf(status, "Status", ["pending", "verified", "rejected", "cancelled"]);
      return send(200, {
        tax_year: year,
        range: yearRange(year),
        items: await db
          .prepare(
            `SELECT b.*,c.name component_name,u.name employee_name,u.employee_code,d.name proof_name,v.name verified_by_name
             FROM salary_bills b JOIN salary_components c ON c.id=b.component_id JOIN users u ON u.id=b.user_id
             LEFT JOIN documents d ON d.id=b.document_id LEFT JOIN users v ON v.id=b.verified_by
             WHERE b.company_id=? AND b.tax_year=? ${status ? "AND b.status=?" : ""} ORDER BY b.id DESC LIMIT 500`,
          )
          .all(...(status ? [companyId, year, status] : [companyId, year])),
      });
    },
  );
  router.get(
    "/api/admin/salary-bills/:id/proof",
    { perm: "payroll.read" },
    async ({ params, companyId, res, headers, audit }) => {
      const bill = await requireOwned(db, "salary_bills", integer(Number(params.id)), companyId, "bill");
      const doc =
        bill.document_id &&
        (await db.prepare("SELECT * FROM documents WHERE id=? AND deleted_at IS NULL").get(bill.document_id));
      if (!doc) throw new HttpError(404, "No bill copy attached.");
      await audit("salary_bill_proof_viewed", { id: bill.id, employeeId: bill.user_id });
      const ext = { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png" }[doc.mime];
      res.writeHead(200, {
        ...headers,
        "Content-Type": doc.mime,
        "Content-Disposition": `inline; filename="bill-${bill.id}.${ext}"`,
        "Cache-Control": "private, no-store",
      });
      res.end(await app.blobs.bytes(doc.data));
    },
  );
  router.get(
    "/api/admin/salary-bills/summary/:userId",
    { perm: "payroll.read" },
    async ({ params, companyId, query, send }) => {
      const person = await requireOwned(db, "users", integer(Number(params.userId)), companyId, "employee");
      return send(200, await summary(person.id, yearOf(query)));
    },
  );
  router.post(
    "/api/admin/salary-bills/:id/verify",
    { perm: "payroll.manage" },
    async ({ user, params, companyId, body, send, audit }) => {
      const bill = await requireOwned(db, "salary_bills", integer(Number(params.id)), companyId, "bill");
      if (bill.status !== "pending") throw new HttpError(409, `This bill is already ${bill.status}.`);
      if (bill.user_id === user.id) throw new HttpError(403, "Someone else in payroll must verify your bills.");
      const b = await body();
      const decision = oneOf(b.decision, "Decision", ["verified", "rejected"]);
      const note = optionalString(b.note, "Note", 300);
      const amount =
        decision === "verified"
          ? b.verified_amount === undefined || b.verified_amount === ""
            ? bill.amount
            : number(b.verified_amount, "Verified amount", 0, bill.amount)
          : null;
      if (decision === "rejected" && !note) throw new HttpError(400, "Say why the bill is not accepted.");
      if (decision === "verified" && amount < bill.amount && !note)
        throw new HttpError(400, "Say why less than the bill amount is accepted.");
      await db
        .prepare("UPDATE salary_bills SET status=?,verified_amount=?,verified_by=?,verified_at=?,note=? WHERE id=?")
        .run(decision, amount, user.id, nowIso(), note, bill.id);
      await audit("salary_bill_verified", { id: bill.id, decision, amount });
      await app.notify([bill.user_id], {
        companyId,
        kind: "payroll",
        title:
          decision === "verified"
            ? `Your bill of ₹${bill.amount} was verified${amount < bill.amount ? ` for ₹${amount}` : ""}`
            : "A bill you added was not accepted",
        body: note ?? undefined,
        link: "payslips",
      });
      return send(200, { ok: true });
    },
  );
}
