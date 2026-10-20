-- Recruitment: requisitions, skill matching, careers page, applicant tracker, email templates, CTC breakup.
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS qualifications TEXT;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS min_experience_years DOUBLE PRECISION;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS salary_min DOUBLE PRECISION;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS salary_max DOUBLE PRECISION;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS min_score INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS published INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS closing_date TEXT;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS approval_status TEXT NOT NULL DEFAULT 'approved';
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS requested_by INTEGER REFERENCES users(id);
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS approved_by INTEGER REFERENCES users(id);
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS approval_note TEXT;
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS justification TEXT;

ALTER TABLE candidates ADD COLUMN IF NOT EXISTS skills TEXT NOT NULL DEFAULT '[]';
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS experience_years DOUBLE PRECISION;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS qualification TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS match_score INTEGER;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS track_token_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS candidates_track ON candidates(track_token_hash) WHERE track_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS candidate_files (
  id SERIAL PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'resume', name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  data TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_files_candidate ON candidate_files(candidate_id);

CREATE TABLE IF NOT EXISTS recruitment_templates (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  key TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  UNIQUE (company_id, key)
);

ALTER TABLE offers ADD COLUMN IF NOT EXISTS ctc_breakup TEXT;
