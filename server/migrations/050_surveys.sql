-- Engagement surveys and eNPS. Who answered (to stop answering twice and show the response
-- rate) and what was answered are kept apart, with no link between them; answers carry only
-- the department and branch for group results and the date, not the time.
CREATE TABLE IF NOT EXISTS surveys (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL,
  intro TEXT,
  questions TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT '{}',
  closes_on TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','open','closed')),
  opened_at TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS surveys_company ON surveys(company_id, status);
CREATE TABLE IF NOT EXISTS survey_responders (
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  PRIMARY KEY (survey_id, user_id)
);
CREATE TABLE IF NOT EXISTS survey_responses (
  id SERIAL PRIMARY KEY,
  survey_id INTEGER NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
  department_id INTEGER,
  branch_id INTEGER,
  answers TEXT NOT NULL,
  submitted_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS survey_responses_survey ON survey_responses(survey_id);
