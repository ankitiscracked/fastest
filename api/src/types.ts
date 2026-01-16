// Re-export shared types for convenience
export * from '@fastest/shared';

// API-specific types

export interface AuthContext {
  userId: string;
  email: string;
}

export interface DbUser {
  id: string;
  email: string;
  created_at: string;
}

export interface DbProject {
  id: string;
  owner_user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_snapshot_id: string | null;
}

export interface DbSnapshot {
  id: string;
  project_id: string;
  manifest_hash: string;
  parent_snapshot_id: string | null;
  source: string;
  created_at: string;
}

export interface DbWorkspace {
  id: string;
  project_id: string;
  name: string;
  machine_id: string | null;
  base_snapshot_id: string | null;
  local_path: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface DbDriftReport {
  id: string;
  workspace_id: string;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  bytes_changed: number;
  summary: string | null;
  reported_at: string;
}

export interface DbActivityEvent {
  id: string;
  project_id: string;
  workspace_id: string | null;
  actor: string;
  type: string;
  snapshot_id: string | null;
  message: string | null;
  created_at: string;
}
