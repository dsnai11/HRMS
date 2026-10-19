-- Labour Welfare Fund rules, KRAs by designation, continuous feedback.
CREATE TABLE IF NOT EXISTS lwf_rules (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  state TEXT NOT NULL, employee_amount DOUBLE PRECISION NOT NULL DEFAULT 0, employer_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
  months TEXT NOT NULL, max_wage DOUBLE PRECISION, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS lwf_rules_state ON lwf_rules(company_id, lower(state));

CREATE TABLE IF NOT EXISTS kra_templates (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  designation_id INTEGER NOT NULL REFERENCES designations(id) ON DELETE CASCADE,
  title TEXT NOT NULL, description TEXT, weight INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS kra_templates_designation ON kra_templates(designation_id);

CREATE TABLE IF NOT EXISTS feedback (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  from_user INTEGER NOT NULL REFERENCES users(id), to_user INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('praise','improve','note')), body TEXT NOT NULL,
  shared INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS feedback_to ON feedback(to_user, id);
