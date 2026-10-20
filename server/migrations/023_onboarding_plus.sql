-- Onboarding: IT/Finance/Admin task owners, NDA and policy sign-off before joining.
ALTER TABLE onboarding_tasks DROP CONSTRAINT IF EXISTS onboarding_tasks_owner_check;
ALTER TABLE onboarding_tasks ADD CONSTRAINT onboarding_tasks_owner_check CHECK (owner IN ('hr','manager','employee','it','finance','admin'));
ALTER TABLE onboarding_template DROP CONSTRAINT IF EXISTS onboarding_template_owner_check;
ALTER TABLE onboarding_template ADD CONSTRAINT onboarding_template_owner_check CHECK (owner IN ('hr','manager','employee','it','finance','admin'));

CREATE TABLE IF NOT EXISTS onboarding_owner_members (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  owner TEXT NOT NULL CHECK (owner IN ('it','finance','admin')),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, owner, user_id)
);

CREATE TABLE IF NOT EXISTS joining_documents (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'policy' CHECK (kind IN ('nda','policy','other')),
  required INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS joining_acks (
  id SERIAL PRIMARY KEY, document_id INTEGER NOT NULL REFERENCES joining_documents(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title TEXT NOT NULL, text_snapshot TEXT NOT NULL, given_name TEXT NOT NULL, given_ip TEXT, given_at TEXT NOT NULL,
  UNIQUE (document_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS joining_acks_candidate ON joining_acks(candidate_id);
