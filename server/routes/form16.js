import { HttpError, integer, string } from "../http.js";
import { checkFile } from "./documents.js";

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

  // One PDF for one employee, named by employee code (or by user_id).
  router.post(
    "/api/admin/form16",
    { perm: "payroll.manage" },
    async ({ user, companyId, body, send, audit }) => {
      const b = await body(3_000_000);
      const fy = string(b.fy, "Financial year", 7);
      if (!FY.test(fy) || Number(fy.slice(5)) !== (Number(fy.slice(2, 4)) + 1) % 100)
        throw new HttpError(400, "Write the financial year like 2025-26.");
      const target = b.user_id
        ? await db
            .prepare("SELECT id,name FROM users WHERE id=? AND company_id=?")
            .get(integer(Number(b.user_id)), companyId)
        : await db
            .prepare("SELECT id,name FROM users WHERE lower(employee_code)=lower(?) AND company_id=?")
            .get(string(b.employee_code, "Employee code", 30), companyId);
      if (!target)
        throw new HttpError(404, `No employee with code ${b.employee_code ?? b.user_id}.`);
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
