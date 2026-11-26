-- After an exit: the full and final statement mailed a set number of days after the last day,
-- and a private link where the ex-employee can download only the documents HR allows.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fnf_mail_days INTEGER NOT NULL DEFAULT 45;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS alumni_link_days INTEGER NOT NULL DEFAULT 90;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS alumni_default_docs TEXT NOT NULL DEFAULT '["payslips","form16","relieving","experience","fnf"]';
ALTER TABLE exits ADD COLUMN IF NOT EXISTS fnf_mailed_at TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS alumni_docs TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS alumni_token_hash TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS alumni_expires_at TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS exits_alumni_token ON exits(alumni_token_hash) WHERE alumni_token_hash IS NOT NULL;
