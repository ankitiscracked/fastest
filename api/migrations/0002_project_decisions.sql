CREATE TABLE IF NOT EXISTS project_decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  decision TEXT NOT NULL,
  rationale TEXT,
  category TEXT,
  decided_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_project_decisions_project ON project_decisions(project_id, decided_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_decisions_unique ON project_decisions(project_id, decision);
