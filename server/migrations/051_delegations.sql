-- A manager away hands their approvals to someone else for a period.
CREATE TABLE IF NOT EXISTS approval_delegations (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  delegate_id INTEGER NOT NULL REFERENCES users(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  reason TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  cancelled_at TEXT,
  CHECK (user_id <> delegate_id),
  CHECK (ends_on >= starts_on)
);
CREATE INDEX IF NOT EXISTS approval_delegations_delegate ON approval_delegations(delegate_id, starts_on, ends_on);
CREATE INDEX IF NOT EXISTS approval_delegations_user ON approval_delegations(user_id, starts_on);
