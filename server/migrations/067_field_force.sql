-- Field Force (the Field Force Activation plan). Kept apart from the rest of the HRMS: its
-- own ff_ tables only, nothing added to users or companies, so the module can be switched
-- off (FIELD_FORCE=off) or removed without touching other features.

-- Who is field staff, and in which team.
CREATE TABLE IF NOT EXISTS ff_staff (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  team TEXT NOT NULL CHECK (team IN ('collection','sales')),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ff_staff_company ON ff_staff(company_id);

-- The company's morning clock. No row: off, with the default times.
CREATE TABLE IF NOT EXISTS ff_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id),
  active INTEGER NOT NULL DEFAULT 0,
  nudge_at TEXT NOT NULL DEFAULT '08:30',
  remind_at TEXT NOT NULL DEFAULT '10:00',
  report_at TEXT NOT NULL DEFAULT '12:30'
);

-- One row per person per day once anything happens: the nudge, the reminder, the reason
-- they gave, and when the day's report went out.
CREATE TABLE IF NOT EXISTS ff_days (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  nudged_at TEXT, reminded_at TEXT,
  reason TEXT CHECK (reason IN ('on_the_way','on_leave','app_issue','call_me')),
  reason_note TEXT, reason_at TEXT, reason_via TEXT, reported_at TEXT,
  UNIQUE (user_id, day)
);
CREATE INDEX IF NOT EXISTS ff_days_company_day ON ff_days(company_id, day);

-- The day's report goes out once per company.
CREATE TABLE IF NOT EXISTS ff_reports (
  company_id INTEGER NOT NULL REFERENCES companies(id), day TEXT NOT NULL, sent_at TEXT NOT NULL,
  PRIMARY KEY (company_id, day)
);
