-- Appearance set by an administrator on the web portal and used by the portal and the phone
-- app: the brand colour, an optional accent, and the logo (stored like other files).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_primary TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_accent TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_logo TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_logo_mime TEXT;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS brand_updated_at TEXT;

-- A profile photograph for each person, uploaded by them or by HR, or taken from the
-- photograph given while joining.
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_mime TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS photo_updated_at TEXT;
