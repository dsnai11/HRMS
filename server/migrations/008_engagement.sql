-- Notifications, announcements, helpdesk, policy acknowledgement.
CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT, link TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id, read_at, id);

CREATE TABLE IF NOT EXISTS email_outbox (
  id SERIAL PRIMARY KEY, company_id INTEGER REFERENCES companies(id),
  to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE INDEX IF NOT EXISTS email_outbox_status ON email_outbox(status, id);

CREATE TABLE IF NOT EXISTS announcements (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, body TEXT NOT NULL,
  branch_id INTEGER REFERENCES branches(id), department_id INTEGER REFERENCES departments(id),
  pinned INTEGER NOT NULL DEFAULT 0, expires_on TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS announcements_company ON announcements(company_id, created_at);

CREATE TABLE IF NOT EXISTS tickets (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), category TEXT NOT NULL,
  subject TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high')),
  assigned_to INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tickets_company ON tickets(company_id, status);
CREATE INDEX IF NOT EXISTS tickets_user ON tickets(user_id);
CREATE TABLE IF NOT EXISTS ticket_messages (
  id SERIAL PRIMARY KEY, ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), body TEXT NOT NULL,
  internal INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ticket_messages_ticket ON ticket_messages(ticket_id);

CREATE TABLE IF NOT EXISTS policies (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  title TEXT NOT NULL, body TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS policy_acks (
  id SERIAL PRIMARY KEY, policy_id INTEGER NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id), version INTEGER NOT NULL, acknowledged_at TEXT NOT NULL,
  UNIQUE (policy_id, user_id, version)
);
