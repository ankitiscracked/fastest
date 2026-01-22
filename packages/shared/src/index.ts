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
  main_workspace_id: string | null;
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
  main_workspace_id: string;

  // Comparison metadata
  compared_at: string;
  workspace_snapshot_id: string | null;  // null = current files
  main_snapshot_id: string | null;       // null = current files

  // File categorization
  main_only: string[];           // Files in main but not workspace
  workspace_only: string[];      // Files in workspace but not main
  both_same: string[];           // Same content in both
  both_different: string[];      // Different content (potential conflicts)

  // Computed
  total_drift_files: number;     // main_only + both_different
  has_overlaps: boolean;         // both_different.length > 0

  // Legacy fields (backward compatibility)
  files_added: number;
  files_modified: number;
  files_deleted: number;
  bytes_changed: number;
  summary: string | null;
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
  DriftComparison,
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
  compareDrift,
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

// Drift comparison request/response (for sync with main)
export interface GetDriftRequest {
  workspace_id: string;
  use_snapshots?: boolean;  // true = compare snapshots, false = compare current files (default)
}

export interface GetDriftResponse {
  drift: DriftReport | null;  // null if no main workspace set or workspace is main
  is_main_workspace: boolean;
}

// AI-generated drift analysis
export interface DriftAnalysis {
  // Human-readable summaries
  main_changes_summary: string;       // "Added rate limiting, fixed auth bug"
  workspace_changes_summary: string;  // "Added retry logic, custom errors"

  // Risk assessment
  risk_level: 'low' | 'medium' | 'high';
  risk_explanation: string;

  // Recommendation
  can_auto_sync: boolean;
  recommendation: string;             // "Safe to sync automatically"

  // Metadata
  analyzed_at: string;
}

export interface AnalyzeDriftRequest {
  workspace_id: string;
}

export interface AnalyzeDriftResponse {
  analysis: DriftAnalysis | null;
  error?: string;
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

// Sync types for workspace synchronization

export interface SyncPreview {
  id: string;
  workspace_id: string;
  drift_report_id: string;

  // Actions that need no user input
  auto_actions: AutoAction[];

  // Decisions user must make
  decisions_needed: ConflictDecision[];

  // Summary
  files_to_update: number;
  files_to_add: number;
  files_unchanged: number;

  // AI summary of what will happen
  summary: string;

  // Timestamps
  created_at: string;
  expires_at: string;
}

export interface AutoAction {
  path: string;
  action: 'copy_from_main' | 'keep_workspace' | 'ai_combined';
  description: string;
  // For ai_combined, the combined content
  combined_content?: string;
}

export interface ConflictDecision {
  path: string;

  // Semantic descriptions (not code!)
  main_intent: string;
  workspace_intent: string;
  conflict_reason: string;

  // Options for user
  options: DecisionOption[];

  // AI recommendation
  recommended_option_id?: string;
}

export interface DecisionOption {
  id: string;
  label: string;
  description?: string;

  // The resulting content if this option is chosen
  resulting_content: string;

  // If custom input allowed
  allows_custom_input?: boolean;
  custom_input_label?: string;
}

// API request/response types for sync

export interface PrepareSyncRequest {
  workspace_id: string;
}

export interface PrepareSyncResponse {
  preview: SyncPreview;
}

export interface ExecuteSyncRequest {
  preview_id: string;
  decisions: Record<string, string>;  // path → selected option_id
  custom_values?: Record<string, string>; // path → custom value if applicable
  create_snapshot_before?: boolean;
  create_snapshot_after?: boolean;
}

export interface ExecuteSyncResponse {
  success: boolean;
  files_updated: number;
  files_added: number;
  errors: string[];
  snapshot_before_id?: string;
  snapshot_after_id?: string;
}

// Action Items - cross-workspace insights from background agents

export type ActionItemType = 'drift' | 'refactoring' | 'security' | 'test_coverage';
export type ActionItemSeverity = 'info' | 'warning' | 'critical';

export interface ActionItem {
  id: string;
  type: ActionItemType;
  severity: ActionItemSeverity;

  // Context
  workspace_id: string;
  workspace_name: string;
  project_id: string;
  project_name: string;

  // Display
  title: string;
  description?: string;
  icon?: string;

  // Action
  action_label: string;
  action_type: 'navigate' | 'prompt' | 'sync';
  action_data?: Record<string, unknown>;

  // Metadata
  created_at: string;
  dismissed_at?: string;
}

export interface ListActionItemsResponse {
  items: ActionItem[];
}

// Project Docs - documentation files across workspaces

export interface DocFile {
  path: string;
  workspace_id: string;
  workspace_name: string;
  size: number;
  hash: string;
}

export interface WorkspaceDocs {
  workspace_id: string;
  workspace_name: string;
  files: DocFile[];
}

export interface ListProjectDocsResponse {
  workspaces: WorkspaceDocs[];
  total_files: number;
}

export interface GetDocContentResponse {
  content: string;
  path: string;
  workspace_id: string;
  workspace_name: string;
  size: number;
}

// Doc file patterns
export const DOC_FILE_PATTERNS = [
  /\.md$/i,
  /\.txt$/i,
  /\.mdx$/i,
  /^readme$/i,
  /^changelog$/i,
  /^license$/i,
  /^contributing$/i,
  /^todo$/i,
  /^notes$/i,
];
