# Fastest API Reference

Hono on Cloudflare Workers. All routes are prefixed with `/v1`.
Authentication is via `Authorization: Bearer <token>` header unless noted otherwise.

Source: `api/src/index.ts` (route mounting), `api/src/routes/` (implementations).

---

## Auth

Source: `api/src/routes/auth.ts`

### `POST /v1/auth/google`
Verify a Google ID token and create a session. Creates the user if first login.

- Request: `{ credential: string }`
- Response: `{ access_token, token_type, expires_in, user: { id, email } }`
- Token lifetime: 30 days

### `GET /v1/auth/me`
Return the current authenticated user.

- Response: `{ user: { id, email, name, picture } }`

### `GET /v1/auth/api-keys`
List all LLM provider API keys for the current user. Values are masked (last 4 chars visible).

- Response: `{ api_keys: [{ id, user_id, provider, key_name, key_value, created_at, updated_at }] }`

### `POST /v1/auth/api-keys`
Set (create or update) an API key for a provider. Keys are AES-GCM encrypted at rest.

- Request: `{ provider: string, key_value: string }`
- Response: `{ success: true }`

### `DELETE /v1/auth/api-keys/:provider`
Delete an API key for a given provider.

- Response: `{ success: true }`

### `GET /v1/auth/api-keys/values`
Internal endpoint. Returns decrypted API key values as env var map (used by sandbox/OpenCode).

- Response: `{ env_vars: Record<string, string> }`

---

## OAuth (Device Flow)

Source: `api/src/routes/oauth.ts`

Implements RFC 8628 device authorization flow for CLI login.

### `POST /v1/oauth/device`
Start the device authorization flow. Returns codes for the CLI to display.

- Response: `{ device_code, user_code, verification_uri, verification_uri_complete, expires_in, interval }`
- Device code expires in 15 minutes. Poll interval is 5 seconds.

### `POST /v1/oauth/token`
Poll for token exchange. CLI calls this repeatedly until the user authorizes.

- Request: `{ grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: string }`
- Response (authorized): `{ access_token, token_type, expires_in, user }`
- Response (pending): `{ error: "authorization_pending" }` (HTTP 400)

### `POST /v1/oauth/device/authorize`
Called from the web UI when the user enters the code. Accepts a Google credential or an existing Bearer token.

- Request: `{ user_code: string, credential?: string }`
- Response: `{ success: true, message: "Device authorized..." }`

### `POST /v1/oauth/device/deny`
Called from the web UI if the user denies authorization.

- Request: `{ user_code: string }`
- Response: `{ success: true }`

---

## Projects

Source: `api/src/routes/projects.ts`

### `POST /v1/projects`
Create a new project.

- Request: `{ name: string }`
- Response: `{ project }` (201)

### `GET /v1/projects`
List all projects for the current user, ordered by `updated_at` descending.

- Response: `{ projects: [...] }`

### `GET /v1/projects/:projectId`
Get a project with its workspaces, recent snapshots (last 10), recent events (last 20), and snapshot insights (last merge/deploy timestamps, snapshots since each).

- Response: `{ project, workspaces, snapshots, events, snapshot_insights }`

### `GET /v1/projects/:projectId/status`
Lightweight status check for a project.

- Response: `{ last_snapshot_id, updated_at, last_activity }`

### `GET /v1/projects/:projectId/events`
List activity events for a project.

- Query: `?limit=20` (max 100)
- Response: `{ events: [...] }`

### `POST /v1/projects/:projectId/workspaces`
Create a workspace under a project.

- Request: `{ name, machine_id?, base_snapshot_id?, local_path? }`
- Response: `{ workspace }` (201)

### `GET /v1/projects/:projectId/workspaces`
List workspaces for a project. Each workspace includes its latest drift report.

- Response: `{ workspaces: [...] }`

### `POST /v1/projects/:projectId/snapshots`
Create a snapshot. Supports idempotency via `snapshot_id`. Verifies that the manifest exists in object storage before registering.

- Request: `{ manifest_hash, snapshot_id?, parent_snapshot_ids?, workspace_id?, source? }`
- Response: `{ snapshot, created: boolean }` (201 if new)

### `GET /v1/projects/:projectId/snapshots`
List snapshots for a project.

- Query: `?limit=50` (max 100)
- Response: `{ snapshots: [...] }`

### Environment Variables

### `GET /v1/projects/:projectId/env-vars`
List env vars. Secret values are masked.

- Response: `{ variables: [{ id, project_id, key, value, is_secret, created_at, updated_at }] }`

### `POST /v1/projects/:projectId/env-vars`
Set a single env var (upsert).

- Request: `{ key, value, is_secret? }`
- Response: `{ success: true }`

### `PUT /v1/projects/:projectId/env-vars`
Bulk set env vars.

- Request: `{ variables: [{ key, value, is_secret? }] }`
- Response: `{ success: true, count }`

### `DELETE /v1/projects/:projectId/env-vars/:key`
Delete an env var.

- Response: `{ success: true }`

### `GET /v1/projects/:projectId/env-vars/values`
Internal endpoint. Returns env vars with unmasked values (for deployment).

- Response: `{ variables: [{ key, value, is_secret }] }`

### Documentation

### `GET /v1/projects/:projectId/docs`
List documentation files (markdown, txt, etc.) across all workspaces by scanning manifests.

- Response: `{ workspaces: [{ workspace_id, workspace_name, files }], total_files }`

### `GET /v1/projects/:projectId/docs/content`
Get the content of a specific doc file from blob storage.

- Query: `?workspace=<id>&path=<file_path>`
- Response: `{ content, path, workspace_id, workspace_name, size }`

### Brief & Intent

### `GET /v1/projects/:projectId/brief`
Get the project brief and intent.

- Response: `{ project: { id, intent, brief } }`

### `PATCH /v1/projects/:projectId/brief`
Update the project brief and/or intent.

- Request: `{ intent?, brief? }`
- Response: `{ success: true }`

### Next Steps (AI-generated suggestions)

### `GET /v1/projects/:projectId/next-steps`
List next step suggestions for a project, filtered by status.

- Query: `?status=pending` (default: pending)
- Response: `{ next_steps: [...] }`

### `POST /v1/projects/:projectId/next-steps/generate`
Generate next step suggestions using Workers AI (Llama 3.1 8B). Analyzes project brief, intent, decisions, and code structure.

- Response: `{ next_steps: [...], generated_count }`

### `PATCH /v1/projects/:projectId/next-steps/:nextStepId`
Update a next step's status.

- Request: `{ status: "pending" | "started" | "completed" | "dismissed" }`
- Response: `{ success: true }`

### `POST /v1/projects/:projectId/next-steps/:nextStepId/feedback`
Submit feedback (helpful/not helpful) on a next step suggestion.

- Request: `{ helpful: boolean }`
- Response: `{ success: true }`

### Decisions

### `GET /v1/projects/:projectId/decisions`
List project decisions. Optionally include linked Atlas concepts.

- Query: `?include_links=true`
- Response: `{ decisions: [...] }`

### `POST /v1/projects/:projectId/decisions/extract`
Extract decisions from recent conversations using Workers AI.

- Response: `{ decisions: [...], extracted_count }`

### Atlas (Knowledge Graph)

### `POST /v1/projects/:projectId/atlas/search`
Search the project knowledge graph. Uses token-matching for text queries, cosine similarity for embeddings.

- Request: `{ query: string, limit? }`
- Response: `{ results: [{ id, name, description, layer }] }`

### `GET /v1/projects/:projectId/atlas`
Get the full Atlas graph (concepts and edges) for a project.

- Response: `{ concepts: [...], edges: [...] }`

### `POST /v1/projects/:projectId/atlas/index`
Rebuild the Atlas index from the latest snapshot manifest. Derives systems, modules, and code concepts from the file tree. Optionally chunks source files and generates embeddings. Links decisions to concepts.

- Query: `?embed=true` (enable embedding generation)
- Response: `{ concepts_created, edges_created, chunks_created, embeddings_created }`

### `GET /v1/projects/:projectId/atlas/diagrams`
List stored diagrams for a project.

- Response: `{ diagrams: [...] }`

### `POST /v1/projects/:projectId/atlas/diagrams`
Generate a diagram from Atlas graph data.

- Request: `{ concept_id?, type: "flow" | "dependency" | "component" | "sequence" }`
- Response: `{ diagram: { id, type, title, nodes, edges } }`

---

## Workspaces

Source: `api/src/routes/workspaces.ts`

### `GET /v1/workspaces/:workspaceId`
Get a workspace with its latest drift report (enriched with overlap ratio, risk level, staleness, counts by extension).

- Response: `{ workspace, drift }`

### `POST /v1/workspaces/:workspaceId/heartbeat`
Update workspace `last_seen_at` timestamp.

- Response: `{ success: true, last_seen_at }`

### `POST /v1/workspaces/:workspaceId/current-manifest`
Update the current manifest hash (optimistic concurrency). Used by CLI to track dirty state.

- Request: `{ manifest_hash, previous_manifest_hash? }`
- Response: `{ updated: true, current_manifest_hash }` or `409 { updated: false, conflict: true }`

### `POST /v1/workspaces/:workspaceId/drift`
Report drift metrics from the CLI.

- Request: `{ files_added, files_modified, files_deleted, bytes_changed, summary? }`
- Response: `{ drift_report }` (201)

### `GET /v1/workspaces/:workspaceId/drift`
Get drift report history for a workspace.

- Query: `?limit=10` (max 100)
- Response: `{ drift_reports, latest }`

### `GET /v1/workspaces/:workspaceId/drift/compare`
Compare a workspace against another (defaults to the project's main workspace). Fetches manifests from R2 and computes file-level differences.

- Query: `?source_workspace_id=<id>&include_dirty=true`
- Response: `{ drift, is_main_workspace, source_workspace }`

### `POST /v1/workspaces/:workspaceId/drift/analyze`
AI-powered drift analysis using Workers AI (Llama 3.1 8B). Returns risk assessment and sync recommendation.

- Query: `?include_dirty=true`
- Response: `{ analysis: { source_changes_summary, risk_level, can_auto_sync, recommendation, ... } }`

### `POST /v1/workspaces/:workspaceId/set-as-main`
Set a workspace as the project's main workspace.

- Response: `{ success: true, main_workspace_id }`

### Sync

### `POST /v1/workspaces/:workspaceId/sync/prepare`
Prepare a sync preview. Performs a three-way merge (using merge base from snapshot DAG) between the workspace and main. AI analyzes conflicting files and attempts auto-combination. Stores the preview in KV with 30-minute TTL.

- Response: `{ preview: { id, auto_actions, decisions_needed, files_to_update, files_to_add, summary, ... } }`

### `POST /v1/workspaces/:workspaceId/sync/execute`
Execute a previously prepared sync. Applies auto actions and user decisions, creates new manifest and snapshot. Uses optimistic locking on workspace version. Supports rollback on failure.

- Request: `{ preview_id, decisions?: Record<path, option_id>, create_snapshot_before?, create_snapshot_after? }`
- Response: `{ success, snapshot_id, manifest_hash, files_updated, files_added, ... }`

### `POST /v1/workspaces/:workspaceId/sync/undo`
Undo the last sync by reverting to the pre-sync snapshot.

- Response: `{ success, reverted_to_snapshot_id }`

### `GET /v1/workspaces/:workspaceId/snapshots`
List snapshots for a specific workspace.

- Query: `?limit=50` (max 100)
- Response: `{ snapshots: [...] }`

### `POST /v1/workspaces/:workspaceId/deploy`
Trigger a deployment for a workspace.

- Response: `{ deployment_id, status }`

---

## Snapshots

Source: `api/src/routes/snapshots.ts`

### `GET /v1/snapshots/:snapshotId`
Get a snapshot by ID. Verifies ownership through the project.

- Response: `{ snapshot: { id, project_id, manifest_hash, parent_snapshot_ids, source, created_at } }`

---

## Blobs & Manifests

Source: `api/src/routes/blobs.ts`

All blob and manifest operations are user-scoped (stored under `{userId}/blobs/` and `{userId}/manifests/` in R2).

### `POST /v1/blobs/exists`
Check which blobs exist in storage (max 100 per request).

- Request: `{ hashes: string[] }`
- Response: `{ missing, existing, checked }`

### `POST /v1/blobs/presign-upload`
Get upload URLs for blobs. Returns worker-proxied paths (not true presigned URLs).

- Request: `{ hashes: string[] }`
- Response: `{ urls: Record<hash, path> }`

### `POST /v1/blobs/presign-download`
Get download URLs for blobs.

- Request: `{ hashes: string[] }`
- Response: `{ urls: Record<hash, path> }`

### `PUT /v1/blobs/upload/:hash`
Upload a blob. Verifies SHA-256 hash matches content. Deduplicates (skips if already exists).

- Request body: raw binary
- Response: `{ hash, size, created }` (201 if new)

### `GET /v1/blobs/download/:hash`
Download a blob. Returned with `Cache-Control: immutable` (1 year).

- Response: raw binary with `application/octet-stream`

### `PUT /v1/blobs/manifests/:hash`
Upload a manifest JSON. Verifies SHA-256 hash. Deduplicates.

- Request body: JSON text
- Response: `{ hash, created }` (201 if new)

### `GET /v1/blobs/manifests/:hash`
Download a manifest JSON. Returned with `Cache-Control: immutable`.

- Response: JSON

### `POST /v1/blobs/gc`
Garbage collection. Find and optionally delete orphaned blobs.

- Request: `{ dryRun?: boolean, maxBlobs?: number }` (dryRun defaults to true)
- Response: `{ success, dryRun, scannedBlobs, orphanedBlobs, freedBytes, freedMB }`

### `GET /v1/blobs/stats`
Get storage usage statistics for the current user.

- Response: `{ blobs: { count, bytes, mb }, manifests: { count, bytes, mb }, total: { bytes, mb } }`

---

## Conversations

Source: `api/src/routes/conversations.ts`

Conversations are chat sessions within a workspace. Message state is managed by a `ConversationSession` Durable Object.

### `POST /v1/conversations`
Create a new conversation. Initializes a Durable Object with the workspace's current manifest.

- Request: `{ workspace_id, title? }`
- Response: `{ conversation: { id, workspace_id, title, created_at, updated_at } }`

### `GET /v1/conversations`
List conversations for the current user (across all projects).

- Query: `?limit=20&offset=0`
- Response: `{ conversations: [{ id, workspace_id, title, workspace_name, project_id, project_name, ... }] }`

### `GET /v1/conversations/:conversationId`
Get a single conversation with workspace and project context.

- Response: `{ conversation }`

### `PATCH /v1/conversations/:conversationId`
Update conversation title or move to a different workspace (must be same project).

- Request: `{ title?, workspace_id? }`
- Response: `{ success: true }`

### `GET /v1/conversations/:conversationId/messages`
Get messages from the Durable Object.

- Query: `?limit=<n>&before=<timestamp>`
- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/opencode-messages`
Get persisted OpenCode message parts mapped to conversation message IDs.

- Response: forwarded from Durable Object

### `POST /v1/conversations/:conversationId/messages`
Send a message (prompt) to the conversation. Auto-generates a title from the first message.

- Request: `{ prompt: string }`
- Response: forwarded from Durable Object

### `POST /v1/conversations/:conversationId/opencode-questions/:requestId/reply`
Reply to an OpenCode question request.

- Request: `{ answers: string[][] }`
- Response: `{ success: true }`

### `POST /v1/conversations/:conversationId/opencode-questions/:requestId/reject`
Reject an OpenCode question request.

- Response: `{ success: true }`

### `POST /v1/conversations/:conversationId/clear`
Clear all messages in a conversation.

- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/timeline`
Get the conversation timeline.

- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/project-info`
Get project info from the Durable Object context.

- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/deployments`
Get deployments associated with a conversation.

- Response: forwarded from Durable Object

### `POST /v1/conversations/:conversationId/deploy`
Trigger a deployment from a conversation. Creates a deployment record and delegates to the Durable Object.

- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/deployments/:deploymentId/logs`
Get deployment logs.

- Response: forwarded from Durable Object

### `GET /v1/conversations/:conversationId/stream`
WebSocket endpoint for streaming conversation updates. Auth via `?token=` query param (WebSocket cannot send custom headers).

- Requires: `Upgrade: websocket` header
- Proxies WebSocket to the ConversationSession Durable Object

### `POST /v1/conversations/:conversationId/snapshot`
Create a snapshot from the conversation's current file state. Optionally generates an LLM summary of changes.

- Request: `{ generate_summary?: boolean }`
- Response: `{ snapshot_id, manifest_hash, was_dirty, summary }`

---

## Action Items

Source: `api/src/routes/action-items.ts`

Aggregates actionable items from drift reports, persisted action items (code analysis), and failed deployments.

### `GET /v1/action-items`
List all action items across the user's workspaces. Combines drift-based items, analysis-based items (security, test coverage, refactoring), and failed deployment items. Sorted by severity (critical first).

- Response: `{ items: [{ id, type, severity, workspace_id, project_id, title, description, action_label, action_type, action_data, ... }] }`

### `POST /v1/action-items/:itemId/dismiss`
Dismiss an action item. For `drift-*` and `deploy-*` items, this is a no-op (no persistent dismiss state yet).

- Response: `{ success: true }`

### `POST /v1/action-items/:itemId/runs`
Create and start a background run for an action item (patch generation). Delegates execution to the ConversationSession Durable Object.

- Response: `{ run: { id, action_item_id, status, attempt_count, max_attempts, ... } }`

### `GET /v1/action-items/:itemId/runs`
List runs for a specific action item.

- Response: `{ runs: [...] }`

### `GET /v1/action-items/runs/:runId`
Get a single run with full details (summary, report, patch, checks, error).

- Response: `{ run }`

### `POST /v1/action-items/runs/:runId/apply`
Apply a ready run's changes back to the workspace via the Durable Object.

- Response: `{ success: true }`

---

## Infrastructure

Source: `api/src/routes/infrastructure.ts`

Manages deployment infrastructure: provider credentials, resources, deployment settings, and deployments.

### Provider Credentials

### `GET /v1/infrastructure/credentials`
List provider credentials for the current user (API tokens not returned).

- Response: `{ credentials: [{ id, user_id, provider, metadata, created_at, updated_at }] }`

### `POST /v1/infrastructure/credentials`
Add or update a provider credential. Validates with the provider before saving.

- Request: `{ provider: string, api_token: string, metadata? }`
- Response: `{ success: true, id }`

### `DELETE /v1/infrastructure/credentials/:provider`
Remove a provider credential.

- Response: `{ success: true }`

### Deployment Settings

### `GET /v1/infrastructure/workspaces/:workspaceId/deployment-settings`
Get deployment settings for a workspace (auto-deploy, runtime override, build/start commands).

- Response: `{ settings: { workspace_id, auto_deploy, runtime_override, build_command, start_command, ... } }`

### `PUT /v1/infrastructure/workspaces/:workspaceId/deployment-settings`
Update deployment settings.

- Request: `{ auto_deploy?, runtime_override?, build_command?, start_command? }`
- Response: `{ settings }`

### Deployments

### `GET /v1/infrastructure/workspaces/:workspaceId/deployments`
List deployment history for a workspace.

- Query: `?limit=30` (max 100)
- Response: `{ deployments: [{ id, workspace_id, project_id, snapshot_id, status, trigger, url, error, started_at, completed_at }] }`

### `POST /v1/infrastructure/deployments/:deploymentId/status`
Update deployment status (internal callback from deploy pipeline).

- Request: `{ status, url?, error?, completed_at? }`
- Response: `{ success: true }`

### Resources

### `GET /v1/infrastructure/projects/:projectId/resources`
List infrastructure resources for a project. Connection info is masked.

- Response: `{ resources: [{ id, project_id, type, provider, name, status, ... }] }`

### `GET /v1/infrastructure/projects/:projectId/resources/:resourceId`
Get a specific resource.

- Response: `{ resource }`

### `DELETE /v1/infrastructure/projects/:projectId/resources/:resourceId`
Delete a resource. Attempts to destroy it in the provider first.

- Response: `{ success: true }`

### Detection & Deploy

### `GET /v1/infrastructure/projects/:projectId/detect`
Detect infrastructure requirements from project files.

- Query: `?manifest_hash=<hash>`
- Response: `{ requirements, suggested_resources, detection }`

### `POST /v1/infrastructure/projects/:projectId/deploy`
Full deployment pipeline: detect requirements, provision missing resources (databases, etc.), deploy compute.

- Request: `{ workspace_id?, source?: "manual" | "chat" | "auto" }`
- Response: `{ success, deployment_id, url, resources, provisioned_resources, error }`

---

## Health & Errors

### `GET /health`
Health check (no auth required, no `/v1` prefix).

- Response: `{ status: "ok", timestamp }`

### Error format
All errors follow: `{ error: { code: string, message: string } }`

### Scheduled jobs
The worker exports a `scheduled` handler that runs `runBackgroundJobs` (source: `api/src/background-jobs.ts`).
