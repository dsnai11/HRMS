-- Employee master: grades and salary bands, cost centres, business units, custom fields, 360 profile, labels.
CREATE TABLE IF NOT EXISTS grades (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, level INTEGER, salary_min DOUBLE PRECISION, salary_max DOUBLE PRECISION,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS cost_centres (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS business_units (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
ALTER TABLE users ADD COLUMN IF NOT EXISTS grade_id INTEGER REFERENCES grades(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS cost_centre_id INTEGER REFERENCES cost_centres(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS business_unit_id INTEGER REFERENCES business_units(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom TEXT NOT NULL DEFAULT '{}';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS labels TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS custom_fields (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL, label TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'text' CHECK (type IN ('text','number','date','select')),
  options TEXT NOT NULL DEFAULT '[]', required INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE (company_id, key)
);

CREATE TABLE IF NOT EXISTS employee_education (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  degree TEXT NOT NULL, institute TEXT, year TEXT, score TEXT,
  added_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), verified_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_experience (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  employer TEXT NOT NULL, role TEXT, from_date TEXT, to_date TEXT, reason TEXT,
  added_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), verified_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS employee_skills (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  skill TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'intermediate' CHECK (level IN ('beginner','intermediate','expert')),
  added_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, UNIQUE (user_id, skill)
);
CREATE TABLE IF NOT EXISTS employee_certifications (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, issuer TEXT, issued_on TEXT, expires_on TEXT,
  added_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), verified_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS employee_education_user ON employee_education(user_id);
CREATE INDEX IF NOT EXISTS employee_experience_user ON employee_experience(user_id);
CREATE INDEX IF NOT EXISTS employee_certifications_user ON employee_certifications(user_id);
