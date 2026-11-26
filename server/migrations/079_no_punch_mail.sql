-- A mail when someone has not punched for a run of working days (default 3; 0 turns it off).
-- Each run of missed days is mailed once.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS no_punch_mail_days INTEGER NOT NULL DEFAULT 3;
CREATE TABLE IF NOT EXISTS no_punch_alerts (
  user_id INTEGER NOT NULL REFERENCES users(id),
  streak_from TEXT NOT NULL, days INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, streak_from)
);
