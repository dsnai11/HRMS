-- Full LMS: categories, a catalogue people enrol in themselves, department / branch /
-- designation audiences that keep assigning a course to whoever fits, certificates
-- with an optional validity (renewed by retaking the course) and their history.
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS category TEXT;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS open_enrol INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trainings ADD COLUMN IF NOT EXISTS valid_months INTEGER;
ALTER TABLE training_records ADD COLUMN IF NOT EXISTS expires_on TEXT;

-- One rule per row; an empty column matches everyone. A rule with all three empty means everyone.
CREATE TABLE IF NOT EXISTS training_audiences (
  id SERIAL PRIMARY KEY, training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  department_id INTEGER REFERENCES departments(id) ON DELETE CASCADE,
  branch_id INTEGER REFERENCES branches(id) ON DELETE CASCADE,
  designation_id INTEGER REFERENCES designations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_audiences_training ON training_audiences(training_id);

-- Every certificate ever issued, kept when a course is renewed.
CREATE TABLE IF NOT EXISTS training_certificates (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  certificate_no TEXT NOT NULL UNIQUE, completed_on TEXT NOT NULL,
  score DOUBLE PRECISION, expires_on TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS training_certificates_user ON training_certificates(user_id);

INSERT INTO training_certificates(company_id,training_id,user_id,certificate_no,completed_on,score,created_at)
SELECT t.company_id,r.training_id,r.user_id,r.certificate_no,r.completed_on,r.score,r.completed_on
FROM training_records r JOIN trainings t ON t.id=r.training_id
WHERE r.certificate_no IS NOT NULL AND r.completed_on IS NOT NULL
ON CONFLICT (certificate_no) DO NOTHING;
