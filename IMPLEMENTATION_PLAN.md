# Fastest Implementation Plan (Revised)

## Core Mental Model

```
                         ┌──────────────────────┐
                         │   Cloud (Project)    │
                         │   base: snapshot 01A │
                         └──────────┬───────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         ▼                          ▼                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│  Workspace 1    │      │  Workspace 2    │      │  Workspace 3    │
│  ~/proj/agent-a │      │  ~/proj/agent-b │      │  ~/proj/manual  │
│                 │      │                 │      │                 │
│  base: 01A      │      │  base: 01A      │      │  base: 01A      │
│  drift: +5,-2   │      │  drift: +2,~3   │      │  drift: +1      │
│  summary: "..." │      │  summary: "..." │      │  summary: "..." │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

**Primitives:**
- **Project** — identity container (lives in cloud)
- **Snapshot** — immutable project state (content-addressed)
- **Workspace** — local working copy tracking a fork snapshot
- **Drift** — changes from base to current local state
- **Drift Summary** — LLM-generated description of changes

---

## Stack

- **CLI**: Go (`fst`)
- **API**: Cloudflare Workers + Hono + D1 + R2
- **Web**: React + Vite + Tailwind CSS
- **Database**: Cloudflare D1 (SQLite)
- **Blob Storage**: Cloudflare R2
- **Package Manager**: Bun
- **LLM Summaries**: User's local agents (Claude Code, Aider, etc.)

---

## Monorepo Structure

```
fastest/
├── cli/                    # Go CLI (fst)
│   ├── cmd/fst/
│   │   ├── main.go
│   │   └── commands/
│   │       ├── root.go
│   │       ├── login.go
│   │       ├── projects.go
│   │       ├── workspace.go    # workspace create/list/switch
│   │       ├── snapshot.go
│   │       ├── drift.go        # drift detection + summary
│   │       ├── watch.go        # daemon for monitoring
│   │       ├── merge.go        # merge workflow
│   │       └── export.go
│   ├── internal/
│   │   ├── api/            # API client
│   │   ├── config/         # Config management
│   │   ├── manifest/       # Manifest generation
│   │   ├── ignore/         # Ignore rules
│   │   ├── auth/           # Token storage
│   │   ├── drift/          # Drift computation
│   │   ├── watcher/        # File system watcher
│   │   └── agent/          # Agent invocation (for summaries/merges)
│   └── go.mod
├── api/                    # Cloudflare Workers
│   ├── src/
│   │   ├── index.ts
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── projects.ts
│   │   │   ├── snapshots.ts
│   │   │   ├── workspaces.ts   # workspace registry
│   │   │   └── blobs.ts
│   │   ├── db/schema.sql
│   │   └── types.ts
│   ├── wrangler.toml
│   └── package.json
├── web/                    # React + Vite
│   ├── src/
│   │   ├── pages/
│   │   │   ├── Projects.tsx
│   │   │   ├── ProjectDetail.tsx
│   │   │   ├── Workspaces.tsx      # view all workspaces
│   │   │   └── WorkspaceDetail.tsx # drift view + merge UI
│   │   └── components/
│   └── package.json
├── packages/shared/        # Shared types
└── package.json
```

---

## CLI Commands (Complete)

### Auth
- `fst login` / `fst logout` / `fst whoami`

### Projects
- `fst init [name]` — create project + first workspace
- `fst projects` — list cloud projects
- `fst project [id]` — show project detail

### Workspaces
- `fst workspace create [--base <snapshot_id>] [--to <dir>]` — spawn new workspace
- `fst workspaces` — list all workspaces for current project
- `fst workspace` — show current workspace status

### Snapshots
- `fst snapshot` — capture current state as snapshot
- `fst clone <project|snapshot> [--to dir]` — clone into new workspace

### Drift
- `fst drift` — show file-level diff from base
- `fst drift --summary` — invoke agent to generate natural language summary
- `fst drift --json` — machine-readable drift output

### Watch (Daemon)
- `fst watch` — start daemon, monitor changes, update drift continuously
- `fst watch --summarize` — also regenerate summaries periodically
- Daemon syncs drift status to cloud for Web UI visibility

### Merge
- `fst merge <source_workspace>` — merge changes from another workspace
- `fst merge <source_workspace> --agent` — use agent to resolve conflicts
- `fst merge <source_workspace> --manual` — show conflicts for manual resolution
- `fst merge --cherry-pick <files...>` — merge specific files only

### Export
- `fst export git [--snapshot <id>] [--repo <path>]`

---

## Database Schema (D1)

```sql
-- users
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

-- projects
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_snapshot_id TEXT
);

-- snapshots
CREATE TABLE snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  manifest_hash TEXT NOT NULL,
  parent_snapshot_id TEXT,
  source TEXT DEFAULT 'cli',
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, manifest_hash)
);

-- workspaces (registered with cloud for visibility)
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,                    -- e.g., "agent-a", "manual-fixes"
  machine_id TEXT,                       -- identifies the machine
  fork_snapshot_id TEXT REFERENCES snapshots(id),
  current_snapshot_id TEXT REFERENCES snapshots(id),
  local_path TEXT,                       -- where it lives on that machine
  last_seen_at TEXT,                     -- last heartbeat from daemon
  created_at TEXT DEFAULT (datetime('now'))
);

-- drift_reports (synced from CLI for Web visibility)
CREATE TABLE drift_reports (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  files_added INTEGER DEFAULT 0,
  files_modified INTEGER DEFAULT 0,
  files_deleted INTEGER DEFAULT 0,
  bytes_changed INTEGER DEFAULT 0,
  summary TEXT,                          -- LLM-generated description
  reported_at TEXT DEFAULT (datetime('now'))
);

-- activity_events
CREATE TABLE activity_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  workspace_id TEXT,
  actor TEXT NOT NULL,
  type TEXT NOT NULL,
  snapshot_id TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

---

## Phase 1: Scaffolding

### Deliverables
- Bun workspace with cli/, api/, web/, packages/shared/
- Go CLI skeleton: `fst --help`, `fst version`
- API: health endpoint
- Web: login page stub with Tailwind

### Exit Criteria
- `fst --help` works
- API health returns OK
- Web renders

---

## Phase 2: Auth

### Deliverables
- D1 schema: users, auth_codes, sessions
- Magic link flow (email → code → token)
- CLI: `fst login`, `fst logout`, `fst whoami`
- Web: login + code entry pages

### Exit Criteria
- Login works end-to-end (CLI + Web)

---

## Phase 3: Projects + Workspaces (Foundation)

### Deliverables
- D1 schema: projects, workspaces
- API: project CRUD, workspace registration
- CLI: `fst init`, `fst projects`, `fst workspace create`, `fst workspaces`
- Web: projects list, project detail with workspaces

### Local State (`.fst/`)
```
.fst/
├── config.json         # { project_id, workspace_id, fork_snapshot_id, current_snapshot_id }
├── workspace.json      # { name, machine_id, created_at }
├── manifests/          # <manifest_hash>.json
└── snapshots/          # <snapshot_id>.meta.json
```

### Exit Criteria
- Create project → spawn multiple workspaces → see all in Web UI

---

## Phase 4: Snapshots + Blob Store

### Deliverables
- Manifest format (canonical JSON, SHA-256)
- Ignore rules (.fstignore)
- R2 bucket setup
- API: blob exists, presign upload/download, snapshot registration
- CLI: `fst snapshot`, `fst clone`

### Exit Criteria
- Snapshot from workspace A, clone to workspace B = identical

---

## Phase 5: Drift Detection

### Deliverables
- Drift computation: compare current state to fork snapshot manifest
- CLI: `fst drift` (shows added/modified/deleted files)
- Drift report structure:
  ```json
  {
    "fork_snapshot_id": "01ABC",
    "files_added": ["src/new.ts"],
    "files_modified": ["src/index.ts"],
    "files_deleted": ["src/old.ts"],
    "total_bytes_changed": 12345
  }
  ```

### Exit Criteria
- `fst drift` accurately shows changes from base

---

## Phase 6: LLM Drift Summaries

### Deliverables
- Agent invocation system (detect installed agents: claude, aider, etc.)
- CLI: `fst drift --summary`
- Agent prompt template for summarization
- Config: `~/.config/fst/agents.json` (which agent to use)

### Agent Invocation Flow
```
1. Compute drift (added/modified/deleted files)
2. Generate diff context (file contents before/after)
3. Invoke agent with prompt:
   "Summarize these changes in 2-3 sentences:
    [diff context]"
4. Parse agent output as summary
5. Store locally + sync to cloud
```

### Exit Criteria
- `fst drift --summary` returns natural language like:
  "Added user authentication with JWT tokens. Refactored database layer to use connection pooling."

---

## Phase 7: Watch Daemon

### Deliverables
- File system watcher (fsnotify in Go)
- Daemon mode: `fst watch`
- Periodic drift recomputation
- Optional periodic summarization: `fst watch --summarize`
- Cloud sync: POST drift report to API every N seconds

### Daemon Behavior
```
1. Watch for file changes (debounced)
2. On change: recompute drift
3. If --summarize: regenerate summary every 60s (configurable)
4. Sync drift report to cloud
5. Web UI polls/subscribes to see updates
```

### Exit Criteria
- `fst watch` running → make changes → Web UI shows updated drift

---

## Phase 8: Merge Workflow

### Deliverables
- CLI: `fst merge <source_workspace>`
- Conflict detection: files modified in both source and target
- Agent-assisted merge: invoke agent to resolve conflicts
- Manual fallback: show diff, let user choose

### Merge Flow
```
1. User runs: fst merge workspace-2
2. CLI fetches source workspace's current state (or latest snapshot)
3. Compute 3-way diff: base ↔ target ↔ source
4. Non-conflicting changes: apply automatically
5. Conflicts:
   a. --agent (default): invoke agent with both versions, ask for resolution
   b. --manual: show conflict markers, user resolves
6. After resolution: commit as new snapshot
```

### Agent Merge Prompt
```
These two versions of [filename] conflict.
Base version: [content]
Version A (target): [content]
Version B (source): [content]

Merge them intelligently, preserving the intent of both changes.
Output the merged file content only.
```

### Exit Criteria
- Merge non-conflicting changes automatically
- Agent resolves conflicts when invoked
- Manual mode shows clear diff for user resolution

---

## Phase 9: Web UI (Complete)

### Pages
1. **Projects List** — all projects, last activity
2. **Project Detail** — project info, all workspaces, snapshots
3. **Workspaces View** — see all active workspaces with:
   - Fork snapshot
   - Current drift (files added/modified/deleted)
   - Last summary
   - Last seen (heartbeat)
4. **Workspace Detail** — full drift view, file list, merge button
5. **Merge UI** — initiate merge from web (triggers CLI command instructions)

### Exit Criteria
- View all workspaces and their drift from phone/browser
- See live updates as agents work

---

## Phase 10: Git Export + Polish

### Deliverables
- `fst export git` (snapshot → git commit)
- Error messages and recovery
- Homebrew formula
- README + docs

---

## Verification Plan

1. **Scaffolding**: `fst --help`, health check, web renders
2. **Auth**: Login flow works (CLI + Web)
3. **Projects + Workspaces**: Create project, spawn 3 workspaces, see all in Web
4. **Snapshots**: Push from workspace A, clone to B, verify identical
5. **Drift**: Make changes, `fst drift` shows accurate diff
6. **Summaries**: `fst drift --summary` returns natural language
7. **Watch**: Daemon running, Web shows live drift updates
8. **Merge**: Merge workspace B into A, conflicts resolved by agent
9. **End-to-end**: 3 agents working in parallel, all visible in Web, merge best parts

---

## Open Decisions

1. **Agent detection**: How to discover installed agents? (check PATH for `claude`, `aider`, etc.)
2. **Summary frequency**: How often to regenerate summaries in watch mode? (default: 60s)
3. **Merge source**: Pull from other workspace's local state or its latest snapshot?
4. **Web real-time**: Polling vs WebSocket for live drift updates?
