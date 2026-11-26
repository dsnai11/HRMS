-- Which employee an activity-log entry is about, so HR can open one employee's full history
-- (what they did and what was done to their record).
ALTER TABLE audit ADD COLUMN IF NOT EXISTS subject_id INTEGER;
UPDATE audit SET subject_id = CAST(detail::json->>'employeeId' AS INTEGER)
  WHERE subject_id IS NULL AND detail::json->>'employeeId' ~ '^[0-9]+$'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = CAST(audit.detail::json->>'employeeId' AS INTEGER));
UPDATE audit SET subject_id = CAST(detail::json->>'id' AS INTEGER)
  WHERE subject_id IS NULL AND action IN ('employee_created','employee_updated')
  AND detail::json->>'id' ~ '^[0-9]+$'
  AND EXISTS (SELECT 1 FROM users u WHERE u.id = CAST(audit.detail::json->>'id' AS INTEGER));
CREATE INDEX IF NOT EXISTS audit_subject ON audit(subject_id, id);
