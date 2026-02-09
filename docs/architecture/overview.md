# Architecture overview

Fastest is a three-component system: a Go CLI, a Hono API on Cloudflare Workers, and a React web frontend. The CLI is the primary interface for local workspace operations; the API stores metadata and blobs in Cloudflare D1 and R2; the web UI provides a conversation-driven interface for project management.

## Components

### CLI (`cli/`)

Go module at `github.com/anthropics/fastest/cli`. Entry point is `cli/cmd/fst/main.go`. Commands live in `cli/cmd/fst/commands/` and self-register via `register()` during `init()` (see `root.go`). Built on [Cobra](https://github.com/spf13/cobra).

Internal packages:

| Package | Path | Purpose |
|---------|------|---------|
| `config` | `cli/internal/config/` | `.fst/config.json` read/write, directory layout constants |
| `manifest` | `cli/internal/manifest/` | File scanning, SHA-256 hashing, manifest JSON serialization |
| `api` | `cli/internal/api/` | HTTP client for the Fastest API (`client.go`) |
| `auth` | `cli/internal/auth/` | OS keychain token storage via `go-keyring` |
| `drift` | `cli/internal/drift/` | Drift computation between manifests |
| `conflicts` | `cli/internal/conflicts/` | Line-level three-way conflict detection |
| `dag` | `cli/internal/dag/` | Snapshot DAG traversal and merge-base (common ancestor) via BFS |
| `agent` | `cli/internal/agent/` | Local coding agent integration (Claude, Aider, etc.) |
| `ignore` | `cli/internal/ignore/` | `.fstignore` pattern matching |
| `store` | `cli/internal/store/` | Project-level workspace registry, atomic file I/O |
| `workspace` | `cli/internal/workspace/` | Workspace lifecycle, locking, snapshot operations |

### API (`api/`)

Hono application deployed as a Cloudflare Worker. Entry point is `api/src/index.ts`. Routes are mounted under `/v1/`:

| Route prefix | File | Purpose |
|-------------|------|---------|
| `/v1/auth` | `routes/auth.ts` | Google OAuth, `/me`, API key management |
| `/v1/oauth` | `routes/oauth.ts` | RFC 8628 device flow for CLI login |
| `/v1/projects` | `routes/projects.ts` | CRUD for projects |
| `/v1/workspaces` | `routes/workspaces.ts` | Workspace management |
| `/v1/snapshots` | `routes/snapshots.ts` | Snapshot creation and retrieval |
| `/v1/blobs` | `routes/blobs.ts` | Blob/manifest upload, download, presign, GC |
| `/v1/conversations` | `routes/conversations.ts` | Chat sessions (WebSocket via Durable Objects) |
| `/v1/action-items` | `routes/action-items.ts` | Background analysis action items |
| `/v1/infrastructure` | `routes/infrastructure.ts` | Deployment and infra provisioning |

Cloudflare bindings (defined in `Env` interface in `index.ts`):

- **D1** (`DB`) -- SQLite database for all metadata (schema in `api/src/db/schema.sql`)
- **R2** (`BLOBS`) -- Object storage for file blobs and manifests, keyed by `{user_id}/blobs/{hash}` and `{user_id}/manifests/{hash}.json`
- **Durable Objects** -- `Sandbox` (Cloudflare container sandbox) and `ConversationSession` (WebSocket chat)
- **Workers AI** (`AI`) -- Used for timeline summaries

Auth middleware is in `api/src/middleware/auth.ts`. It resolves a Bearer token to a user by hashing the token and looking up the `sessions` table.

### Web frontend (`web/`)

Vite + React app using TanStack Router. Entry point is `web/src/main.tsx`, router defined in `web/src/router.tsx`.

Key routes:

- `/login` -- Google OAuth sign-in
- `/device` -- Device code entry page (for CLI auth flow)
- `/` -- Home / conversation list
- `/$conversationId` -- Chat view with a workspace
- `/workspaces/$workspaceId` -- Workspace detail
- `/projects/$projectId` -- Project detail
- `/projects/$projectId/atlas` -- Code knowledge graph
- `/settings` -- User settings and API keys

### Shared types (`packages/shared/`)

TypeScript package `@fastest/shared` providing type definitions and manifest utilities used by both the API and web frontend. Core types are in `packages/shared/src/index.ts`; manifest logic is in `packages/shared/src/manifest/`.

## Data flow

```
CLI (local machine)
  |
  | HTTPS (Bearer token)
  |
  v
API (Cloudflare Worker)
  |-- D1 (metadata: users, projects, workspaces, snapshots)
  |-- R2 (blobs and manifests, user-scoped keys)
  |-- Durable Objects (sandbox containers, WebSocket sessions)
  |
  v
Web (browser)
  |
  | HTTPS (Bearer token)
  |
  v
API (same worker)
```

The CLI communicates with the API via `cli/internal/api/client.go`. The base URL defaults to `http://localhost:8787` and can be overridden with the `FST_API_URL` environment variable or the `api_url` field in `.fst/config.json`.
