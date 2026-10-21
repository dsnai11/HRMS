-- Roles an administrator defines, each with its own set of permissions. A person
-- given one has users.role 'custom' and users.custom_role_id pointing here.
CREATE TABLE IF NOT EXISTS custom_roles (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', permissions TEXT NOT NULL DEFAULT '[]',
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS custom_roles_name ON custom_roles(company_id, lower(name));
ALTER TABLE users ADD COLUMN IF NOT EXISTS custom_role_id INTEGER REFERENCES custom_roles(id);
