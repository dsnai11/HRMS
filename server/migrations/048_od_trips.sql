-- OD trips: during a normal shift, an employee goes out on duty ("OD Out") and comes back
-- ("OD In"), or ends the day outside by punching out. Each trip waits for approval.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS od_everyone INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS od_visits (
  id SERIAL PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL,
  out_at TEXT NOT NULL,
  out_latitude DOUBLE PRECISION NOT NULL, out_longitude DOUBLE PRECISION NOT NULL, out_accuracy DOUBLE PRECISION NOT NULL,
  in_at TEXT,
  in_latitude DOUBLE PRECISION, in_longitude DOUBLE PRECISION, in_accuracy DOUBLE PRECISION,
  ended_by TEXT CHECK (ended_by IN ('od_in','punch_out','auto')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','pending','approved','rejected')),
  decided_by INTEGER REFERENCES users(id), decided_at TEXT, decision_note TEXT,
  created_at TEXT NOT NULL,
  CHECK (status = 'open' OR ended_by IS NOT NULL)
);
-- One trip out at a time, even if the button is pressed twice.
CREATE UNIQUE INDEX IF NOT EXISTS od_visits_one_open ON od_visits(user_id) WHERE status='open';
CREATE INDEX IF NOT EXISTS od_visits_shift ON od_visits(shift_id);
CREATE INDEX IF NOT EXISTS od_visits_company ON od_visits(company_id, status);
CREATE INDEX IF NOT EXISTS od_visits_out ON od_visits(company_id, out_at);
