-- Overtime: time worked after the full-day finish on a full working day, claimed by the
-- employee up to what the punches show, approved by the manager, paid through payroll.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_min_minutes INTEGER NOT NULL DEFAULT 30;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_max_minutes INTEGER NOT NULL DEFAULT 240;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_rate DOUBLE PRECISION NOT NULL DEFAULT 2;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_basis TEXT NOT NULL DEFAULT 'basic';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_days_per_month INTEGER NOT NULL DEFAULT 26;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_hours_per_day DOUBLE PRECISION NOT NULL DEFAULT 8;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ot_claim_days INTEGER NOT NULL DEFAULT 7;
CREATE TABLE IF NOT EXISTS overtime_requests (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id),
  date TEXT NOT NULL,
  eligible_minutes INTEGER NOT NULL,
  minutes_claimed INTEGER NOT NULL CHECK (minutes_claimed > 0),
  minutes_approved INTEGER CHECK (minutes_approved IS NULL OR minutes_approved > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  paid_run_id INTEGER REFERENCES payroll_runs(id),
  created_at TEXT NOT NULL,
  CHECK (minutes_claimed <= eligible_minutes),
  CHECK (minutes_approved IS NULL OR minutes_approved <= minutes_claimed),
  CHECK (status <> 'approved' OR minutes_approved IS NOT NULL)
);
-- One live claim per person per day.
CREATE UNIQUE INDEX IF NOT EXISTS overtime_one_per_day ON overtime_requests(user_id, date) WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS overtime_company ON overtime_requests(company_id, status, date);
