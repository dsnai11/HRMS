-- Branch budgets for the financial year (April to March, named by the year it starts in).
-- Branches sit in zones and regions; one branch can be marked as the head office.
ALTER TABLE branches ADD COLUMN IF NOT EXISTS zone TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS region TEXT;
ALTER TABLE branches ADD COLUMN IF NOT EXISTS head_office INTEGER NOT NULL DEFAULT 0;

-- The lines a budget is made of. Actual spending comes from payroll (employer cost of the
-- people in the branch), approved reimbursement claims, or spending entered by hand.
CREATE TABLE IF NOT EXISTS budget_heads (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, code TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('payroll','claims','manual')),
  sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS budget_heads_code ON budget_heads(company_id, lower(code));

-- One row per company and year: draft → submitted → approved (maker and checker differ).
CREATE TABLE IF NOT EXISTS budget_years (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), fy INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','submitted','approved')),
  submitted_by INTEGER REFERENCES users(id), submitted_at TEXT,
  approved_by INTEGER REFERENCES users(id), approved_at TEXT, note TEXT,
  UNIQUE (company_id, fy)
);

-- Budget amounts, whole rupees, by branch, head and month.
CREATE TABLE IF NOT EXISTS budget_lines (
  company_id INTEGER NOT NULL REFERENCES companies(id), fy INTEGER NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id), head_id INTEGER NOT NULL REFERENCES budget_heads(id),
  month TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (company_id, branch_id, head_id, month)
);
CREATE INDEX IF NOT EXISTS budget_lines_year ON budget_lines(company_id, fy);

-- Manpower plan: sanctioned posts by branch and designation.
CREATE TABLE IF NOT EXISTS budget_posts (
  company_id INTEGER NOT NULL REFERENCES companies(id), fy INTEGER NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id), designation_id INTEGER NOT NULL REFERENCES designations(id),
  sanctioned INTEGER NOT NULL,
  PRIMARY KEY (company_id, fy, branch_id, designation_id)
);

-- Spending for heads that have no source in the HRMS (training, recruitment, welfare…).
CREATE TABLE IF NOT EXISTS budget_spend (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id), head_id INTEGER NOT NULL REFERENCES budget_heads(id),
  spent_on TEXT NOT NULL, amount DOUBLE PRECISION NOT NULL, description TEXT NOT NULL, reference TEXT,
  created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_spend_branch ON budget_spend(company_id, branch_id, spent_on);

-- Every change to an approved budget, with the reason.
CREATE TABLE IF NOT EXISTS budget_revisions (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), fy INTEGER NOT NULL,
  branch_id INTEGER NOT NULL REFERENCES branches(id), head_id INTEGER NOT NULL REFERENCES budget_heads(id),
  old_amount DOUBLE PRECISION NOT NULL, new_amount DOUBLE PRECISION NOT NULL, reason TEXT NOT NULL,
  revised_by INTEGER REFERENCES users(id), revised_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_revisions_year ON budget_revisions(company_id, fy);
