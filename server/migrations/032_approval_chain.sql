-- Multi-level leave approval: the steps a request passes through, in order, and
-- when to remind approvers and escalate to HR.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS leave_chain TEXT NOT NULL DEFAULT '["manager"]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS approval_reminder_hours INTEGER NOT NULL DEFAULT 24;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS approval_escalate_hours INTEGER NOT NULL DEFAULT 72;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS step INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS step_at TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS approvals TEXT NOT NULL DEFAULT '[]';
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS reminded_at TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS escalated_at TEXT;
