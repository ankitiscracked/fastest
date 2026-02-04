import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

// Users
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  name: text('name'),
  picture: text('picture'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// Auth codes (for web magic link flow)
export const authCodes = sqliteTable('auth_codes', {
  id: text('id').primaryKey(),
  userId: text('user_id'),
  email: text('email').notNull(),
  code: text('code').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  used: integer('used').default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// Device codes (for CLI OAuth device flow - RFC 8628)
export const deviceCodes = sqliteTable('device_codes', {
  id: text('id').primaryKey(),
  deviceCode: text('device_code').notNull().unique(),
  userCode: text('user_code').notNull().unique(),
  userId: text('user_id').references(() => users.id),
  status: text('status').notNull().default('pending'),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_device_codes_device_code').on(table.deviceCode),
  index('idx_device_codes_user_code').on(table.userCode),
]);

// Sessions
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull().unique(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
});

// Projects
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  intent: text('intent'),
  brief: text('brief'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
  lastSnapshotId: text('last_snapshot_id'),
  mainWorkspaceId: text('main_workspace_id'),
}, (table) => [
  index('idx_projects_owner').on(table.ownerUserId, table.updatedAt),
]);

// Snapshots
export const snapshots = sqliteTable('snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  workspaceId: text('workspace_id'), // References workspaces.id (no FK to avoid circular ref)
  manifestHash: text('manifest_hash').notNull(),
  parentSnapshotIds: text('parent_snapshot_ids').notNull().default('[]'),
  source: text('source').notNull().default('cli'),
  summary: text('summary'), // LLM-generated description of changes
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_snapshots_project').on(table.projectId, table.createdAt),
  index('idx_snapshots_workspace').on(table.workspaceId, table.createdAt),
]);

// Workspaces
export const workspaces = sqliteTable('workspaces', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  name: text('name').notNull(),
  machineId: text('machine_id'),
  baseSnapshotId: text('base_snapshot_id').references(() => snapshots.id),
  currentSnapshotId: text('current_snapshot_id').references(() => snapshots.id),
  currentManifestHash: text('current_manifest_hash'),
  localPath: text('local_path'),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  // Version for optimistic locking - prevents concurrent sync race conditions
  version: integer('version').notNull().default(1),
  // JSON-serialized merge history: Record<workspaceId, { last_merged_snapshot, merged_at }>
  mergeHistory: text('merge_history'),
}, (table) => [
  index('idx_workspaces_project').on(table.projectId, table.createdAt),
]);

// Drift reports
export const driftReports = sqliteTable('drift_reports', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  sourceWorkspaceId: text('source_workspace_id').references(() => workspaces.id),
  workspaceSnapshotId: text('workspace_snapshot_id').references(() => snapshots.id),
  sourceSnapshotId: text('source_snapshot_id').references(() => snapshots.id),
  sourceOnly: text('source_only').notNull().default('[]'),
  workspaceOnly: text('workspace_only').notNull().default('[]'),
  bothSame: text('both_same').notNull().default('[]'),
  bothDifferent: text('both_different').notNull().default('[]'),
  filesAdded: integer('files_added').default(0),
  filesModified: integer('files_modified').default(0),
  filesDeleted: integer('files_deleted').default(0),
  bytesChanged: integer('bytes_changed').default(0),
  summary: text('summary'),
  reportedAt: text('reported_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_drift_reports_workspace').on(table.workspaceId, table.reportedAt),
]);

// Activity events
export const activityEvents = sqliteTable('activity_events', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id),
  workspaceId: text('workspace_id'),
  actor: text('actor').notNull(),
  type: text('type').notNull(),
  snapshotId: text('snapshot_id'),
  message: text('message'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_events_project').on(table.projectId, table.createdAt),
]);

// Conversations (chat sessions within a workspace)
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  title: text('title'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_conversations_workspace').on(table.workspaceId, table.updatedAt),
]);

// Project environment variables
export const projectEnvVars = sqliteTable('project_env_vars', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  key: text('key').notNull(),
  value: text('value').notNull(),  // Encrypted for secrets
  isSecret: integer('is_secret').notNull().default(0),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_env_vars_project_key').on(table.projectId, table.key),
  index('idx_env_vars_project').on(table.projectId),
]);

// User API keys for model providers
export const userApiKeys = sqliteTable('user_api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),  // e.g., 'anthropic', 'openai', 'google'
  keyName: text('key_name').notNull(),   // e.g., 'ANTHROPIC_API_KEY'
  keyValue: text('key_value').notNull(), // The actual key value
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_api_keys_user_provider').on(table.userId, table.provider),
  index('idx_api_keys_user').on(table.userId),
]);

// Jobs (agent execution queue) - DEPRECATED
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id),
  projectId: text('project_id').notNull().references(() => projects.id),
  prompt: text('prompt').notNull(),
  status: text('status').notNull().default('pending'),
  outputSnapshotId: text('output_snapshot_id').references(() => snapshots.id),
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_jobs_workspace').on(table.workspaceId, table.createdAt),
  index('idx_jobs_project').on(table.projectId, table.createdAt),
  index('idx_jobs_status').on(table.status, table.createdAt),
]);

// Refactoring suggestions from background analysis
export const refactoringSuggestions = sqliteTable('refactoring_suggestions', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  snapshotId: text('snapshot_id').references(() => snapshots.id),
  type: text('type').notNull(), // 'security' | 'duplication' | 'performance' | 'naming' | 'structure' | 'test_coverage'
  severity: text('severity').notNull().default('info'), // 'info' | 'warning' | 'critical'
  title: text('title').notNull(),
  description: text('description'),
  affectedFiles: text('affected_files'), // JSON array of file paths
  suggestedPrompt: text('suggested_prompt'), // Pre-filled prompt to fix the issue
  status: text('status').notNull().default('pending'), // 'pending' | 'applied' | 'dismissed'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_refactoring_workspace').on(table.workspaceId, table.createdAt),
  index('idx_refactoring_status').on(table.workspaceId, table.status),
]);

// Action items from background analysis
export const actionItems = sqliteTable('action_items', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'refactoring' | 'security' | 'test_coverage' | 'build_failure'
  severity: text('severity').notNull().default('info'), // 'info' | 'warning' | 'critical'
  title: text('title').notNull(),
  description: text('description'),
  affectedFiles: text('affected_files'),
  suggestedPrompt: text('suggested_prompt'),
  metadata: text('metadata'),
  status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'ready' | 'applied' | 'dismissed'
  source: text('source').notNull().default('analysis'), // 'analysis' | 'import' | 'manual'
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_action_items_workspace').on(table.workspaceId, table.createdAt),
  index('idx_action_items_project').on(table.projectId, table.createdAt),
  index('idx_action_items_status').on(table.workspaceId, table.status),
]);

// Action item runs (patch generation + checks)
export const actionItemRuns = sqliteTable('action_item_runs', {
  id: text('id').primaryKey(),
  actionItemId: text('action_item_id').notNull().references(() => actionItems.id, { onDelete: 'cascade' }),
  workspaceId: text('workspace_id').notNull().references(() => workspaces.id, { onDelete: 'cascade' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  status: text('status').notNull().default('queued'), // 'queued' | 'running' | 'ready' | 'failed' | 'applied'
  attemptCount: integer('attempt_count').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(3),
  baseManifestHash: text('base_manifest_hash'),
  summary: text('summary'),
  report: text('report'),
  patch: text('patch'),
  checks: text('checks'),
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_action_item_runs_item').on(table.actionItemId, table.createdAt),
  index('idx_action_item_runs_workspace').on(table.workspaceId, table.createdAt),
  index('idx_action_item_runs_status').on(table.status, table.createdAt),
]);

// Build suggestions for product guidance
export const nextSteps = sqliteTable('next_steps', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text('title').notNull(),
  description: text('description'),
  rationale: text('rationale'),
  category: text('category').notNull(), // 'feature' | 'validation' | 'launch' | 'technical' | 'user_research'
  priority: integer('priority').default(2), // 1=high,2=medium,3=low
  effort: text('effort'), // 'small' | 'medium' | 'large'
  status: text('status').notNull().default('pending'), // 'pending' | 'started' | 'completed' | 'dismissed'
  helpfulCount: integer('helpful_count').notNull().default(0),
  notHelpfulCount: integer('not_helpful_count').notNull().default(0),
  model: text('model'),
  generatedAt: text('generated_at').notNull().default(sql`(datetime('now'))`),
  actedOnAt: text('acted_on_at'),
}, (table) => [
  index('idx_next_steps_project').on(table.projectId, table.status),
  index('idx_next_steps_priority').on(table.projectId, table.priority),
]);

// Project decisions extracted from conversations
export const projectDecisions = sqliteTable('project_decisions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conversationId: text('conversation_id').references(() => conversations.id, { onDelete: 'set null' }),
  decision: text('decision').notNull(),
  rationale: text('rationale'),
  category: text('category'),
  decidedAt: text('decided_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_project_decisions_project').on(table.projectId, table.decidedAt),
  uniqueIndex('idx_project_decisions_unique').on(table.projectId, table.decision),
]);

// Atlas concepts derived from snapshots/conversations
export const atlasConcepts = sqliteTable('atlas_concepts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text('name').notNull(),
  layer: text('layer').notNull(), // 'narrative' | 'capability' | 'system' | 'module' | 'code'
  type: text('type'), // optional concept subtype
  description: text('description'),
  sourceSnapshotId: text('source_snapshot_id').references(() => snapshots.id, { onDelete: 'set null' }),
  sourceManifestHash: text('source_manifest_hash'),
  metadata: text('metadata'), // JSON payload
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_concepts_project').on(table.projectId, table.layer),
  uniqueIndex('idx_atlas_concepts_unique').on(table.projectId, table.id),
]);

// Relationships between concepts
export const atlasEdges = sqliteTable('atlas_edges', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  fromConceptId: text('from_concept_id').notNull(),
  toConceptId: text('to_concept_id').notNull(),
  type: text('type').notNull(), // 'contains' | 'depends_on' | 'used_by' | 'relates'
  weight: integer('weight'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_edges_from').on(table.projectId, table.fromConceptId),
  index('idx_atlas_edges_to').on(table.projectId, table.toConceptId),
  index('idx_atlas_edges_type').on(table.projectId, table.type),
]);

// Atlas chunks (code/decision/conversation)
export const atlasChunks = sqliteTable('atlas_chunks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conceptId: text('concept_id'),
  kind: text('kind').notNull(), // 'code' | 'decision' | 'conversation'
  content: text('content').notNull(),
  filePath: text('file_path'),
  symbol: text('symbol'),
  sourceHash: text('source_hash'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_chunks_project').on(table.projectId, table.kind),
  index('idx_atlas_chunks_concept').on(table.projectId, table.conceptId),
]);

// Embeddings for chunks
export const atlasEmbeddings = sqliteTable('atlas_embeddings', {
  id: text('id').primaryKey(),
  chunkId: text('chunk_id').notNull().references(() => atlasChunks.id, { onDelete: 'cascade' }),
  model: text('model').notNull(),
  vector: text('vector').notNull(), // JSON array of floats
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_embeddings_chunk').on(table.chunkId),
]);

// Links between decisions and concepts
export const atlasDecisionLinks = sqliteTable('atlas_decision_links', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  decisionId: text('decision_id').notNull().references(() => projectDecisions.id, { onDelete: 'cascade' }),
  conceptId: text('concept_id').notNull(),
  confidence: integer('confidence'), // 0-100
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_decision_links_project').on(table.projectId, table.decisionId),
  index('idx_atlas_decision_links_concept').on(table.projectId, table.conceptId),
]);

// Stored diagram outputs for Atlas canvas
export const atlasDiagrams = sqliteTable('atlas_diagrams', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  conceptId: text('concept_id'),
  type: text('type').notNull(), // 'flow' | 'dependency' | 'component' | 'sequence'
  data: text('data').notNull(), // JSON
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_atlas_diagrams_project').on(table.projectId, table.createdAt),
  index('idx_atlas_diagrams_concept').on(table.projectId, table.conceptId),
]);

// Provider credentials for infrastructure (Railway, Cloudflare, etc.)
export const providerCredentials = sqliteTable('provider_credentials', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(), // 'railway', 'cloudflare'
  apiToken: text('api_token').notNull(), // Encrypted
  metadata: text('metadata'), // JSON: account_id, team_id, etc.
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_provider_creds_user_provider').on(table.userId, table.provider),
  index('idx_provider_creds_user').on(table.userId),
]);

// Infrastructure resources (provisioned databases, deployed apps, etc.)
export const infrastructureResources = sqliteTable('infrastructure_resources', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  type: text('type').notNull(), // 'compute', 'compute:edge', 'database:postgres', 'database:redis', 'storage:blob'
  provider: text('provider').notNull(), // 'railway', 'cloudflare'
  providerResourceId: text('provider_resource_id'), // External ID in provider system
  name: text('name').notNull(), // User-friendly display name
  connectionInfo: text('connection_info'), // Encrypted JSON: { url, host, port, username, password }
  status: text('status').notNull().default('pending'), // 'pending', 'provisioning', 'ready', 'error', 'deleted'
  error: text('error'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
}, (table) => [
  index('idx_infra_resources_project').on(table.projectId),
  index('idx_infra_resources_project_type').on(table.projectId, table.type),
]);

// Deployment settings per workspace
export const deploymentSettings = sqliteTable('deployment_settings', {
  workspaceId: text('workspace_id').primaryKey().references(() => workspaces.id, { onDelete: 'cascade' }),
  autoDeploy: integer('auto_deploy').notNull().default(0),
  runtimeOverride: text('runtime_override'),
  buildCommand: text('build_command'),
  startCommand: text('start_command'),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});

// Deployments history
export const deployments = sqliteTable('deployments', {
  id: text('id').primaryKey(),
  workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'set null' }),
  projectId: text('project_id').notNull().references(() => projects.id, { onDelete: 'cascade' }),
  snapshotId: text('snapshot_id').references(() => snapshots.id, { onDelete: 'set null' }),
  status: text('status').notNull(), // 'deploying' | 'success' | 'failed'
  trigger: text('trigger').notNull(), // 'manual' | 'chat' | 'auto'
  url: text('url'),
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
}, (table) => [
  index('idx_deployments_workspace').on(table.workspaceId, table.startedAt),
  index('idx_deployments_project').on(table.projectId, table.startedAt),
  index('idx_deployments_status').on(table.status, table.startedAt),
]);
