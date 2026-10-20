-- Investment declarations (feed TDS), payroll budgets.
ALTER TABLE companies ADD COLUMN IF NOT EXISTS declaration_open INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS tax_declarations (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), tax_year INTEGER NOT NULL,
  regime TEXT NOT NULL DEFAULT 'new' CHECK (regime IN ('new','old')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','verified','changes_requested')),
  submitted_at TEXT, reviewed_by INTEGER REFERENCES users(id), reviewed_at TEXT, review_note TEXT,
  created_at TEXT NOT NULL, UNIQUE (user_id, tax_year)
);
CREATE TABLE IF NOT EXISTS tax_declaration_items (
  id SERIAL PRIMARY KEY, declaration_id INTEGER NOT NULL REFERENCES tax_declarations(id) ON DELETE CASCADE,
  section TEXT NOT NULL, description TEXT, amount DOUBLE PRECISION NOT NULL,
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_amount DOUBLE PRECISION, note TEXT
);
CREATE INDEX IF NOT EXISTS tax_items_decl ON tax_declaration_items(declaration_id);

CREATE TABLE IF NOT EXISTS payroll_budgets (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  dimension TEXT NOT NULL CHECK (dimension IN ('department','cost_centre','business_unit','branch')),
  ref_id INTEGER NOT NULL, month TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
  UNIQUE (company_id, dimension, ref_id, month)
);
