-- Selfie evidence at punch, referrals, career changes, self-service password reset.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS require_selfie INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS punch_photos (
  id SERIAL PRIMARY KEY, shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('in','out')), data TEXT NOT NULL, created_at TEXT NOT NULL,
  UNIQUE (shift_id, kind)
);

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id);

CREATE TABLE IF NOT EXISTS employee_changes (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('promotion','transfer','increment','confirmation')),
  effective_date TEXT NOT NULL,
  designation_id INTEGER REFERENCES designations(id), department_id INTEGER REFERENCES departments(id),
  branch_id INTEGER REFERENCES branches(id), manager_id INTEGER REFERENCES users(id),
  workplace_id INTEGER REFERENCES workplaces(id), monthly_gross DOUBLE PRECISION,
  previous TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','cancelled')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, applied_at TEXT
);
CREATE INDEX IF NOT EXISTS employee_changes_user ON employee_changes(user_id, effective_date);
CREATE INDEX IF NOT EXISTS employee_changes_pending ON employee_changes(company_id, status, effective_date);

CREATE TABLE IF NOT EXISTS password_resets (
  id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE, expires_at BIGINT NOT NULL, used_at TEXT, created_at TEXT NOT NULL
);
