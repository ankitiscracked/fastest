-- Add project brief fields
ALTER TABLE projects ADD COLUMN intent TEXT;
ALTER TABLE projects ADD COLUMN brief TEXT;

-- Build suggestions for product guidance
CREATE TABLE IF NOT EXISTS build_suggestions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  rationale TEXT,
  category TEXT NOT NULL,  -- 'feature', 'validation', 'launch', 'technical', 'user_research'
  priority INTEGER DEFAULT 2,
  effort TEXT,  -- 'small', 'medium', 'large'
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'started', 'completed', 'dismissed'
  model TEXT,
  generated_at TEXT NOT NULL DEFAULT (datetime('now')),
  acted_on_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggestions_project ON build_suggestions(project_id, status);
CREATE INDEX IF NOT EXISTS idx_suggestions_priority ON build_suggestions(project_id, priority);
