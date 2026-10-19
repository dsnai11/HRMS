-- Which Insights widgets a person sees, and in what order.
CREATE TABLE IF NOT EXISTS dashboard_prefs (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  layout TEXT NOT NULL, updated_at TEXT NOT NULL
);
