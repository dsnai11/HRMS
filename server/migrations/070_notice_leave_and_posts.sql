-- Leave during the notice period: HR chooses which leave types may be taken once a resignation
-- is accepted (all allowed until HR changes it), and whether approved leave in the notice period
-- moves the last working day later.
ALTER TABLE leave_types ADD COLUMN IF NOT EXISTS allowed_in_notice INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS notice_leave_extends INTEGER NOT NULL DEFAULT 0;

-- A job opening created above the branch's sanctioned posts: HR's reason for going ahead.
ALTER TABLE job_openings ADD COLUMN IF NOT EXISTS over_sanction_reason TEXT;
