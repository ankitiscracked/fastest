-- Deployment settings per workspace
CREATE TABLE IF NOT EXISTS deployment_settings (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  auto_deploy INTEGER NOT NULL DEFAULT 0,
  runtime_override TEXT,
  build_command TEXT,
  start_command TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Deployments history
CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES snapshots(id) ON DELETE SET NULL,
  status TEXT NOT NULL, -- 'deploying' | 'success' | 'failed'
  trigger TEXT NOT NULL, -- 'manual' | 'chat' | 'auto'
  url TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_deployments_workspace ON deployments(workspace_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status, started_at DESC);
