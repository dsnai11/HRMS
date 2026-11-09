-- A daily mail to each supervisor listing the people who report to them who are late, on leave
-- or have not punched in. The log makes sure each supervisor gets it once a day.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS team_mail_enabled INTEGER NOT NULL DEFAULT 1;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS team_mail_time TEXT NOT NULL DEFAULT '11:00';
CREATE TABLE IF NOT EXISTS team_attendance_mail_log (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  manager_id INTEGER NOT NULL REFERENCES users(id),
  day TEXT NOT NULL, people INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (manager_id, day)
);
