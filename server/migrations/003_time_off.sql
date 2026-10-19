-- Time off: company calendar settings, holidays, leave types, ledger, requests,
-- and attendance regularization.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS leave_year_start_month INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS weekly_off_days TEXT NOT NULL DEFAULT '[0]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS weekly_off_saturdays TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS regularization_window_days INTEGER NOT NULL DEFAULT 7;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS regularization_monthly_limit INTEGER NOT NULL DEFAULT 5;
-- First leave year in which leave accrues; earlier years are never back-filled.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS leave_start_year INTEGER;
-- Days before this date are not counted in musters (defaults to the day the company was created).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS attendance_start_date TEXT;
ALTER TABLE shifts ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'punch';

CREATE TABLE IF NOT EXISTS holidays (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  branch_id INTEGER REFERENCES branches(id), date TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS holidays_day ON holidays(company_id, COALESCE(branch_id, 0), date);

CREATE TABLE IF NOT EXISTS leave_types (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 1, unlimited INTEGER NOT NULL DEFAULT 0,
  quota_per_year DOUBLE PRECISION NOT NULL DEFAULT 0,
  accrual TEXT NOT NULL DEFAULT 'monthly' CHECK (accrual IN ('monthly','yearly')),
  carry_forward_max DOUBLE PRECISION NOT NULL DEFAULT 0, allow_half_day INTEGER NOT NULL DEFAULT 1,
  applicable_gender TEXT, max_days_per_request DOUBLE PRECISION,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_types_code ON leave_types(company_id, upper(code));

CREATE TABLE IF NOT EXISTS leave_ledger (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  leave_year INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('accrual','carry_forward','used','reversal','adjustment')),
  days DOUBLE PRECISION NOT NULL, period TEXT, ref_id INTEGER, note TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
-- Accruals are idempotent: one entry per person, type, year, kind and period.
CREATE UNIQUE INDEX IF NOT EXISTS leave_ledger_period ON leave_ledger(user_id, leave_type_id, leave_year, kind, period) WHERE period IS NOT NULL;
CREATE INDEX IF NOT EXISTS leave_ledger_balance ON leave_ledger(user_id, leave_type_id, leave_year);

CREATE TABLE IF NOT EXISTS leave_requests (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
  from_date TEXT NOT NULL, to_date TEXT NOT NULL, half_day TEXT CHECK (half_day IN ('first','second')),
  days DOUBLE PRECISION NOT NULL, leave_year INTEGER NOT NULL, reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leave_requests_user ON leave_requests(user_id, from_date);
CREATE INDEX IF NOT EXISTS leave_requests_status ON leave_requests(company_id, status);

-- One row per half-day slot of a pending or approved request. The unique index
-- makes overlapping leave impossible, even under concurrent requests.
CREATE TABLE IF NOT EXISTS leave_days (
  id SERIAL PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  session TEXT NOT NULL CHECK (session IN ('first','second')), paid INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS leave_days_slot ON leave_days(user_id, day, session);

CREATE TABLE IF NOT EXISTS regularizations (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('missed_punch','wrong_punch','on_duty','work_from_home')),
  in_time TEXT, out_time TEXT, reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  shift_id INTEGER REFERENCES shifts(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS regularizations_pending ON regularizations(user_id, date) WHERE status='pending';
CREATE INDEX IF NOT EXISTS regularizations_status ON regularizations(company_id, status);
