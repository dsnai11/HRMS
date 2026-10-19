import { HttpError, string } from "../http.js";
import { localToUtcMs } from "../calendar.js";
import { evaluatePunchIn, halfDayReasons } from "../policy.js";

const hhmm = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? ""));

// Brings in attendance recorded elsewhere (biometric machines, another system) as a
// list of rows exported to CSV: employee code, date, in time, out time. Each row
// becomes a shift for that person at their assigned workplace, marked as imported.
export function registerAttendanceImport(router, app) {
  const { db, transaction, clock, dayOf, timezone } = app;

  router.post(
    "/api/admin/attendance/import",
    { perm: "attendance.import" },
    async ({ companyId, body, send, audit }) => {
      const b = await body(1_500_000);
      if (!Array.isArray(b.rows) || !b.rows.length)
        throw new HttpError(400, "Add at least one row.");
      if (b.rows.length > 5000)
        throw new HttpError(413, "Import up to 5,000 rows at a time.");
      const dry = b.dry_run === true;
      const today = dayOf(new Date(clock()).toISOString());
      const people = new Map(
        (
          await db
            .prepare(
              "SELECT id,employee_code,workplace_id,branch_id,company_id FROM users WHERE company_id=? AND active=1 AND employee_code IS NOT NULL",
            )
            .all(companyId)
        ).map((u) => [String(u.employee_code).toLowerCase(), u]),
      );
      const sites = new Map(
        (
          await db
            .prepare("SELECT * FROM workplaces WHERE company_id=?")
            .all(companyId)
        ).map((w) => [w.id, w]),
      );
      const report = [];
      const accepted = [];
      const seen = new Set();
      for (const [i, row] of b.rows.entries()) {
        const line = i + 1;
        const fail = (reason) =>
          report.push({
            line,
            code: row?.employee_code ?? "",
            date: row?.date ?? "",
            status: "skipped",
            reason,
          });
        const code = String(row?.employee_code ?? "").trim();
        const person = people.get(code.toLowerCase());
        if (!person) {
          fail("Unknown or inactive employee code");
          continue;
        }
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(row.date ?? "") ||
          Number.isNaN(Date.parse(row.date))
        ) {
          fail("Date must be YYYY-MM-DD");
          continue;
        }
        if (row.date > today) {
          fail("Date is in the future");
          continue;
        }
        if (!hhmm(row.in_time) || !hhmm(row.out_time)) {
          fail("Times must be HH:MM");
          continue;
        }
        if (row.out_time <= row.in_time) {
          fail("Out time must be after in time");
          continue;
        }
        const site = sites.get(person.workplace_id);
        if (!site) {
          fail("Employee has no workplace assigned");
          continue;
        }
        const key = `${person.id}|${row.date}`;
        if (seen.has(key)) {
          fail("Duplicate row for this person and date");
          continue;
        }
        seen.add(key);
        accepted.push({ line, row, person, site, key });
      }
      // Skip days that already have attendance (from the phone or an earlier import).
      const existing = new Set();
      if (accepted.length) {
        const ids = [...new Set(accepted.map((a) => a.person.id))];
        const dates = accepted.map((a) => a.row.date).sort();
        const found = await db
          .prepare(
            `SELECT user_id,in_at FROM shifts WHERE user_id IN (${ids.map(() => "?").join(",")}) AND in_at>=? AND in_at<?`,
          )
          .all(
            ...ids,
            new Date(Date.parse(dates[0]) - 2 * 86400000).toISOString(),
            new Date(Date.parse(dates.at(-1)) + 3 * 86400000).toISOString(),
          );
        for (const f of found) existing.add(`${f.user_id}|${dayOf(f.in_at)}`);
      }
      let imported = 0;
      const todo = [];
      for (const a of accepted) {
        if (existing.has(a.key))
          report.push({
            line: a.line,
            code: a.row.employee_code,
            date: a.row.date,
            status: "skipped",
            reason: "Attendance already exists for that day",
          });
        else todo.push(a);
      }
      if (!dry)
        await transaction(async () => {
          for (const a of todo) {
            const policy = await app.policyFor(a.person);
            const inMs = localToUtcMs(a.row.date, a.row.in_time, timezone);
            const outMs = localToUtcMs(a.row.date, a.row.out_time, timezone);
            const rules = evaluatePunchIn(policy, inMs, timezone);
            const reasons = halfDayReasons({
              late: rules.late,
              requiredOutAt: rules.requiredOutAt,
              outMs,
            });
            await db
              .prepare(
                "INSERT INTO shifts(user_id,workplace_id,workplace_name,site_latitude,site_longitude,radius,max_accuracy,in_at,in_latitude,in_longitude,in_accuracy,out_at,out_latitude,out_longitude,out_accuracy,required_out_at,day_type,half_day_reasons,source) VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,0,?,?,?,'imported')",
              )
              .run(
                a.person.id,
                a.site.id,
                a.site.name,
                a.site.latitude,
                a.site.longitude,
                a.site.radius,
                a.site.max_accuracy,
                new Date(inMs).toISOString(),
                a.site.latitude,
                a.site.longitude,
                new Date(outMs).toISOString(),
                a.site.latitude,
                a.site.longitude,
                rules.requiredOutAt,
                reasons.length ? "half_day" : "full_day",
                JSON.stringify(reasons),
              );
            imported++;
          }
          await audit("attendance_imported", {
            imported,
            skipped: report.length,
            source: string(b.source ?? "csv", "Source", 40),
          });
        });
      return send(200, {
        dry_run: dry,
        would_import: todo.length,
        imported,
        skipped: report.length,
        report: report.slice(0, 200),
      });
    },
  );
}
