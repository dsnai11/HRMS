-- Text messages sent (or attempted) through the configured SMS provider.
CREATE TABLE IF NOT EXISTS sms_outbox (
  id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
  to_phone TEXT NOT NULL, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
