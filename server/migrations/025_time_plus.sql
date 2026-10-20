-- Shift kinds and department assignment; compensatory off.
ALTER TABLE shift_policies ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'fixed';
ALTER TABLE departments ADD COLUMN IF NOT EXISTS shift_policy_id INTEGER REFERENCES shift_policies(id) ON DELETE SET NULL;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS comp_off_valid_days INTEGER NOT NULL DEFAULT 60;

CREATE TABLE IF NOT EXISTS comp_off_credits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), worked_on TEXT NOT NULL, days DOUBLE PRECISION NOT NULL,
  reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  valid_until TEXT, expiry_done INTEGER NOT NULL DEFAULT 0, expired_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comp_off_user ON comp_off_credits(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS comp_off_day ON comp_off_credits(user_id, worked_on) WHERE status IN ('pending','approved');
