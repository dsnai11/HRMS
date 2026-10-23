-- A file (PDF or photo) shared in a chat message.
CREATE TABLE IF NOT EXISTS chat_files (
  id SERIAL PRIMARY KEY, message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
  room_id INTEGER NOT NULL REFERENCES chat_rooms(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_files_message ON chat_files(message_id);
