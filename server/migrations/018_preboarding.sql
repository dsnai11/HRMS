-- Pre-boarding (candidate self-service before day one), probation and onboarding buddy.
CREATE TABLE IF NOT EXISTS preboarding (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  candidate_id INTEGER NOT NULL UNIQUE REFERENCES candidates(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','in_progress','submitted','verified','changes_requested')),
  form TEXT NOT NULL DEFAULT '{}', sensitive TEXT, hr_note TEXT,
  submitted_at TEXT, verified_by INTEGER REFERENCES users(id), verified_at TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, last_opened_at TEXT
);
CREATE TABLE IF NOT EXISTS preboarding_documents (
  id SERIAL PRIMARY KEY, preboarding_id INTEGER NOT NULL REFERENCES preboarding(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS preboarding_documents_pre ON preboarding_documents(preboarding_id);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS accepted_name TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS accepted_ip TEXT;
ALTER TABLE offers ADD COLUMN IF NOT EXISTS probation_months INTEGER NOT NULL DEFAULT 6;
ALTER TABLE users ADD COLUMN IF NOT EXISTS probation_end_date TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS probation_notified_on TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS buddy_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS users_probation ON users(probation_end_date) WHERE probation_end_date IS NOT NULL;
