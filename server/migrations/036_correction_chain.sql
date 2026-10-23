-- Attendance corrections pass through their own approval chain, like leave.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS correction_chain TEXT NOT NULL DEFAULT '["manager"]';
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS step_at TEXT;
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS approvals TEXT NOT NULL DEFAULT '[]';
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS reminded_at TEXT;
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS escalated_at TEXT;
