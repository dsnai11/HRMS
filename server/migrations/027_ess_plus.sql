-- Self-service: bank change requests with approval, helpdesk response times.
CREATE TABLE IF NOT EXISTS bank_change_requests (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), data_enc TEXT NOT NULL, summary TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL, note TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bank_change_user ON bank_change_requests(user_id, status);

ALTER TABLE companies ADD COLUMN IF NOT EXISTS ticket_sla TEXT NOT NULL DEFAULT '{"low":72,"normal":48,"high":24}';
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS due_at TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS first_response_at TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at TEXT;
