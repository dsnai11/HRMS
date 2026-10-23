-- Fields the earlier HR portal kept: organisation detail and voluntary PF.
ALTER TABLE users ADD COLUMN IF NOT EXISTS division TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS section TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_level TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS job_title_code TEXT;
-- Voluntary PF: extra employee PF as a percentage of PF wages (reported in the ECR employee share).
ALTER TABLE employee_salaries ADD COLUMN IF NOT EXISTS vpf_percent DOUBLE PRECISION NOT NULL DEFAULT 0;
