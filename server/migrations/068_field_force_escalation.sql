-- Field Force, Phase 2: escalation by WhatsApp, IVR call and AI call. Field Force tables only.
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS whatsapp INTEGER NOT NULL DEFAULT 0;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS wa_nudge_template TEXT NOT NULL DEFAULT 'ff_morning_activation';
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS wa_remind_template TEXT NOT NULL DEFAULT 'ff_activation_reason';
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS wa_language TEXT NOT NULL DEFAULT 'en';
-- Blank: that call is not made.
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS ivr_at TEXT;
ALTER TABLE ff_settings ADD COLUMN IF NOT EXISTS ai_at TEXT;

-- Every message and call to a field person, and what came back: the audit trail of who was
-- contacted, how, and what they answered.
CREATE TABLE IF NOT EXISTS ff_contacts (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, day TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('whatsapp','ivr','ai')),
  step TEXT NOT NULL CHECK (step IN ('nudge','remind','ivr','ai')),
  status TEXT NOT NULL CHECK (status IN ('sent','failed','answered','no_answer','skipped')),
  external_id TEXT, reason TEXT, detail TEXT,
  created_at TEXT NOT NULL, updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ff_contacts_day ON ff_contacts(company_id, day);
-- One call of each kind per person per day.
CREATE UNIQUE INDEX IF NOT EXISTS ff_contacts_one_call ON ff_contacts(user_id, day, step) WHERE channel IN ('ivr','ai');
