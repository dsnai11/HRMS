CREATE TABLE IF NOT EXISTS workplaces (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL, radius DOUBLE PRECISION NOT NULL, max_accuracy DOUBLE PRECISION NOT NULL
    );
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','employee')),
      workplace_id INTEGER REFERENCES workplaces(id), active INTEGER NOT NULL DEFAULT 1,
      must_change_password INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shifts (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      workplace_id INTEGER NOT NULL REFERENCES workplaces(id), workplace_name TEXT NOT NULL,
      site_latitude DOUBLE PRECISION NOT NULL, site_longitude DOUBLE PRECISION NOT NULL, radius DOUBLE PRECISION NOT NULL, max_accuracy DOUBLE PRECISION NOT NULL,
      in_at TEXT NOT NULL, in_latitude DOUBLE PRECISION NOT NULL, in_longitude DOUBLE PRECISION NOT NULL, in_accuracy DOUBLE PRECISION NOT NULL,
      out_at TEXT, out_latitude DOUBLE PRECISION, out_longitude DOUBLE PRECISION, out_accuracy DOUBLE PRECISION,
      required_out_at TEXT, day_type TEXT, half_day_reasons TEXT NOT NULL DEFAULT '[]'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(user_id) WHERE out_at IS NULL;
    CREATE TABLE IF NOT EXISTS audit (
      id SERIAL PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      device_id TEXT NOT NULL, platform TEXT, model TEXT, secret_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','approved','revoked')),
      registered_at TEXT NOT NULL, last_seen_at TEXT, decided_by INTEGER REFERENCES users(id), decided_at TEXT,
      UNIQUE(user_id, device_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_approved_device ON devices(user_id) WHERE status='approved';
    CREATE TABLE IF NOT EXISTS punch_events (
      id SERIAL PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), shift_id INTEGER,
      action TEXT, outcome TEXT NOT NULL CHECK(outcome IN ('accepted','rejected')),
      reason TEXT, flags TEXT NOT NULL DEFAULT '[]', device_row_id INTEGER,
      latitude DOUBLE PRECISION, longitude DOUBLE PRECISION, accuracy DOUBLE PRECISION, signals TEXT, created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS punch_events_user ON punch_events(user_id, id);
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS required_out_at TEXT;
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS day_type TEXT;
    ALTER TABLE shifts ADD COLUMN IF NOT EXISTS half_day_reasons TEXT NOT NULL DEFAULT '[]';
