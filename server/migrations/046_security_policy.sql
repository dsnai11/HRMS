-- Company security policy: office-only addresses for staff with HR or admin rights on the
-- web portal, signing out idle browsers, password expiry and required two-factor login.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS staff_ip_allowlist TEXT NOT NULL DEFAULT '[]';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS idle_minutes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS password_max_days INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS require_staff_2fa INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_changed_at TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS native INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at BIGINT;
