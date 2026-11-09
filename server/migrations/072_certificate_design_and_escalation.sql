-- LMS: the look of the certificate, and following up training that is late.
-- A design is never edited: saving adds a new row, and each certificate keeps the design it was
-- issued under, so changing the signatory later does not alter certificates already given.
CREATE TABLE IF NOT EXISTS certificate_designs (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, message TEXT NOT NULL,
  style TEXT NOT NULL CHECK (style IN ('classic','modern','simple')), color TEXT NOT NULL,
  signatory_name TEXT, signatory_title TEXT,
  signature TEXT, signature_mime TEXT, seal TEXT, seal_mime TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS certificate_designs_company ON certificate_designs(company_id, id);
ALTER TABLE training_certificates ADD COLUMN IF NOT EXISTS design_id INTEGER REFERENCES certificate_designs(id);

-- How far an overdue course has been followed up: 0 nobody yet, 1 manager told,
-- 2 on HR's list (7 days late), 3 department head told (15 days late, mandatory courses).
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0;
