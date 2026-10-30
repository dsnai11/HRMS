-- Bill-backed salary components (fuel, telephone, books and periodicals, uniform): paid every
-- month as fixed pay, taxable except for the part backed by bills that payroll has verified in
-- the same tax year, up to a year of that component. TDS uses the verified amount each month.
ALTER TABLE salary_components ADD COLUMN IF NOT EXISTS bill_based INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS salary_bills (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  component_id INTEGER NOT NULL REFERENCES salary_components(id),
  tax_year INTEGER NOT NULL, bill_date TEXT NOT NULL, bill_no TEXT,
  amount DOUBLE PRECISION NOT NULL, description TEXT NOT NULL,
  document_id INTEGER REFERENCES documents(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected','cancelled')),
  verified_amount DOUBLE PRECISION, verified_by INTEGER REFERENCES users(id), verified_at TEXT, note TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS salary_bills_user ON salary_bills(user_id, tax_year);
CREATE INDEX IF NOT EXISTS salary_bills_company ON salary_bills(company_id, status);
