-- Hiring, onboarding and company assets.
CREATE TABLE IF NOT EXISTS job_openings (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, department_id INTEGER REFERENCES departments(id), branch_id INTEGER REFERENCES branches(id),
  designation_id INTEGER REFERENCES designations(id), positions INTEGER NOT NULL DEFAULT 1,
  employment_type TEXT, description TEXT, hiring_manager_id INTEGER REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','on_hold','closed')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS job_openings_company ON job_openings(company_id, status);

CREATE TABLE IF NOT EXISTS candidates (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  opening_id INTEGER REFERENCES job_openings(id), name TEXT NOT NULL, email TEXT, phone TEXT, source TEXT,
  stage TEXT NOT NULL DEFAULT 'applied' CHECK (stage IN ('applied','screening','interview','offer','hired','rejected','withdrawn')),
  expected_ctc DOUBLE PRECISION, notice_days INTEGER, resume_url TEXT, notes TEXT, closed_reason TEXT,
  user_id INTEGER REFERENCES users(id), created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidates_company ON candidates(company_id, stage);
CREATE INDEX IF NOT EXISTS candidates_opening ON candidates(opening_id);
CREATE TABLE IF NOT EXISTS candidate_events (
  id SERIAL PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, detail TEXT, actor_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_events_candidate ON candidate_events(candidate_id);

CREATE TABLE IF NOT EXISTS interviews (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_name TEXT NOT NULL, interviewer_id INTEGER NOT NULL REFERENCES users(id),
  scheduled_at TEXT NOT NULL, mode TEXT NOT NULL DEFAULT 'in_person' CHECK (mode IN ('in_person','phone','video')),
  location TEXT, status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','completed','cancelled','no_show')),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  recommendation TEXT CHECK (recommendation IN ('strong_yes','yes','no','strong_no')),
  feedback TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interviews_candidate ON interviews(candidate_id);
CREATE INDEX IF NOT EXISTS interviews_interviewer ON interviews(interviewer_id, status);

CREATE TABLE IF NOT EXISTS offers (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  designation TEXT NOT NULL, monthly_gross DOUBLE PRECISION NOT NULL, joining_date TEXT NOT NULL,
  valid_until TEXT, note TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','sent','accepted','declined','withdrawn')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, decided_at TEXT
);
CREATE INDEX IF NOT EXISTS offers_candidate ON offers(candidate_id);

CREATE TABLE IF NOT EXISTS onboarding_template (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  owner TEXT NOT NULL DEFAULT 'hr' CHECK (owner IN ('hr','manager','employee','it')),
  due_days INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS onboarding_tasks (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'general',
  owner TEXT NOT NULL DEFAULT 'hr' CHECK (owner IN ('hr','manager','employee','it')),
  due_date TEXT, done INTEGER NOT NULL DEFAULT 0, done_at TEXT, done_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS onboarding_tasks_user ON onboarding_tasks(user_id, done);

CREATE TABLE IF NOT EXISTS assets (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, tag TEXT NOT NULL, category TEXT,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','assigned','retired')),
  assigned_to INTEGER REFERENCES users(id), assigned_at TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS assets_tag ON assets(company_id, lower(tag));
CREATE INDEX IF NOT EXISTS assets_user ON assets(assigned_to);
