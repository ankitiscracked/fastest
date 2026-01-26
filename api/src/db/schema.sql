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
  last_snapshot_id TEXT,
  main_workspace_id TEXT REFERENCES workspaces(id)
);

CREATE INDEX IF NOT EXISTS idx_projects_owner ON projects(owner_user_id, updated_at DESC);

-- Snapshots
CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  manifest_hash TEXT NOT NULL,
  parent_snapshot_id TEXT,
  source TEXT NOT NULL DEFAULT 'cli',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_snapshots_project ON snapshots(project_id, created_at DESC);

-- Workspaces
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  machine_id TEXT,
  fork_snapshot_id TEXT REFERENCES snapshots(id),
  current_snapshot_id TEXT REFERENCES snapshots(id),
  current_manifest_hash TEXT,
  local_path TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Version for optimistic locking - prevents concurrent sync race conditions
  version INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_workspaces_project ON workspaces(project_id, created_at DESC);

-- Migration: Add version column to existing workspaces (run once)
-- ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Drift reports (comparison between workspace and main)
CREATE TABLE IF NOT EXISTS drift_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  source_workspace_id TEXT REFERENCES workspaces(id),

  -- What we compared
  reported_at TEXT NOT NULL DEFAULT (datetime('now')),
  workspace_snapshot_id TEXT REFERENCES snapshots(id),  -- null = current files
  source_snapshot_id TEXT REFERENCES snapshots(id),       -- null = current files

  -- File categorization (stored as JSON arrays)
  source_only TEXT NOT NULL DEFAULT '[]',         -- JSON array of file paths
  workspace_only TEXT NOT NULL DEFAULT '[]',      -- JSON array of file paths
  both_same TEXT NOT NULL DEFAULT '[]',           -- JSON array of file paths
  both_different TEXT NOT NULL DEFAULT '[]',      -- JSON array of file paths

  -- Legacy fields (kept for backward compatibility)
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_deleted INTEGER DEFAULT 0,
  bytes_changed INTEGER DEFAULT 0,
  summary TEXT
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

-- Project environment variables
CREATE TABLE IF NOT EXISTS project_env_vars (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,  -- Encrypted for secrets
  is_secret INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_env_vars_project_key ON project_env_vars(project_id, key);
CREATE INDEX IF NOT EXISTS idx_env_vars_project ON project_env_vars(project_id);

-- User API keys for model providers
CREATE TABLE IF NOT EXISTS user_api_keys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,  -- 'anthropic', 'openai', 'google', etc.
  key_name TEXT NOT NULL,
  key_value TEXT NOT NULL,  -- Encrypted
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_user_provider ON user_api_keys(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON user_api_keys(user_id);

-- Refactoring suggestions from background analysis
CREATE TABLE IF NOT EXISTS refactoring_suggestions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id TEXT REFERENCES snapshots(id),
  type TEXT NOT NULL,  -- 'security', 'duplication', 'performance', 'naming', 'structure'
  severity TEXT NOT NULL DEFAULT 'info',  -- 'info', 'warning', 'critical'
  title TEXT NOT NULL,
  description TEXT,
  affected_files TEXT,  -- JSON array
  suggested_prompt TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'applied', 'dismissed'
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_refactoring_workspace ON refactoring_suggestions(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_refactoring_status ON refactoring_suggestions(workspace_id, status);

-- Provider credentials for infrastructure (Railway, Cloudflare, etc.)
CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,  -- 'railway', 'cloudflare'
  api_token TEXT NOT NULL,  -- Encrypted
  metadata TEXT,  -- JSON: account_id, team_id, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_creds_user_provider ON provider_credentials(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_provider_creds_user ON provider_credentials(user_id);

-- Infrastructure resources (provisioned databases, deployed apps, etc.)
CREATE TABLE IF NOT EXISTS infrastructure_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'compute', 'compute:edge', 'database:postgres', 'database:redis', 'storage:blob'
  provider TEXT NOT NULL,  -- 'railway', 'cloudflare'
  provider_resource_id TEXT,  -- External ID in provider system
  name TEXT NOT NULL,
  connection_info TEXT,  -- Encrypted JSON: { url, host, port, username, password }
  status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'provisioning', 'ready', 'error', 'deleted'
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_infra_resources_project ON infrastructure_resources(project_id);
CREATE INDEX IF NOT EXISTS idx_infra_resources_project_type ON infrastructure_resources(project_id, type);
