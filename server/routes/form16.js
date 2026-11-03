import { HttpError, integer, string } from "../http.js";
import { checkFile } from "./documents.js";
import { decryptJson, encryptionKey } from "../crypto-store.js";

// Form 16: the TDS certificate an employer downloads from TRACES and signs. Payroll
// uploads each employee's PDF for a financial year; the employee downloads it. A new
// upload for the same person and year replaces the old one.
const FY = /^20\d\d-\d\d$/;

export function registerForm16(router, app) {
  const { db } = app;
  const nowIso = () => new Date(app.clock()).toISOString();

  router.get("/api/form16", async ({ user, send }) =>
    send(
      200,
      await db
        .prepare(
          "SELECT id,name,size,created_at FROM documents WHERE user_id=? AND kind='form16' AND deleted_at IS NULL ORDER BY name DESC",
        )
        .all(user.id),
    ),
  );

  router.get(
    "/api/admin/form16",
    { perm: "payroll.read" },
    async ({ companyId, query, send }) => {
      const fy = query.get("fy");
      return send(
        200,
        await db
          .prepare(
            `SELECT d.id,d.name,d.created_at,u.id user_id,u.name employee_name,u.employee_code FROM documents d JOIN users u ON u.id=d.user_id
             WHERE d.company_id=? AND d.kind='form16' AND d.deleted_at IS NULL ${fy ? "AND d.name=?" : ""} ORDER BY u.name`,
          )
          .all(companyId, ...(fy ? [`Form 16 FY ${fy}`] : [])),
      );
    },
  );

  // The employee whose PAN this is (PANs are kept encrypted, so each is read in turn).
  async function byPan(companyId, pan) {
    const key = encryptionKey();
    if (!key) throw new HttpError(503, "Matching by PAN needs DATA_ENCRYPTION_KEY on the server.");
    for (const row of await db
      .prepare(
        "SELECT p.user_id,p.data,u.name FROM employee_private p JOIN users u ON u.id=p.user_id WHERE p.company_id=?",
      )
      .all(companyId)) {
      try {
        if (String(decryptJson(row.data, key).pan ?? "").toUpperCase() === pan)
          return { id: row.user_id, name: row.name };
      } catch {
        /* a row that does not decrypt is skipped */
      }
    }
    return null;
  }

  // One PDF for one employee, found by employee code, user id, or PAN. The bulk upload on the
  // payroll page sends the TRACES files one by one with the PAN read from each file name
  // (NAME_PAN_FY202526_PartB_SIGNED.pdf).
  router.post(
    "/api/admin/form16",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(3_000_000);
      const fy = string(b.fy, "Financial year", 7);
      if (!FY.test(fy) || Number(fy.slice(5)) !== (Number(fy.slice(2, 4)) + 1) % 100)
        throw new HttpError(400, "Write the financial year like 2025-26.");
      const pan = b.pan ? String(b.pan).toUpperCase() : null;
      if (pan && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) throw new HttpError(400, "PAN must look like ABCDE1234F.");
      const target = pan
        ? await byPan(companyId, pan)
        : b.user_id
        ? await db
            .prepare("SELECT id,name FROM users WHERE id=? AND company_id=?")
            .get(integer(Number(b.user_id)), companyId)
        : await db
            .prepare("SELECT id,name FROM users WHERE lower(employee_code)=lower(?) AND company_id=?")
            .get(string(b.employee_code, "Employee code", 30), companyId);
      if (!target)
        throw new HttpError(
          404,
          pan ? `No employee has PAN ${pan} on record.` : `No employee with code ${b.employee_code ?? b.user_id}.`,
        );
      const file = checkFile(b);
      if (file.mime !== "application/pdf")
        throw new HttpError(400, "Form 16 must be a PDF.");
      const name = `Form 16 FY ${fy}`;
      await db
        .prepare(
          "UPDATE documents SET deleted_at=? WHERE user_id=? AND kind='form16' AND name=? AND deleted_at IS NULL",
        )
        .run(nowIso(), target.id, name);
      const id = Number(
        (
          await db
            .prepare(
              "INSERT INTO documents(company_id,user_id,kind,name,mime,size,data,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            )
            .run(companyId, target.id, "form16", name, file.mime, file.bytes.length, await app.blobs.put(file.data, "documents"), user.id, nowIso())
        ).lastInsertRowid,
      );
      await audit("form16_uploaded", { id, employeeId: target.id, fy });
      await app.notify([target.id], {
        companyId,
        kind: "payslip",
        title: `Your Form 16 for FY ${fy} is ready`,
        link: "payslips",
        email: true,
      });
      return send(201, { id, employee: target.name });
    },
  );
}
