# Fastest Database Schema

SQLite (Cloudflare D1) via Drizzle ORM.

Source: `api/src/db/schema.ts`

---

## Auth

### `users`
Registered users.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | ULID |
| `email` | text | Unique, not null |
| `name` | text | Nullable |
| `picture` | text | Nullable (Google profile picture URL) |
| `created_at` | text | Default `datetime('now')` |

### `auth_codes`
Web magic link auth codes.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text | Nullable |
| `email` | text | Not null |
| `code` | text | Unique, not null |
| `expires_at` | text | Not null |
| `used` | integer | Default 0 |
| `created_at` | text | Default `datetime('now')` |

### `device_codes`
CLI OAuth device flow codes (RFC 8628).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `device_code` | text | Unique, not null. Indexed |
| `user_code` | text | Unique, not null. Format: `ABCD-1234`. Indexed |
| `user_id` | text | FK -> `users.id`. Nullable (set on authorization) |
| `status` | text | `pending` / `authorized` / `denied`. Default `pending` |
| `expires_at` | text | Not null. 15-minute expiry |
| `created_at` | text | Default `datetime('now')` |

### `sessions`
Bearer token sessions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text | FK -> `users.id`, not null |
| `token_hash` | text | Unique, not null. SHA-256 hash of the bearer token |
| `expires_at` | text | Not null. 30-day lifetime |
| `created_at` | text | Default `datetime('now')` |

### `user_api_keys`
User-provided API keys for LLM providers (Anthropic, OpenAI, Google). Encrypted with AES-GCM.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text | FK -> `users.id` (cascade delete) |
| `provider` | text | e.g. `anthropic`, `openai`, `google` |
| `key_name` | text | Env var name, e.g. `ANTHROPIC_API_KEY` |
| `key_value` | text | Encrypted value (prefix `enc:v1:`) |
| `created_at` | text | |
| `updated_at` | text | |

- Unique index on `(user_id, provider)`

---

## Projects

### `projects`
Top-level container for workspaces and snapshots.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | ULID |
| `owner_user_id` | text | FK -> `users.id`, not null |
| `name` | text | Not null |
| `intent` | text | Nullable. One of: `startup`, `personal_tool`, `learning`, `fun`, `portfolio`, `creative`, `exploration`, `open_source` |
| `brief` | text | Nullable. JSON-encoded `ProjectBrief` |
| `created_at` | text | |
| `updated_at` | text | |
| `last_snapshot_id` | text | Nullable. Points to the most recently pushed snapshot |
| `main_workspace_id` | text | Nullable. The workspace treated as "main" for drift comparisons |

- Index on `(owner_user_id, updated_at)`

### `project_env_vars`
Environment variables attached to a project. Secrets can be marked for masking.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `key` | text | Not null |
| `value` | text | Not null. May be encrypted for secrets |
| `is_secret` | integer | Default 0 |
| `created_at` | text | |
| `updated_at` | text | |

- Unique index on `(project_id, key)`

---

## Workspaces & Snapshots

### `workspaces`
A workspace is a working copy of a project on a specific machine.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | ULID |
| `project_id` | text | FK -> `projects.id`, not null |
| `name` | text | Not null |
| `machine_id` | text | Nullable. Identifies the physical machine |
| `base_snapshot_id` | text | FK -> `snapshots.id`. The snapshot this workspace was forked from |
| `current_snapshot_id` | text | FK -> `snapshots.id`. The latest committed snapshot |
| `current_manifest_hash` | text | Nullable. Tracks dirty (uncommitted) file state |
| `local_path` | text | Nullable. Absolute path on disk |
| `last_seen_at` | text | Nullable. Updated by heartbeat |
| `created_at` | text | |
| `version` | integer | Default 1. Used for optimistic locking during sync |
| `merge_history` | text | Nullable. JSON: `Record<workspaceId, { last_merged_snapshot, merged_at }>` |

- Index on `(project_id, created_at)`

### `snapshots`
Immutable point-in-time captures of a project's file tree. Forms a DAG via `parent_snapshot_ids`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | Format: `snap-<ULID>` |
| `project_id` | text | FK -> `projects.id`, not null |
| `workspace_id` | text | Nullable. Which workspace created this snapshot |
| `manifest_hash` | text | Not null. SHA-256 of the manifest JSON |
| `parent_snapshot_ids` | text | JSON array of parent snapshot IDs. Default `[]` |
| `source` | text | `cli` / `web` / `system`. Default `cli` |
| `summary` | text | Nullable. LLM-generated description of changes |
| `created_at` | text | |

- Index on `(project_id, created_at)`
- Index on `(workspace_id, created_at)`

### `drift_reports`
Records of file-level differences between workspaces (or workspace vs. main).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `workspace_id` | text | FK -> `workspaces.id`, not null |
| `source_workspace_id` | text | FK -> `workspaces.id`. Nullable. The workspace compared against |
| `workspace_snapshot_id` | text | FK -> `snapshots.id`. Nullable |
| `source_snapshot_id` | text | FK -> `snapshots.id`. Nullable |
| `source_only` | text | JSON array of file paths only in source. Default `[]` |
| `workspace_only` | text | JSON array of file paths only in workspace. Default `[]` |
| `both_same` | text | JSON array. Default `[]` |
| `both_different` | text | JSON array of conflicting file paths. Default `[]` |
| `files_added` | integer | Default 0 |
| `files_modified` | integer | Default 0 |
| `files_deleted` | integer | Default 0 |
| `bytes_changed` | integer | Default 0 |
| `summary` | text | Nullable |
| `reported_at` | text | |

- Index on `(workspace_id, reported_at)`

### `activity_events`
Audit log of project activity (snapshots pushed, workspaces created, drift reported, merges, etc.).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id`, not null |
| `workspace_id` | text | Nullable |
| `actor` | text | Not null. `cli` / `web` / `system` |
| `type` | text | Not null. e.g. `project.created`, `snapshot.pushed`, `drift.reported`, `merge.completed` |
| `snapshot_id` | text | Nullable |
| `message` | text | Nullable. Human-readable description |
| `created_at` | text | |

- Index on `(project_id, created_at)`

---

## Conversations

### `conversations`
Chat sessions within a workspace. Message content is stored in the ConversationSession Durable Object, not in D1.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `workspace_id` | text | FK -> `workspaces.id`, not null |
| `title` | text | Nullable. Auto-generated from first message |
| `created_at` | text | |
| `updated_at` | text | |

- Index on `(workspace_id, updated_at)`

---

## Intelligence (Atlas, Action Items, Next Steps)

### `next_steps`
AI-generated product guidance suggestions.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `title` | text | Not null |
| `description` | text | Nullable |
| `rationale` | text | Nullable |
| `category` | text | `feature` / `validation` / `launch` / `technical` / `user_research` |
| `priority` | integer | 1=high, 2=medium, 3=low. Default 2 |
| `effort` | text | Nullable. `small` / `medium` / `large` |
| `status` | text | `pending` / `started` / `completed` / `dismissed`. Default `pending` |
| `helpful_count` | integer | Default 0 |
| `not_helpful_count` | integer | Default 0 |
| `model` | text | Nullable. Which LLM generated this |
| `generated_at` | text | |
| `acted_on_at` | text | Nullable |

- Index on `(project_id, status)`
- Index on `(project_id, priority)`

### `project_decisions`
Decisions extracted from conversations (by LLM).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `conversation_id` | text | FK -> `conversations.id` (set null on delete). Nullable |
| `decision` | text | Not null |
| `rationale` | text | Nullable |
| `category` | text | Nullable. `architecture` / `scope` / `tech_choice` / `approach` / `process` / `product` |
| `decided_at` | text | |

- Index on `(project_id, decided_at)`
- Unique index on `(project_id, decision)` (prevents duplicate decisions)

### `action_items`
Code-level issues surfaced by background analysis (security, test coverage, refactoring, build failures).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `workspace_id` | text | FK -> `workspaces.id` (cascade delete) |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `type` | text | `refactoring` / `security` / `test_coverage` / `build_failure` |
| `severity` | text | `info` / `warning` / `critical`. Default `info` |
| `title` | text | Not null |
| `description` | text | Nullable |
| `affected_files` | text | Nullable. JSON array of file paths |
| `suggested_prompt` | text | Nullable. Pre-filled prompt to fix the issue |
| `metadata` | text | Nullable. JSON |
| `status` | text | `pending` / `running` / `ready` / `applied` / `dismissed`. Default `pending` |
| `source` | text | `analysis` / `import` / `manual`. Default `analysis` |
| `created_at` | text | |
| `updated_at` | text | |

- Index on `(workspace_id, created_at)`
- Index on `(project_id, created_at)`
- Index on `(workspace_id, status)`

### `action_item_runs`
Execution records for action item patch generation and verification.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `action_item_id` | text | FK -> `action_items.id` (cascade delete) |
| `workspace_id` | text | FK -> `workspaces.id` (cascade delete) |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `status` | text | `queued` / `running` / `ready` / `failed` / `applied`. Default `queued` |
| `attempt_count` | integer | Default 0 |
| `max_attempts` | integer | Default 3 |
| `base_manifest_hash` | text | Nullable |
| `summary` | text | Nullable |
| `report` | text | Nullable |
| `patch` | text | Nullable |
| `checks` | text | Nullable. JSON |
| `error` | text | Nullable |
| `started_at` | text | Nullable |
| `completed_at` | text | Nullable |
| `created_at` | text | |
| `updated_at` | text | |

- Index on `(action_item_id, created_at)`
- Index on `(workspace_id, created_at)`
- Index on `(status, created_at)`

### `refactoring_suggestions`
Legacy table for background code analysis suggestions. Superseded by `action_items`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `workspace_id` | text | FK -> `workspaces.id` (cascade delete) |
| `snapshot_id` | text | FK -> `snapshots.id`. Nullable |
| `type` | text | `security` / `duplication` / `performance` / `naming` / `structure` / `test_coverage` |
| `severity` | text | `info` / `warning` / `critical`. Default `info` |
| `title` | text | Not null |
| `description` | text | Nullable |
| `affected_files` | text | Nullable. JSON array |
| `suggested_prompt` | text | Nullable |
| `status` | text | `pending` / `applied` / `dismissed`. Default `pending` |
| `created_at` | text | |

- Index on `(workspace_id, created_at)`
- Index on `(workspace_id, status)`

### Atlas (Knowledge Graph)

#### `atlas_concepts`
Nodes in the project knowledge graph. Derived from snapshot file trees (systems, modules, code files).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | Format: `system:<name>`, `module:<path>`, or `code:<file_path>` |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `name` | text | Not null |
| `layer` | text | `narrative` / `capability` / `system` / `module` / `code` |
| `type` | text | Nullable. Optional concept subtype |
| `description` | text | Nullable |
| `source_snapshot_id` | text | FK -> `snapshots.id` (set null on delete). Nullable |
| `source_manifest_hash` | text | Nullable |
| `metadata` | text | Nullable. JSON |
| `created_at` | text | |
| `updated_at` | text | |

- Index on `(project_id, layer)`
- Unique index on `(project_id, id)`

#### `atlas_edges`
Relationships between concepts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `from_concept_id` | text | Not null |
| `to_concept_id` | text | Not null |
| `type` | text | `contains` / `depends_on` / `used_by` / `relates` |
| `weight` | integer | Nullable |
| `created_at` | text | |

- Index on `(project_id, from_concept_id)`
- Index on `(project_id, to_concept_id)`
- Index on `(project_id, type)`

#### `atlas_chunks`
Text chunks extracted from source code, decisions, or conversations for semantic search.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `concept_id` | text | Nullable |
| `kind` | text | `code` / `decision` / `conversation` |
| `content` | text | Not null. Max ~4000 chars |
| `file_path` | text | Nullable |
| `symbol` | text | Nullable |
| `source_hash` | text | Nullable |
| `created_at` | text | |

- Index on `(project_id, kind)`
- Index on `(project_id, concept_id)`

#### `atlas_embeddings`
Vector embeddings for chunks (model: `bge-small-en-v1.5`).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `chunk_id` | text | FK -> `atlas_chunks.id` (cascade delete) |
| `model` | text | Not null. e.g. `@cf/baai/bge-small-en-v1.5` |
| `vector` | text | Not null. JSON array of floats |
| `created_at` | text | |

- Index on `(chunk_id)`

#### `atlas_decision_links`
Links between project decisions and Atlas concepts.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `decision_id` | text | FK -> `project_decisions.id` (cascade delete) |
| `concept_id` | text | Not null |
| `confidence` | integer | Nullable. 0-100 |
| `created_at` | text | |

- Index on `(project_id, decision_id)`
- Index on `(project_id, concept_id)`

#### `atlas_diagrams`
Stored diagram outputs for the Atlas canvas view.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `concept_id` | text | Nullable |
| `type` | text | `flow` / `dependency` / `component` / `sequence` |
| `data` | text | Not null. JSON |
| `created_at` | text | |

- Index on `(project_id, created_at)`
- Index on `(project_id, concept_id)`

---

## Infrastructure

### `provider_credentials`
API tokens for infrastructure providers (Railway, Cloudflare, etc.).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `user_id` | text | FK -> `users.id` (cascade delete) |
| `provider` | text | `railway` / `cloudflare` |
| `api_token` | text | Not null. Encrypted |
| `metadata` | text | Nullable. JSON (account_id, team_id, etc.) |
| `created_at` | text | |
| `updated_at` | text | |

- Unique index on `(user_id, provider)`

### `infrastructure_resources`
Provisioned infrastructure (databases, compute, storage).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `type` | text | `compute` / `compute:edge` / `database:postgres` / `database:redis` / `storage:blob` |
| `provider` | text | `railway` / `cloudflare` |
| `provider_resource_id` | text | Nullable. External ID in provider system |
| `name` | text | Not null |
| `connection_info` | text | Nullable. Encrypted JSON (url, host, port, username, password) |
| `status` | text | `pending` / `provisioning` / `ready` / `error` / `deleted`. Default `pending` |
| `error` | text | Nullable |
| `created_at` | text | |
| `updated_at` | text | |

- Index on `(project_id)`
- Index on `(project_id, type)`

### `deployment_settings`
Per-workspace deployment configuration.

| Column | Type | Notes |
|--------|------|-------|
| `workspace_id` | text PK | FK -> `workspaces.id` (cascade delete) |
| `auto_deploy` | integer | Default 0 (boolean) |
| `runtime_override` | text | Nullable |
| `build_command` | text | Nullable |
| `start_command` | text | Nullable |
| `created_at` | text | |
| `updated_at` | text | |

### `deployments`
Deployment execution history.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `workspace_id` | text | FK -> `workspaces.id` (set null on delete). Nullable |
| `project_id` | text | FK -> `projects.id` (cascade delete) |
| `snapshot_id` | text | FK -> `snapshots.id` (set null on delete). Nullable |
| `status` | text | `deploying` / `success` / `failed` |
| `trigger` | text | `manual` / `chat` / `auto` |
| `url` | text | Nullable. Deployed URL |
| `error` | text | Nullable |
| `started_at` | text | Not null |
| `completed_at` | text | Nullable |

- Index on `(workspace_id, started_at)`
- Index on `(project_id, started_at)`
- Index on `(status, started_at)`

### `jobs` (DEPRECATED)
Legacy agent execution queue. No longer actively used.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | |
| `workspace_id` | text | FK -> `workspaces.id` |
| `project_id` | text | FK -> `projects.id` |
| `prompt` | text | Not null |
| `status` | text | `pending` / etc. Default `pending` |
| `output_snapshot_id` | text | FK -> `snapshots.id`. Nullable |
| `error` | text | Nullable |
| `created_at` | text | |
| `started_at` | text | Nullable |
| `completed_at` | text | Nullable |

---

## External Storage

Not in D1, but referenced throughout:

- **R2 Bucket (`BLOBS`)**: Stores blobs at `{userId}/blobs/{sha256hash}` and manifests at `{userId}/manifests/{sha256hash}.json`. Content-addressed, immutable, user-scoped.
- **ConversationSession Durable Object**: Stores chat messages, OpenCode state, and sandbox interaction. Keyed by `conversation:{conversationId}`.
- **KV (Workers KV)**: Used for temporary sync preview storage with 30-minute TTL. Keys: `sync_preview:{previewId}`.
