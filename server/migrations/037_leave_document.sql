-- A supporting document (usually medical) attached to a leave request.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS document_id INTEGER REFERENCES documents(id);
