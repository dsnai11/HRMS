-- Field Force, Phase 3: location during the working day, and the 2-hour no-movement check.
-- Field Force tables only. Locations are taken only while a person is punched in, only after
-- they agreed on their phone, and are deleted after the company's retention period.
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS tracking INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS ping_minutes INTEGER NOT NULL DEFAULT 15;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS still_minutes INTEGER NOT NULL DEFAULT 120;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS still_meters INTEGER NOT NULL DEFAULT 200;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS keep_days INTEGER NOT NULL DEFAULT 90;

-- The person agreed, on their phone, to location being shared while punched in.
CREATE TABLE IF NOT EXISTS ff_consents (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  version INTEGER NOT NULL, agreed_at TEXT NOT NULL, withdrawn_at TEXT
);

-- Location points during the shift: from the app, or uploaded from a tracker.
CREATE TABLE IF NOT EXISTS ff_pings (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  at TEXT NOT NULL, latitude DOUBLE PRECISION NOT NULL, longitude DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION, mocked INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'app' CHECK (source IN ('app','tracker')),
  UNIQUE (user_id, at)
);
CREATE INDEX IF NOT EXISTS ff_pings_day ON ff_pings(company_id, day);

-- Customer or market visits the person logged; a visit pauses the no-movement alert.
CREATE TABLE IF NOT EXISTS ff_visits (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  at TEXT NOT NULL, latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, accuracy DOUBLE PRECISION,
  customer TEXT, note TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ff_visits_day ON ff_visits(company_id, day);

-- No-movement alerts: to the person, and to the manager when it happens again the same day.
CREATE TABLE IF NOT EXISTS ff_alerts (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('no_movement','no_signal')),
  level TEXT NOT NULL CHECK (level IN ('person','manager')),
  since TEXT NOT NULL, at TEXT NOT NULL, closed_at TEXT
);
CREATE INDEX IF NOT EXISTS ff_alerts_day ON ff_alerts(company_id, day);
