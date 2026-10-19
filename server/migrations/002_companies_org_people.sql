-- Companies, org structure, roles and employee profiles.
CREATE TABLE IF NOT EXISTS companies (
  id SERIAL PRIMARY KEY, name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);
ALTER TABLE audit ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id);

CREATE TABLE IF NOT EXISTS branches (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT, city TEXT, state TEXT, address TEXT,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS branches_name ON branches(company_id, lower(name));
CREATE TABLE IF NOT EXISTS departments (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS departments_name ON departments(company_id, lower(name));
CREATE TABLE IF NOT EXISTS designations (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS designations_name ON designations(company_id, lower(name));

ALTER TABLE workplaces ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS employee_code TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_birth TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS date_of_joining TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment_type TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS branch_id INTEGER REFERENCES branches(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS department_id INTEGER REFERENCES departments(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS designation_id INTEGER REFERENCES designations(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS manager_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_phone TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS emergency_relation TEXT;

-- Roles are validated by the application (see rbac.js), so new roles need no migration.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role='super_admin' WHERE role='admin';

CREATE UNIQUE INDEX IF NOT EXISTS users_employee_code ON users(company_id, employee_code) WHERE employee_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS users_company ON users(company_id);
CREATE INDEX IF NOT EXISTS users_manager ON users(manager_id);
CREATE INDEX IF NOT EXISTS workplaces_company ON workplaces(company_id);
CREATE INDEX IF NOT EXISTS shifts_user_in ON shifts(user_id, in_at);
CREATE INDEX IF NOT EXISTS shifts_in_at ON shifts(in_at);
CREATE INDEX IF NOT EXISTS audit_company ON audit(company_id, id);
