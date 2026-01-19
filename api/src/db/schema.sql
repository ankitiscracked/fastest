-- Fastest D1 Schema

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  picture TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Auth codes (for web magic link flow)
CREATE TABLE IF NOT EXISTS auth_codes (
  id TEXT PRIMARY KEY,
  user_id TEXT,
  email TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Device codes (for CLI OAuth device flow - RFC 8628)
CREATE TABLE IF NOT EXISTS device_codes (
  id TEXT PRIMARY KEY,
  device_code TEXT UNIQUE NOT NULL,      -- secret, used by CLI to poll
  user_code TEXT UNIQUE NOT NULL,        -- short code user enters (e.g., ABCD-1234)
  user_id TEXT REFERENCES users(id),     -- set after user authenticates
  status TEXT NOT NULL DEFAULT 'pending', -- pending, authorized, expired, denied
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_codes_device_code ON device_codes(device_code);
CREATE INDEX IF NOT EXISTS idx_device_codes_user_code ON device_codes(user_code);

-- Sessions
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT UNIQUE NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_snapshot_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id, updated_at DESC);

-- Snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  manifest_hash TEXT NOT NULL,
  parent_snapshot_id TEXT,
  source TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(project_id, manifest_hash)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, created_at DESC);

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  machine_id TEXT,
  base_snapshot_id TEXT REFERENCES snapshots(id),
  local_path TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id, created_at DESC);

-- Drift reports
CREATE TABLE IF NOT EXISTS drift_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_deleted INTEGER DEFAULT 0,
  bytes_changed INTEGER DEFAULT 0,
  summary TEXT,
  reported_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_drift_reports_workspace ON drift_reports(workspace_id, reported_at DESC);

-- Activity events
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  snapshot_id TEXT,
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_project ON activity_events(project_id, created_at DESC);

-- Conversations (chat sessions within a workspace)
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT,  -- auto-generated from first message
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_conversations_workspace ON conversations(workspace_id, updated_at DESC);

-- Jobs (agent execution queue) - DEPRECATED, keeping for migration
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  project_id TEXT NOT NULL REFERENCES projects(id),
  prompt TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, running, completed, failed, cancelled
  output_snapshot_id TEXT REFERENCES snapshots(id),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_project ON jobs(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status, created_at ASC);
