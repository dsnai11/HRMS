-- Attendance rules per company, branch or employee (otherwise the server default applies).
CREATE TABLE IF NOT EXISTS shift_policies (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, start_time TEXT NOT NULL, grace_minutes INTEGER NOT NULL DEFAULT 15,
  hours DOUBLE PRECISION NOT NULL DEFAULT 9, earliest_out TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS shift_policies_name ON shift_policies(company_id, lower(name));
ALTER TABLE users ADD COLUMN IF NOT EXISTS shift_policy_id INTEGER REFERENCES shift_policies(id) ON DELETE SET NULL;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS shift_policy_id INTEGER REFERENCES shift_policies(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS shift_policy_id INTEGER REFERENCES shift_policies(id) ON DELETE SET NULL;
