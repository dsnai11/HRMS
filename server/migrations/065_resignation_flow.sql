-- A fuller resignation: why (a category and the employee's words), how to reach them after they
-- leave, a signed letter if they have one, who takes over their work, and an early-release
-- request. After HR accepts, the employee may ask to withdraw; HR decides.
ALTER TABLE exits ADD COLUMN IF NOT EXISTS reason_category TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS personal_email TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS personal_phone TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS letter_document_id INTEGER REFERENCES documents(id);
ALTER TABLE exits ADD COLUMN IF NOT EXISTS handover_to INTEGER REFERENCES users(id);
ALTER TABLE exits ADD COLUMN IF NOT EXISTS handover_notes TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS early_release INTEGER NOT NULL DEFAULT 0;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS withdraw_requested_at TEXT;
ALTER TABLE exits ADD COLUMN IF NOT EXISTS withdraw_reason TEXT;

-- The exit interview the employee fills in themselves: ratings and answers, kept for HR.
CREATE TABLE IF NOT EXISTS exit_interviews (
  exit_id INTEGER PRIMARY KEY REFERENCES exits(id) ON DELETE CASCADE,
  ratings TEXT NOT NULL, answers TEXT NOT NULL,
  would_rejoin INTEGER, would_recommend INTEGER,
  submitted_at TEXT NOT NULL
);
