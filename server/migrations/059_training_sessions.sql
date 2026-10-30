-- Classroom and online training sessions: a date, time, place and trainer, the people invited,
-- and attendance marked afterwards. A session can belong to a tracked training, in which case
-- attending it completes that training for the person.
CREATE TABLE IF NOT EXISTS training_sessions (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  training_id INTEGER REFERENCES trainings(id) ON DELETE SET NULL,
  title TEXT NOT NULL, trainer TEXT, venue TEXT, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL,
  capacity INTEGER, notes TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled','completed')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_sessions_company ON training_sessions(company_id, starts_at);

CREATE TABLE IF NOT EXISTS session_attendees (
  id SERIAL PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','attended','absent')),
  marked_by INTEGER REFERENCES users(id), marked_at TEXT,
  UNIQUE (session_id, user_id)
);
CREATE INDEX IF NOT EXISTS session_attendees_user ON session_attendees(user_id);
