-- Action item runs (patch generation + checks)
CREATE TABLE IF NOT EXISTS action_item_runs (
  id TEXT PRIMARY KEY,
  action_item_id TEXT NOT NULL REFERENCES action_items(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',  -- 'queued', 'running', 'ready', 'failed', 'applied'
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  base_manifest_hash TEXT,
  summary TEXT,
  report TEXT,
  patch TEXT,
  checks TEXT,  -- JSON array
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_action_item_runs_item ON action_item_runs(action_item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_item_runs_workspace ON action_item_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_action_item_runs_status ON action_item_runs(status, created_at DESC);
