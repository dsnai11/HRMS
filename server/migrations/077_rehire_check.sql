-- Ex-employee check on candidates. When a candidate matches someone who left, HR must answer:
-- continue (confirmed), or put the profile on hold and later accept or reject it.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS rehire_of INTEGER REFERENCES users(id);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS rehire_status TEXT
  CHECK (rehire_status IN ('confirmed','hold','accepted','rejected'));
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS rehire_decided_by INTEGER REFERENCES users(id);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS rehire_decided_at TEXT;
CREATE INDEX IF NOT EXISTS candidates_rehire_hold ON candidates(company_id) WHERE rehire_status='hold';
