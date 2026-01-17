// Core primitives

export interface User {
  id: string;
  email: string;
  created_at: string;
}

export interface Project {
  id: string;
  owner_user_id: string;
  name: string;
  created_at: string;
  updated_at: string;
  last_snapshot_id: string | null;
}

export interface Snapshot {
  id: string;
  project_id: string;
  manifest_hash: string;
  parent_snapshot_id: string | null;
  source: 'cli' | 'web' | 'import' | 'system';
  created_at: string;
}

export interface Workspace {
  id: string;
  project_id: string;
  name: string;
  machine_id: string | null;
  base_snapshot_id: string | null;
  local_path: string | null;
  last_seen_at: string | null;
  created_at: string;
}

export interface DriftReport {
  id: string;
  workspace_id: string;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  bytes_changed: number;
  summary: string | null;
  reported_at: string;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Job {
  id: string;
  workspace_id: string;
  project_id: string;
  prompt: string;
  status: JobStatus;
  output_snapshot_id: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface ActivityEvent {
  id: string;
  project_id: string;
  workspace_id: string | null;
  actor: 'cli' | 'web' | 'system';
  type: 'project.created' | 'snapshot.pushed' | 'snapshot.pulled' | 'workspace.created' | 'drift.reported' | 'merge.completed' | 'git.exported';
  snapshot_id: string | null;
  message: string | null;
  created_at: string;
}

// Manifest module - re-export for convenience
export * as manifest from './manifest';
export type {
  FileEntry,
  Manifest,
  ManifestDiff,
  GenerateOptions,
  FileContent,
} from './manifest';
export { IgnoreMatcher, DEFAULT_PATTERNS } from './manifest';

// Drift types

export interface DriftDetail {
  base_snapshot_id: string;
  files_added: string[];
  files_modified: string[];
  files_deleted: string[];
  total_bytes_changed: number;
}

// API request/response types

export interface CreateProjectRequest {
  name: string;
}

export interface CreateProjectResponse {
  project: Project;
}

export interface CreateWorkspaceRequest {
  name: string;
  base_snapshot_id?: string;
  machine_id?: string;
  local_path?: string;
}

export interface CreateWorkspaceResponse {
  workspace: Workspace;
}

export interface CreateSnapshotRequest {
  manifest_hash: string;
  parent_snapshot_id?: string;
  source: 'cli' | 'web';
}

export interface CreateSnapshotResponse {
  snapshot: Snapshot;
}

export interface BlobExistsRequest {
  hashes: string[];
}

export interface BlobExistsResponse {
  missing: string[];
}

export interface PresignUploadRequest {
  hashes: string[];
}

export interface PresignUploadResponse {
  urls: Record<string, string>;
}

export interface PresignDownloadRequest {
  hashes: string[];
}

export interface PresignDownloadResponse {
  urls: Record<string, string>;
}

export interface ReportDriftRequest {
  files_added: number;
  files_modified: number;
  files_deleted: number;
  bytes_changed: number;
  summary?: string;
}

export interface ReportDriftResponse {
  drift_report: DriftReport;
}

// Job API types

export interface CreateJobRequest {
  workspace_id: string;
  prompt: string;
}

export interface CreateJobResponse {
  job: Job;
}

export interface GetJobResponse {
  job: Job;
}

export interface ListJobsResponse {
  jobs: Job[];
}

export interface CancelJobResponse {
  job: Job;
}

// Error response

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
