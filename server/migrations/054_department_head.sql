-- Each department can have a head: people joining it with no reporting manager report to them.
ALTER TABLE departments ADD COLUMN IF NOT EXISTS head_id INTEGER REFERENCES users(id);
