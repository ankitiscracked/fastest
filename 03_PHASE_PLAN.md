# Implementation Plan

## Status Overview

| Phase | Status | Description |
|-------|--------|-------------|
| A | ✓ Complete | Scaffolding |
| B | ✓ Complete | Auth |
| C | ✓ Complete | Projects |
| D | ✓ Complete | Snapshot format |
| E | ✓ Complete | Blob store + snapshots |
| F | ✓ Complete | Status sync |
| G | ✓ Complete | Git export |
| H | ✓ Complete | Local-only mode |
| I | In Progress | UX polish + packaging |
| + | ✓ Complete | Workspaces |
| + | ✓ Complete | Drift detection |
| + | ✓ Complete | LLM summaries |
| + | Triaged | Watch daemon |
| + | ✓ Complete | Merge workflow |

---

## Phase A — Scaffolding ✓

### Deliverables
- Monorepo: `cli/`, `api/`, `web/`, `packages/shared/`
- Go CLI skeleton
- API health endpoint
- Web login page stub

### Completed
- `fst --help` works
- API health returns OK
- Web renders

---

## Phase B — Auth ✓

### Deliverables
- Magic-link + one-time code auth
- Token storage (keychain/file)
- CLI: `fst login`, `fst logout`, `fst whoami`

### Completed
- Web login creates session
- CLI obtains token and can call API

---

## Phase C — Projects ✓

### Deliverables
- API: project CRUD
- CLI: `fst workspace init`, `fst projects`, `fst project`
- Web: projects list

### Completed
- Create in CLI → visible in Web
- Create in Web → visible in CLI

---

## Phase D — Snapshot Format ✓

### Deliverables
- Manifest schema (JSON, SHA-256)
- Ignore rules (`.fstignore`)
- Deterministic hashing

### Completed
- Identical trees produce identical hashes

---

## Phase E — Blob Store + Snapshots ✓

### Deliverables
- R2 blob storage
- API: presign upload/download, snapshot registration
- CLI: `fst snapshot`, `fst clone`

### Completed
- Push from machine A, clone on machine B = identical

---

## Phase F — Status Sync ✓

### Deliverables
- Project status in API
- Web shows last updated + activity

### Completed
- After `fst snapshot`, Web updates

---

## Phase G — Git Export ✓

### Deliverables
- `fst export git` command
- Snapshot chain → commit history
- Incremental exports via mapping

### Completed
- Full snapshot history exports
- Workspace → branch mapping
- Optional drift commit

---

## Phase H — Local-Only Mode ✓

### Deliverables
- Full functionality without cloud
- Local snapshot store
- Seamless cloud migration later

### Completed
- All commands work offline
- No `--local` flags needed

---

## Phase I — UX Polish (In Progress)

### Deliverables
- Homebrew install
- Error messages and recovery
- Mobile-friendly Web UI

---

## Additional Phases (Post-v1)

### Workspaces ✓

- `fst workspace`, `fst workspaces`
- `fst workspace copy` for linked workspaces
- Git worktree-like model (shared blob cache)
- Global workspace registry

### Drift Detection ✓

- `fst drift` — show changes from base
- `fst drift --json` — machine-readable output
- `fst drift --sync` — sync to cloud

### LLM Summaries ✓

- Agent detection (claude, aider, cursor, copilot)
- `fst drift --agent-summary` — AI-generated change description
- Configuration at `~/.config/fst/agents.json`

### Watch Daemon (Triaged)

- `fst watch` — monitor file changes
- Periodic drift recomputation
- Cloud sync for Web visibility

> Triaged: Users can run `fst drift` manually. Will revisit after Web UI.

### Merge Workflow ✓

- `fst merge <workspace>` — 3-way merge
- Conflict resolution modes:
  - default — AI-assisted
  - `--manual` — conflict markers
  - `--theirs` / `--ours` — prefer one side
- Dry-run with `--dry-run`

---

## Milestone: v1 Complete

You can:
- Create projects in CLI or Web
- Create multiple workspaces per project
- Push snapshots from CLI
- View status and snapshots in Web
- Detect drift with LLM summaries
- Merge changes between workspaces
- Export full history to Git
