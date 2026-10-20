-- Interviews: panels, department-wise question bank, per-question scoring, calendar invites.
CREATE TABLE IF NOT EXISTS question_bank (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  department_id INTEGER REFERENCES departments(id),
  category TEXT NOT NULL DEFAULT 'technical' CHECK (category IN ('technical','behavioural','situational','domain')),
  difficulty TEXT NOT NULL DEFAULT 'medium' CHECK (difficulty IN ('easy','medium','hard')),
  question TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS question_bank_company ON question_bank(company_id, active);

ALTER TABLE interviews ADD COLUMN IF NOT EXISTS panel_key TEXT;
ALTER TABLE interviews ADD COLUMN IF NOT EXISTS duration_minutes INTEGER NOT NULL DEFAULT 60;
CREATE INDEX IF NOT EXISTS interviews_panel ON interviews(panel_key);

CREATE TABLE IF NOT EXISTS interview_questions (
  id SERIAL PRIMARY KEY, interview_id INTEGER NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id INTEGER REFERENCES question_bank(id) ON DELETE SET NULL,
  question TEXT NOT NULL, category TEXT, position INTEGER NOT NULL, rating INTEGER CHECK (rating BETWEEN 1 AND 5)
);
CREATE INDEX IF NOT EXISTS interview_questions_interview ON interview_questions(interview_id);
