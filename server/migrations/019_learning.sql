-- Learning: self-paced courses (lessons, quiz, certificate) on top of tracked trainings.
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'tracked';
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS description TEXT;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS pass_mark INTEGER NOT NULL DEFAULT 70;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS max_attempts INTEGER NOT NULL DEFAULT 3;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS auto_assign INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS due_days INTEGER NOT NULL DEFAULT 30;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS active INTEGER NOT NULL DEFAULT 1;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS due_date TEXT;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS started_at TEXT;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS certificate_no TEXT;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS reminded_on TEXT;

CREATE TABLE IF NOT EXISTS training_lessons (
  id SERIAL PRIMARY KEY, training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, title TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text','link','video')), body TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_lessons_training ON training_lessons(training_id, position);
CREATE TABLE IF NOT EXISTS training_questions (
  id SERIAL PRIMARY KEY, training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  position INTEGER NOT NULL, question TEXT NOT NULL, options TEXT NOT NULL, correct INTEGER NOT NULL, explanation TEXT
);
CREATE INDEX IF NOT EXISTS training_questions_training ON training_questions(training_id, position);
CREATE TABLE IF NOT EXISTS training_progress (
  id SERIAL PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES training_records(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE, done_at TEXT NOT NULL,
  UNIQUE (record_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS training_attempts (
  id SERIAL PRIMARY KEY, record_id INTEGER NOT NULL REFERENCES training_records(id) ON DELETE CASCADE,
  score INTEGER NOT NULL, passed INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_attempts_record ON training_attempts(record_id);
