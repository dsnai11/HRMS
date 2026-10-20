-- Internal chat and the Laxmi HR assistant.
CREATE TABLE IF NOT EXISTS chat_rooms (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  kind TEXT NOT NULL CHECK (kind IN ('direct','group')), name TEXT, direct_key TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, last_message_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS chat_rooms_direct ON chat_rooms(company_id, direct_key) WHERE direct_key IS NOT NULL;
CREATE TABLE IF NOT EXISTS chat_members (
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_admin INTEGER NOT NULL DEFAULT 0, last_read_id INTEGER NOT NULL DEFAULT 0, joined_at TEXT NOT NULL,
  PRIMARY KEY (room_id, user_id)
);
CREATE INDEX IF NOT EXISTS chat_members_user ON chat_members(user_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id SERIAL PRIMARY KEY, room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL, created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS chat_messages_room ON chat_messages(room_id, id);

-- Day of the month salary is credited (1-31; a later day than the month has means its last day).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS pay_day INTEGER;
CREATE TABLE IF NOT EXISTS bot_knowledge (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, body TEXT NOT NULL, keywords TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bot_log (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), question TEXT NOT NULL, answer TEXT NOT NULL,
  intent TEXT, source TEXT NOT NULL, answered INTEGER NOT NULL DEFAULT 1, helpful INTEGER, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS bot_log_company ON bot_log(company_id, id);
