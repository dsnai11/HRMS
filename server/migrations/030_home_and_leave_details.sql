-- Optional (restricted) holidays: listed for people to choose, but not days off for
-- everyone, so leave, attendance and payroll keep counting them as working days.
ALTER TABLE holidays ADD COLUMN IF NOT EXISTS optional INTEGER NOT NULL DEFAULT 0;

-- Extra details on a leave request, as the old portal asked for them.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS address_on_leave TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS contact_on_leave TEXT;
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS handover_to INTEGER REFERENCES users(id);
