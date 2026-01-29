ALTER TABLE build_suggestions RENAME TO next_steps;
DROP INDEX IF EXISTS idx_suggestions_project;
DROP INDEX IF EXISTS idx_suggestions_priority;
CREATE INDEX IF NOT EXISTS idx_next_steps_project ON next_steps(project_id, status);
CREATE INDEX IF NOT EXISTS idx_next_steps_priority ON next_steps(project_id, priority);
