-- Extra profile sections: personal, medical, nominees and insurance (JSON each).
CREATE TABLE IF NOT EXISTS employee_details (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  personal TEXT NOT NULL DEFAULT '{}', medical TEXT NOT NULL DEFAULT '{}',
  nominees TEXT NOT NULL DEFAULT '[]', insurance TEXT NOT NULL DEFAULT '[]',
  updated_by INTEGER REFERENCES users(id), updated_at TEXT
);
