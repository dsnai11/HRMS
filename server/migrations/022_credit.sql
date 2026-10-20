-- Pre-joining credit (CIBIL) check: consent, provider settings, results.
CREATE TABLE IF NOT EXISTS credit_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  enabled INTEGER NOT NULL DEFAULT 0, provider_name TEXT NOT NULL DEFAULT 'CIBIL',
  method TEXT NOT NULL DEFAULT 'POST', url TEXT, auth_header TEXT NOT NULL DEFAULT 'Authorization',
  api_key_enc TEXT, body_template TEXT, score_path TEXT NOT NULL DEFAULT 'score',
  low_min INTEGER NOT NULL DEFAULT 750, medium_min INTEGER NOT NULL DEFAULT 650,
  required_before_hire INTEGER NOT NULL DEFAULT 0,
  consent_text TEXT, updated_by INTEGER REFERENCES users(id), updated_at TEXT
);
CREATE TABLE IF NOT EXISTS credit_consents (
  id SERIAL PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  consent_text TEXT NOT NULL, given_name TEXT, given_ip TEXT, source TEXT NOT NULL CHECK (source IN ('portal','hr_recorded')),
  note TEXT, recorded_by INTEGER REFERENCES users(id), given_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS credit_consents_candidate ON credit_consents(candidate_id);
CREATE TABLE IF NOT EXISTS credit_checks (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  requested_by INTEGER REFERENCES users(id), requested_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('completed','failed','manual')),
  bureau TEXT NOT NULL DEFAULT 'CIBIL', score INTEGER, risk TEXT CHECK (risk IN ('low','medium','high')),
  pan_last4 TEXT, report_enc TEXT, note TEXT, error TEXT
);
CREATE INDEX IF NOT EXISTS credit_checks_candidate ON credit_checks(candidate_id);
