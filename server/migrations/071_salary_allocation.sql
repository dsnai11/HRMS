-- Salary by branch: each person's salary shared across the branches they cover, in
-- proportion to each branch's AUM (the "Branch wise salary distribution" sheet), worked out
-- by the HRMS every month (see server/salary-allocation.js).

-- AUM (loan book) of each branch for a month, from the loan system feed or the budget sheet.
CREATE TABLE IF NOT EXISTS branch_aum (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  month TEXT NOT NULL, aum DOUBLE PRECISION NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('feed','sheet')),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, branch_id, month)
);

-- Branches a person covers that their reporting line does not show (for example a credit or
-- legal manager with no team), from the budget sheet. Kept only while the person stays in the
-- branch they were in when it was recorded: a transfer drops it by itself.
CREATE TABLE IF NOT EXISTS staff_branch_coverage (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  home_branch_id INTEGER REFERENCES branches(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, branch_id)
);

-- One calculation per company and month, and its result by person and branch.
CREATE TABLE IF NOT EXISTS salary_allocation_runs (
  company_id INTEGER NOT NULL REFERENCES companies(id), month TEXT NOT NULL,
  salary_source TEXT NOT NULL CHECK (salary_source IN ('payroll','salary')),
  total DOUBLE PRECISION NOT NULL, people INTEGER NOT NULL,
  issues TEXT NOT NULL DEFAULT '[]', ran_at TEXT NOT NULL,
  PRIMARY KEY (company_id, month)
);
CREATE TABLE IF NOT EXISTS salary_allocations (
  company_id INTEGER NOT NULL REFERENCES companies(id), month TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  branch_id INTEGER NOT NULL REFERENCES branches(id),
  basis TEXT NOT NULL CHECK (basis IN ('own','aum','equal')),
  share DOUBLE PRECISION NOT NULL, amount DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (company_id, month, user_id, branch_id)
);
CREATE INDEX IF NOT EXISTS salary_allocations_branch ON salary_allocations(company_id, month, branch_id);
