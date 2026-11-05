-- Which grades each designation may have (Organization → Designations → Grades, or the
-- designation and grade sheet). A designation with none listed accepts any grade.
CREATE TABLE IF NOT EXISTS designation_grades (
  company_id INTEGER NOT NULL REFERENCES companies(id),
  designation_id INTEGER NOT NULL REFERENCES designations(id) ON DELETE CASCADE,
  grade_id INTEGER NOT NULL REFERENCES grades(id) ON DELETE CASCADE,
  PRIMARY KEY (designation_id, grade_id)
);
CREATE INDEX IF NOT EXISTS designation_grades_company ON designation_grades(company_id);
-- Grade names are unique in a company, ignoring case, like designations already are.
CREATE UNIQUE INDEX IF NOT EXISTS grades_name ON grades(company_id, lower(name));
