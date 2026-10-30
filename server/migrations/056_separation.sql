-- Separation by the manager: a manager gives a view on a team member's resignation before HR
-- decides, and can ask HR to separate someone (termination, or absconding when they stopped
-- coming to work). HR approves or rejects; approval starts an ordinary exit with clearance.
ALTER TABLE exits DROP CONSTRAINT IF EXISTS exits_kind_check;
ALTER TABLE exits ADD CONSTRAINT exits_kind_check
  CHECK (kind IN ('resignation','termination','retirement','end_of_contract','absconding','other'));
ALTER TABLE exits ADD COLUMN IF NOT EXISTS manager_view TEXT CHECK (manager_view IN ('accept','retain'));
ALTER TABLE exits ADD COLUMN IF NOT EXISTS manager_note TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS manager_last_day TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS manager_by INTEGER REFERENCES users(id);
ALTER TABLE exits ADD COLUMN IF NOT EXISTS manager_at TEXT;

CREATE TABLE IF NOT EXISTS separation_requests (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('termination','absconding')),
  reason TEXT NOT NULL, last_seen_on TEXT, proposed_last_day TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  exit_id INTEGER REFERENCES exits(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS separation_live ON separation_requests(user_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS separation_company ON separation_requests(company_id, status);
