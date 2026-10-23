-- Recruitment management: where resumes come from. Each source (LinkedIn, Naukri,
-- WhatsApp, email, agency…) gets a secret key; a connector posts candidates to
-- /api/intake/<key>. A candidate seen again from another source keeps one record and
-- gains a source entry.
CREATE TABLE IF NOT EXISTS intake_sources (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, kind TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE, key_hint TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, received INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, last_used_at TEXT
);
CREATE TABLE IF NOT EXISTS candidate_sources (
  id SERIAL PRIMARY KEY, candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  source_id INTEGER REFERENCES intake_sources(id), source_name TEXT NOT NULL,
  external_ref TEXT, received_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS candidate_sources_candidate ON candidate_sources(candidate_id);

-- A company-wide HR team room, open only to people with the hrchat.use right.
ALTER TABLE chat_rooms DROP CONSTRAINT IF EXISTS chat_rooms_kind_check;
ALTER TABLE chat_rooms ADD CONSTRAINT chat_rooms_kind_check CHECK (kind IN ('direct','group','team'));
CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_team ON chat_rooms(company_id) WHERE kind='team';
