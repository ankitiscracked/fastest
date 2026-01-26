-- Provider credentials for infrastructure (Railway, Cloudflare, etc.)
CREATE TABLE IF NOT EXISTS provider_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  api_token TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_creds_user_provider ON provider_credentials(user_id, provider);
CREATE INDEX IF NOT EXISTS idx_provider_creds_user ON provider_credentials(user_id);

-- Infrastructure resources (provisioned databases, deployed apps, etc.)
CREATE TABLE IF NOT EXISTS infrastructure_resources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_resource_id TEXT,
  name TEXT NOT NULL,
  connection_info TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_infra_resources_project ON infrastructure_resources(project_id);
CREATE INDEX IF NOT EXISTS idx_infra_resources_project_type ON infrastructure_resources(project_id, type);
