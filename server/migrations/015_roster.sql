-- Day-by-day roster: a shift rule for that day, or a rest day.
CREATE TABLE IF NOT EXISTS roster_entries (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL,
  shift_policy_id INTEGER REFERENCES shift_policies(id) ON DELETE CASCADE,
  off INTEGER NOT NULL DEFAULT 0, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  UNIQUE (user_id, date)
);
CREATE INDEX IF NOT EXISTS roster_company_date ON roster_entries(company_id, date);
