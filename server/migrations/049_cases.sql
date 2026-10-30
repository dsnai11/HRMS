-- Grievances (HR), POSH complaints (Internal Committee) and whistleblower reports
-- (vigilance committee). Anonymous reports keep no link to the person: they follow up
-- with the case code and a key only they were shown.
CREATE TABLE IF NOT EXISTS cases (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('grievance','posh','whistleblower')),
  code TEXT NOT NULL UNIQUE,
  reporter_id INTEGER REFERENCES users(id),
  anonymous INTEGER NOT NULL DEFAULT 0,
  follow_key_hash TEXT,
  category TEXT NOT NULL,
  subject TEXT NOT NULL,
  description TEXT NOT NULL,
  against_user_id INTEGER REFERENCES users(id),
  against_text TEXT,
  incident_date TEXT,
  branch_id INTEGER REFERENCES branches(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','closed')),
  assigned_to INTEGER REFERENCES users(id),
  due_date TEXT NOT NULL,
  outcome TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((anonymous = 1 AND reporter_id IS NULL AND follow_key_hash IS NOT NULL) OR (anonymous = 0 AND reporter_id IS NOT NULL)),
  CHECK (NOT (kind = 'posh' AND anonymous = 1))
);
CREATE INDEX IF NOT EXISTS cases_company ON cases(company_id, kind, status);
CREATE INDEX IF NOT EXISTS cases_reporter ON cases(reporter_id);
CREATE TABLE IF NOT EXISTS case_messages (
  id SERIAL PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_id INTEGER REFERENCES users(id),
  from_reporter INTEGER NOT NULL DEFAULT 0,
  internal INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (NOT (from_reporter = 1 AND internal = 1))
);
CREATE INDEX IF NOT EXISTS case_messages_case ON case_messages(case_id, id);
CREATE TABLE IF NOT EXISTS case_committee (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('posh','whistleblower')),
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (company_id, kind, user_id)
);
