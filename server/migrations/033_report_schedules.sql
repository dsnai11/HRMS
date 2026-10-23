-- Reports emailed on a schedule (see server/scheduled-reports.js).
CREATE TABLE IF NOT EXISTS report_schedules (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  report TEXT NOT NULL, frequency TEXT NOT NULL, day INTEGER NOT NULL DEFAULT 0,
  recipients TEXT NOT NULL DEFAULT '[]', last_sent_on TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
