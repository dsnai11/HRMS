-- Documents, performance, training, two-factor login and session controls.
CREATE TABLE IF NOT EXISTS documents (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL,
  uploaded_by INTEGER REFERENCES users(id), verified_by INTEGER REFERENCES users(id), verified_at TEXT,
  created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS documents_user ON documents(user_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS review_cycles (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')), created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  cycle_id INTEGER NOT NULL REFERENCES review_cycles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), manager_id INTEGER REFERENCES users(id),
  self_rating INTEGER CHECK (self_rating BETWEEN 1 AND 5), self_comment TEXT,
  manager_rating INTEGER CHECK (manager_rating BETWEEN 1 AND 5), manager_comment TEXT,
  status TEXT NOT NULL DEFAULT 'pending_self' CHECK (status IN ('pending_self','pending_manager','completed')),
  released INTEGER NOT NULL DEFAULT 0, completed_at TEXT,
  UNIQUE (cycle_id, user_id)
);
CREATE INDEX IF NOT EXISTS reviews_user ON reviews(user_id);
CREATE TABLE IF NOT EXISTS goals (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), cycle_id INTEGER REFERENCES review_cycles(id),
  title TEXT NOT NULL, description TEXT, weight INTEGER NOT NULL DEFAULT 0, progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  due_date TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','done','dropped')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goals_user ON goals(user_id, status);

CREATE TABLE IF NOT EXISTS trainings (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, hours DOUBLE PRECISION NOT NULL DEFAULT 1, mandatory INTEGER NOT NULL DEFAULT 0,
  due_date TEXT, created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS training_records (
  id SERIAL PRIMARY KEY, training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned','completed')),
  completed_on TEXT, score DOUBLE PRECISION, UNIQUE (training_id, user_id)
);
CREATE INDEX IF NOT EXISTS training_records_user ON training_records(user_id);

ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_pending TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_recovery TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS id SERIAL;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS created_at TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ip TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent TEXT;
