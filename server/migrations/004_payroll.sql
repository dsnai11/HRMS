-- Payroll: settings, salary structure, salaries, adjustments, runs and payslips,
-- professional-tax slabs, opening balances, and encrypted personal data.
CREATE TABLE IF NOT EXISTS payroll_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id), config TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS salary_components (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  code TEXT NOT NULL, name TEXT NOT NULL,
  calc TEXT NOT NULL CHECK (calc IN ('percent_of_gross','percent_of_basic','fixed','balance')),
  value DOUBLE PRECISION NOT NULL DEFAULT 0, is_basic INTEGER NOT NULL DEFAULT 0,
  taxable INTEGER NOT NULL DEFAULT 1, esi_wage INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS salary_components_code ON salary_components(company_id, upper(code));

CREATE TABLE IF NOT EXISTS employee_salaries (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), effective_from TEXT NOT NULL,
  monthly_gross DOUBLE PRECISION NOT NULL,
  pf_applicable INTEGER NOT NULL DEFAULT 1, esi_applicable INTEGER NOT NULL DEFAULT 0,
  pt_applicable INTEGER NOT NULL DEFAULT 1, eps_eligible INTEGER NOT NULL DEFAULT 1,
  tax_regime TEXT NOT NULL DEFAULT 'new' CHECK (tax_regime IN ('new','old')),
  declared_deductions DOUBLE PRECISION NOT NULL DEFAULT 0, note TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS employee_salaries_effective ON employee_salaries(user_id, effective_from);

-- Each salary keeps its own copy of the lines, so editing the structure later
-- never rewrites past salaries.
CREATE TABLE IF NOT EXISTS employee_salary_lines (
  id SERIAL PRIMARY KEY, salary_id INTEGER NOT NULL REFERENCES employee_salaries(id) ON DELETE CASCADE,
  component_id INTEGER REFERENCES salary_components(id), code TEXT NOT NULL, name TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, is_basic INTEGER NOT NULL, taxable INTEGER NOT NULL, esi_wage INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pt_slabs (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), state TEXT NOT NULL,
  from_amount DOUBLE PRECISION NOT NULL, to_amount DOUBLE PRECISION, amount DOUBLE PRECISION NOT NULL,
  gender TEXT, month INTEGER
);
CREATE INDEX IF NOT EXISTS pt_slabs_state ON pt_slabs(company_id, lower(state));

-- Income and tax already recorded for a tax year before this system was used.
CREATE TABLE IF NOT EXISTS payroll_opening (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), tax_year INTEGER NOT NULL,
  taxable_income DOUBLE PRECISION NOT NULL DEFAULT 0, tds_deducted DOUBLE PRECISION NOT NULL DEFAULT 0,
  pt_deducted DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_opening_year ON payroll_opening(user_id, tax_year);

CREATE TABLE IF NOT EXISTS payroll_adjustments (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id), month TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('earning','deduction')), name TEXT NOT NULL,
  amount DOUBLE PRECISION NOT NULL, taxable INTEGER NOT NULL DEFAULT 1, note TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS payroll_adjustments_month ON payroll_adjustments(company_id, month);

CREATE TABLE IF NOT EXISTS payroll_runs (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), month TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid')),
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id), approved_at TEXT, paid_on TEXT,
  skipped TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_runs_month ON payroll_runs(company_id, month);

CREATE TABLE IF NOT EXISTS payroll_items (
  id SERIAL PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  company_id INTEGER NOT NULL REFERENCES companies(id), user_id INTEGER NOT NULL REFERENCES users(id),
  gross DOUBLE PRECISION NOT NULL, deductions DOUBLE PRECISION NOT NULL, net DOUBLE PRECISION NOT NULL,
  employer_cost DOUBLE PRECISION NOT NULL, paid_days DOUBLE PRECISION NOT NULL, lop_days DOUBLE PRECISION NOT NULL,
  taxable_earnings DOUBLE PRECISION NOT NULL, tds DOUBLE PRECISION NOT NULL DEFAULT 0,
  pt DOUBLE PRECISION NOT NULL DEFAULT 0, warnings TEXT NOT NULL DEFAULT '[]', data TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS payroll_items_person ON payroll_items(run_id, user_id);
CREATE INDEX IF NOT EXISTS payroll_items_user ON payroll_items(user_id);

-- Bank, PAN, UAN and ESI numbers, encrypted by the application (see crypto-store.js).
CREATE TABLE IF NOT EXISTS employee_private (
  user_id INTEGER PRIMARY KEY REFERENCES users(id), company_id INTEGER NOT NULL REFERENCES companies(id),
  data TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at TEXT NOT NULL
);
