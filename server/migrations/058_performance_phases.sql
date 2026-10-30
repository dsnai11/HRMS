-- Appraisal phases, core competencies and goal change history.
--  - A review cycle is a mid-year check-in (comments, ratings optional) or a year-end evaluation.
--  - Core competencies are set by HR; each review rates them, self then manager.
--  - Every change to a goal after it is set is recorded: who, when, which field, before and after.
ALTER TABLE review_cycles ADD COLUMN IF NOT EXISTS phase TEXT NOT NULL DEFAULT 'year_end'
  CHECK (phase IN ('mid_year','year_end'));
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_self_rating_check;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_manager_rating_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_self_rating_check CHECK (self_rating IS NULL OR self_rating BETWEEN 1 AND 5);
ALTER TABLE reviews ADD CONSTRAINT reviews_manager_rating_check CHECK (manager_rating IS NULL OR manager_rating BETWEEN 1 AND 5);

CREATE TABLE IF NOT EXISTS competencies (
  id SERIAL PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id),
  name TEXT NOT NULL, description TEXT, sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS competencies_name ON competencies(company_id, lower(name));

CREATE TABLE IF NOT EXISTS review_competencies (
  id SERIAL PRIMARY KEY, review_id INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  competency_id INTEGER NOT NULL REFERENCES competencies(id),
  self_rating INTEGER CHECK (self_rating BETWEEN 1 AND 5),
  manager_rating INTEGER CHECK (manager_rating BETWEEN 1 AND 5), manager_comment TEXT,
  UNIQUE (review_id, competency_id)
);

CREATE TABLE IF NOT EXISTS goal_changes (
  id SERIAL PRIMARY KEY, goal_id INTEGER NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
  field TEXT NOT NULL, old_value TEXT, new_value TEXT,
  changed_by INTEGER NOT NULL REFERENCES users(id), changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS goal_changes_goal ON goal_changes(goal_id, id);
