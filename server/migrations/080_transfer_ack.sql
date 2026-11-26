-- A transfer must be acknowledged by the employee in the app. They may skip the popup twice;
-- the third time they must acknowledge. Each skip is kept for HR to see.
ALTER TABLE employee_changes ADD COLUMN IF NOT EXISTS ack_skips INTEGER NOT NULL DEFAULT 0;
ALTER TABLE employee_changes ADD COLUMN IF NOT EXISTS ack_skip_log TEXT NOT NULL DEFAULT '[]';
ALTER TABLE employee_changes ADD COLUMN IF NOT EXISTS acknowledged_at TEXT;
