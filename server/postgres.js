import { AsyncLocalStorage } from "node:async_hooks";
import { Pool } from "pg";
import { runMigrations } from "./migrate.js";

// The application deliberately runs as a single instance for the showcase.
// Serialize request work so async SQLite transactions and PostgreSQL read/check/write
// sequences have the same semantics. Transactions still commit atomically in the DB.
export function serializedStore(store) {
  let tail = Promise.resolve();
  // On PostgreSQL, read-only requests (GET) may run alongside others: statements
  // outside a transaction use their own pooled connection, and the few GET routes
  // that write do so idempotently. Writes stay strictly in order.
  store.serialized = (fn, { concurrent = false } = {}) => {
    if (concurrent && store.dialect === "postgres")
      return Promise.resolve().then(fn);
    const task = tail.then(fn);
    tail = task.catch(() => {});
    return task;
  };
  return store;
}

export function createPostgresStore(pool) {
  const context = new AsyncLocalStorage();
  const query = (sql, params = []) =>
    (context.getStore() || pool).query(sql, params);
  const normalize = (row) =>
    row && { ...row, ...("n" in row ? { n: Number(row.n) } : {}) };
  return serializedStore({
    dialect: "postgres",
    prepare(sql) {
      // SQL here is application-owned; values always travel as bound parameters.
      let index = 0;
      const statement = sql.replace(/\?/g, () => `$${++index}`);
      return {
        async get(...params) {
          return normalize((await query(statement, params)).rows[0]);
        },
        async all(...params) {
          return (await query(statement, params)).rows.map(normalize);
        },
        async run(...params) {
          const returning =
            /^INSERT\s+INTO\s+(users|workplaces|shifts|audit|devices|punch_events|companies|branches|departments|designations|holidays|leave_types|leave_ledger|leave_requests|leave_days|regularizations|salary_components|employee_salaries|employee_salary_lines|pt_slabs|payroll_opening|payroll_adjustments|payroll_runs|payroll_items|payroll_loans|payroll_loan_schedule|claim_types|reimbursement_claims|job_openings|candidates|candidate_events|interviews|offers|onboarding_template|onboarding_tasks|assets|exits|exit_clearance|settlements|notifications|email_outbox|announcements|tickets|ticket_messages|policies|policy_acks|documents|review_cycles|reviews|goals|trainings|training_records|punch_photos|employee_changes|password_resets|shift_policies|lwf_rules|kra_templates|feedback|roster_entries|push_tokens|preboarding|preboarding_documents|training_lessons|training_questions|training_progress|training_attempts|candidate_files|recruitment_templates|question_bank|interview_questions|credit_consents|credit_checks|joining_documents|joining_acks|grades|cost_centres|business_units|custom_fields|employee_education|employee_experience|employee_skills|employee_certifications|comp_off_credits|tax_declarations|tax_declaration_items|payroll_budgets|bank_change_requests)\b/i.test(
              statement,
            );
          const result = await query(
            statement + (returning ? " RETURNING id" : ""),
            params,
          );
          return {
            changes: result.rowCount ?? result.affectedRows,
            lastInsertRowid: result.rows[0]?.id,
          };
        },
      };
    },
    exec: (sql) => query(sql),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await context.run(client, fn);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  });
}

export async function openPostgres(connectionString) {
  const pool = new Pool({
    connectionString,
    max: Number(process.env.DB_POOL_MAX) || 5,
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
  });
  // Do not print connection strings or SQL parameters in logs.
  pool.on("error", () =>
    console.error(
      "PostgreSQL idle connection failed; the pool will reconnect.",
    ),
  );
  const db = createPostgresStore(pool);
  try {
    await runMigrations(db);
    return db;
  } catch (error) {
    await pool.end();
    throw error;
  }
}
