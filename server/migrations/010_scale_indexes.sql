-- Indexes for the busiest lookups.
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS shifts_open_by_workplace ON shifts(workplace_id) WHERE out_at IS NULL;
CREATE INDEX IF NOT EXISTS leave_days_day ON leave_days(day);
CREATE INDEX IF NOT EXISTS audit_actor ON audit(actor_id, id);
CREATE INDEX IF NOT EXISTS candidates_email ON candidates(company_id, lower(email));
CREATE INDEX IF NOT EXISTS employee_salary_lines_salary ON employee_salary_lines(salary_id);
