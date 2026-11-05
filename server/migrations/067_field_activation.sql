-- Field force activation: field staff are nudged each working morning to punch in, give a
-- reason if they have not, and their manager and HR get a report of who has not started.
ALTER TABLE users ADD COLUMN IF NOT EXISTS field_team TEXT CHECK (field_team IN ('collection','sales'));
ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_on INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_nudge_at TEXT NOT NULL DEFAULT '08:30';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_remind_at TEXT NOT NULL DEFAULT '10:00';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS activation_report_at TEXT NOT NULL DEFAULT '12:30';
-- One row per person per day once anything happens: the morning nudge, the reminder, the
-- reason they gave, and when the day's report went out.
CREATE TABLE IF NOT EXISTS activation_days (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), day TEXT NOT NULL,
  nudged_at TEXT, reminded_at TEXT,
  reason TEXT CHECK (reason IN ('on_the_way','on_leave','app_issue','call_me')),
  reason_note TEXT, reason_at TEXT, reported_at TEXT,
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS activation_days_company_day ON activation_days(company_id, day);
-- The day's report goes out once per company.
CREATE TABLE IF NOT EXISTS activation_reports (
  company_id INTEGER NOT NULL REFERENCES companies(id), day TEXT NOT NULL, sent_at TEXT NOT NULL,
  PRIMARY KEY (company_id, day)
);
