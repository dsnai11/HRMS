-- Lookups that grow with headcount (about 5,000 people, 10,000 punches a day).
CREATE INDEX IF NOT EXISTS punch_events_created ON punch_events(created_at);
CREATE INDEX IF NOT EXISTS users_branch ON users(company_id, branch_id);
CREATE INDEX IF NOT EXISTS training_records_training ON training_records(training_id);
CREATE INDEX IF NOT EXISTS regularizations_user ON regularizations(user_id, date);
CREATE INDEX IF NOT EXISTS punch_photos_created ON punch_photos(created_at);
