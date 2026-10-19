-- Payroll completion: leave encashment, adjustment sources, loans and advances,
-- reimbursement claims.
ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS encashable INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leave_ledger DROP CONSTRAINT IF EXISTS leave_ledger_kind_check;
ALTER TABLE leave_ledger ADD CONSTRAINT leave_ledger_kind_check
  CHECK (kind IN ('accrual','carry_forward','used','reversal','adjustment','encashment'));

-- Where a one-off adjustment came from (arrears, bonus, encashment, …).
ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS source TEXT;
ALTER TABLE payroll_adjustments ADD COLUMN IF NOT EXISTS source_ref INTEGER;

CREATE TABLE IF NOT EXISTS payroll_loans (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('loan','advance')),
  principal DOUBLE PRECISION NOT NULL, installments INTEGER NOT NULL, start_month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed','cancelled')),
  note TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payroll_loans_user ON payroll_loans(user_id);
CREATE TABLE IF NOT EXISTS payroll_loan_schedule (
  id SERIAL PRIMARY KEY, loan_id INTEGER NOT NULL REFERENCES payroll_loans(id) ON DELETE CASCADE,
  month TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deducted','cancelled')),
  run_id INTEGER REFERENCES payroll_runs(id)
);
CREATE INDEX IF NOT EXISTS payroll_loan_schedule_month ON payroll_loan_schedule(month, status);

CREATE TABLE IF NOT EXISTS claim_types (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, annual_limit DOUBLE PRECISION, taxable INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS claim_types_name ON claim_types(company_id, lower(name));
CREATE TABLE IF NOT EXISTS reimbursement_claims (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), claim_type_id INTEGER NOT NULL REFERENCES claim_types(id),
  expense_date TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL, approved_amount DOUBLE PRECISION,
  description TEXT NOT NULL, reference TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','paid','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  paid_run_id INTEGER REFERENCES payroll_runs(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS reimbursement_claims_user ON reimbursement_claims(user_id, status);
CREATE INDEX IF NOT EXISTS reimbursement_claims_company ON reimbursement_claims(company_id, status);
