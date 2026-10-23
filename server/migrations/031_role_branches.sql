-- A custom role may be limited to some branches (JSON list of branch ids; empty = all).
ALTER TABLE custom_roles ADD COLUMN IF NOT EXISTS branch_ids TEXT NOT NULL DEFAULT '[]';
