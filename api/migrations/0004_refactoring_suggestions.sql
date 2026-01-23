-- Refactoring suggestions from background analysis
CREATE TABLE IF NOT EXISTS refactoring_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES snapshots(id),
  type TEXT NOT NULL, -- 'security' | 'duplication' | 'performance' | 'naming' | 'structure'
  severity TEXT NOT NULL DEFAULT 'info', -- 'info' | 'warning' | 'critical'
  title TEXT NOT NULL,
  description TEXT,
  affected_files TEXT, -- JSON array of file paths
  suggested_prompt TEXT, -- Pre-filled prompt to fix the issue
  status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'applied' | 'dismissed'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refactoring_workspace ON refactoring_suggestions(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_refactoring_status ON refactoring_suggestions(workspace_id, status);
