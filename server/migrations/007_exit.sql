-- Exit: resignations and terminations, clearance, exit interview, full and final settlement.
ALTER TABLE users ADD COLUMN IF NOT EXISTS exit_date TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notice_days INTEGER;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS notice_days INTEGER NOT NULL DEFAULT 30;

CREATE TABLE IF NOT EXISTS exits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('resignation','termination','retirement','end_of_contract','other')),
  initiated_by TEXT NOT NULL CHECK (initiated_by IN ('employee','company')),
  notice_given_on TEXT NOT NULL, notice_days INTEGER NOT NULL,
  requested_last_day TEXT, last_working_day TEXT, waive_notice INTEGER NOT NULL DEFAULT 0,
  reason TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected','withdrawn','completed')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  interview_notes TEXT, interview_reason TEXT, would_rejoin INTEGER,
  completed_at TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS exits_live ON exits(user_id) WHERE status IN ('pending','accepted');
CREATE INDEX IF NOT EXISTS exits_company ON exits(company_id, status);

CREATE TABLE IF NOT EXISTS exit_clearance (
  id SERIAL PRIMARY KEY, exit_id INTEGER NOT NULL REFERENCES exits(id) ON DELETE CASCADE,
  department TEXT NOT NULL, item TEXT NOT NULL, asset_id INTEGER REFERENCES assets(id),
  cleared INTEGER NOT NULL DEFAULT 0, cleared_by INTEGER REFERENCES users(id), cleared_at TEXT, note TEXT
);
CREATE INDEX IF NOT EXISTS exit_clearance_exit ON exit_clearance(exit_id);

CREATE TABLE IF NOT EXISTS settlements (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  exit_id INTEGER NOT NULL UNIQUE REFERENCES exits(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), pay_in_month TEXT NOT NULL,
  data TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
