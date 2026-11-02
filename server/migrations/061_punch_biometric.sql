-- Ask for the phone's fingerprint or face check before every punch.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS require_biometric INTEGER NOT NULL DEFAULT 0;
