-- Anonymous 360-degree feedback rounds. Ratings are stored per request so each can
-- be filled once, but results only ever leave the server as group averages.
CREATE TABLE IF NOT EXISTS feedback_rounds (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, questions TEXT NOT NULL, closes_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback_requests (
  id SERIAL PRIMARY KEY, round_id INTEGER NOT NULL REFERENCES feedback_rounds(id) ON DELETE CASCADE,
  subject_id INTEGER NOT NULL REFERENCES users(id), rater_id INTEGER NOT NULL REFERENCES users(id),
  relation TEXT NOT NULL CHECK (relation IN ('self','manager','report','peer')),
  ratings TEXT, comment TEXT, submitted_at TEXT,
  UNIQUE (round_id, subject_id, rater_id)
);
CREATE INDEX IF NOT EXISTS feedback_requests_rater ON feedback_requests(rater_id);
