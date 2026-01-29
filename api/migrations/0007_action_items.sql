-- Action items (findings + queued fixes)
CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'refactoring', 'security', 'test_coverage', 'build_failure'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info', 'warning', 'critical'
  title TEXT NOT NULL,
  description TEXT,
  affected_files TEXT,  -- JSON array
  suggested_prompt TEXT,
  metadata TEXT,  -- JSON object
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'running', 'ready', 'applied', 'dismissed'
  source TEXT NOT NULL DEFAULT 'analysis',  -- 'analysis', 'import', 'manual'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_action_items_workspace ON action_items(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_items_project ON action_items(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(workspace_id, status);
