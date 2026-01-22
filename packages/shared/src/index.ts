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
  content_hash: string;
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

export interface Conversation {
  id: string;
  workspace_id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
}

// Extended conversation with workspace/project info for list views
export interface ConversationWithContext extends Conversation {
  workspace_name: string;
  project_id: string;
  project_name: string;
  last_message_preview?: string;
  message_count?: number;
}

// Timeline types for tracking file changes in a session
export interface FileChange {
  path: string;
  change: 'added' | 'modified' | 'deleted';
  additions?: number;
  deletions?: number;
}

export interface TimelineItem {
  id: string;
  messageId: string;
  timestamp: string;
  summary: string | null;  // AI-generated narrative summary (async)
  summaryStatus: 'pending' | 'generating' | 'completed' | 'failed';
  files: FileChange[];
  manifestHash: string;
  previousManifestHash?: string;
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
export {
  IgnoreMatcher,
  DEFAULT_PATTERNS,
  sha256,
  generateFromFiles,
  toJSON,
  fromJSON,
  hashManifest,
  diff,
  totalSize,
  fileCount,
  getFile,
  getBlobHashes,
  getNewBlobHashes,
  empty,
} from './manifest';

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
  content_hash: string;
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

// Conversation API types

export interface CreateConversationRequest {
  workspace_id: string;
  title?: string;
}

export interface CreateConversationResponse {
  conversation: Conversation;
}

export interface GetConversationResponse {
  conversation: ConversationWithContext;
}

export interface ListConversationsResponse {
  conversations: ConversationWithContext[];
}

// Job API types (DEPRECATED)

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

// Environment variables

export interface ProjectEnvVar {
  id: string;
  project_id: string;
  key: string;
  value: string;  // Masked for secrets in API responses
  is_secret: boolean;
  created_at: string;
  updated_at: string;
}

export interface SetEnvVarRequest {
  key: string;
  value: string;
  is_secret?: boolean;
}

export interface SetEnvVarsRequest {
  variables: SetEnvVarRequest[];
}

export interface ListEnvVarsResponse {
  variables: ProjectEnvVar[];
}

// Deployment logs

export interface DeploymentLogEntry {
  timestamp: string;
  step: 'install' | 'build' | 'deploy';
  stream: 'stdout' | 'stderr';
  content: string;
}

export interface DeploymentLog {
  deploymentId: string;
  entries: DeploymentLogEntry[];
  startedAt: string;
  completedAt?: string;
}

// User API keys for model providers

export type ApiKeyProvider = 'anthropic' | 'openai' | 'google' | 'azure' | 'aws' | 'groq' | 'mistral';

export interface UserApiKey {
  id: string;
  user_id: string;
  provider: ApiKeyProvider;
  key_name: string;  // e.g., 'ANTHROPIC_API_KEY'
  key_value: string; // Masked in API responses (shows last 4 chars)
  created_at: string;
  updated_at: string;
}

export interface SetApiKeyRequest {
  provider: ApiKeyProvider;
  key_value: string;
}

export interface ListApiKeysResponse {
  api_keys: UserApiKey[];
}

// Provider config with env var names
export const API_KEY_PROVIDERS: Record<ApiKeyProvider, { name: string; keyName: string; description: string }> = {
  anthropic: { name: 'Anthropic', keyName: 'ANTHROPIC_API_KEY', description: 'Claude models' },
  openai: { name: 'OpenAI', keyName: 'OPENAI_API_KEY', description: 'GPT models' },
  google: { name: 'Google', keyName: 'GOOGLE_GENERATIVE_AI_API_KEY', description: 'Gemini models' },
  azure: { name: 'Azure OpenAI', keyName: 'AZURE_OPENAI_API_KEY', description: 'Azure-hosted OpenAI' },
  aws: { name: 'AWS Bedrock', keyName: 'AWS_ACCESS_KEY_ID', description: 'Bedrock models' },
  groq: { name: 'Groq', keyName: 'GROQ_API_KEY', description: 'Groq-hosted models' },
  mistral: { name: 'Mistral', keyName: 'MISTRAL_API_KEY', description: 'Mistral models' },
};
