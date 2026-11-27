-- ATS score breakdown per candidate, and new openings go on the careers page by default
-- (an opening still shows only once it is approved and open).
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS match_detail TEXT;
ALTER TABLE job_openings ALTER COLUMN published SET DEFAULT 1;
-- What the hiring manager or department head thinks of an applicant.
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS team_view TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS team_view_note TEXT;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS team_view_by INTEGER;
ALTER TABLE candidates ADD COLUMN IF NOT EXISTS team_view_at TEXT;
