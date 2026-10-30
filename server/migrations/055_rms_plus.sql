-- RMS: screening questions with knock-out rules, recruiters on openings, candidate city,
-- source costs for cost per hire, candidate self-scheduling of interviews, and the
-- mailbox and WhatsApp intake settings.
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS screening TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS recruiter_id INTEGER REFERENCES users(id);
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS screening TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS location TEXT;
ALTER TABLE intake_sources ADD COLUMN IF NOT EXISTS fee_per_hire DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE intake_sources ADD COLUMN IF NOT EXISTS monthly_cost DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE intake_sources ADD COLUMN IF NOT EXISTS default_opening_id INTEGER REFERENCES job_openings(id);
ALTER TABLE intake_sources ADD COLUMN IF NOT EXISTS settings TEXT;
ALTER TABLE intake_sources ADD COLUMN IF NOT EXISTS last_error TEXT;
CREATE INDEX IF NOT EXISTS candidate_sources_source ON candidate_sources(source_id);
CREATE TABLE IF NOT EXISTS interview_invites (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  round_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  location TEXT,
  duration_minutes INTEGER NOT NULL,
  interviewer_ids TEXT NOT NULL,
  slots TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','booked','cancelled')),
  booked_at TEXT,
  booked_slot TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS interview_invites_candidate ON interview_invites(candidate_id);
