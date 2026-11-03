-- Short leave: an approved late arrival or early departure for a few hours; the day counts in full.
ALTER TABLE regularizations DROP CONSTRAINT IF EXISTS regularizations_kind_check;
ALTER TABLE regularizations ADD CONSTRAINT regularizations_kind_check
  CHECK (kind IN ('missed_punch','wrong_punch','on_duty','work_from_home','short_leave'));

-- Multiple OD: one request for a run of days out on duty, stored as one on-duty correction per
-- working day that share a batch id, so each day still has its own approval and shift.
ALTER TABLE regularizations ADD COLUMN IF NOT EXISTS batch_id TEXT;
CREATE INDEX IF NOT EXISTS regularizations_batch ON regularizations(batch_id) WHERE batch_id IS NOT NULL;

-- Optional (restricted) holidays: each person may choose up to this many a year; an approved
-- choice is a holiday for that person only.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS optional_holiday_limit INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS optional_holiday_choices (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), date TEXT NOT NULL, name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS optional_holiday_choices_live
  ON optional_holiday_choices(user_id, date) WHERE status IN ('pending','approved');
CREATE INDEX IF NOT EXISTS optional_holiday_choices_company ON optional_holiday_choices(company_id, status);
