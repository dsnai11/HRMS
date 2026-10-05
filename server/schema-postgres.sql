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
      out_at TEXT, out_latitude DOUBLE PRECISION, out_longitude DOUBLE PRECISION, out_accuracy DOUBLE PRECISION
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON shifts(user_id) WHERE out_at IS NULL;
    CREATE TABLE IF NOT EXISTS audit (
      id SERIAL PRIMARY KEY, actor_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at TEXT NOT NULL
    );
