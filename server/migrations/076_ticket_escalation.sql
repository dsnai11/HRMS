-- Helpdesk tickets left open past their response time move up: first to the assignee's manager
-- and the helpdesk team, then (after another full response time) to the person HR chose for
-- final escalation, or the admins if nobody is chosen.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalation_level INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS escalated_at TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS ticket_escalate_to INTEGER REFERENCES users(id);
