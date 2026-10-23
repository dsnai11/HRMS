-- Engagement gallery: event photos HR shares with everyone (resized JPEG/PNG, base64).
CREATE TABLE IF NOT EXISTS gallery_photos (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, category TEXT NOT NULL, event_date TEXT NOT NULL,
  branch_id INTEGER REFERENCES branches(id), mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL,
  posted_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, deleted_at TEXT
);
