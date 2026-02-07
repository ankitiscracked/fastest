# Refactoring Notes

Observations on CLI code structure and layering, with concrete next steps.

## Design Principles

Inspired by jj's architecture, applied to fst:

1. **Separation of logic and UI.** It should be easy to create new frontends (CLI, TUI, server) without duplicating workflow logic. Today `merge.go`, `export.go`, and `snapshot.go` are both the algorithm and the CLI — a TUI or API server would have to reach into command internals.

2. **Easy-to-use APIs.** Writing a new command should not require manually orchestrating auto-snapshots, merge parent tracking, cloud uploads, stat cache population, or lock management. Those should be handled by the library layer.

3. **As few states as possible.** Intermediate state files like `merge-parents.json` (exists between merge and snapshot) create failure windows. Operations should be atomic where possible.

4. **Incredibly hard to lose work.** Auto-snapshots before destructive operations should be an invariant enforced by the library, not opt-in per command.

5. **Safe concurrent modifications.** Two commands running simultaneously should not corrupt `.fst/` state. A locking mechanism is needed.

## Storage Model

Understanding the two-level storage is critical to getting the abstraction right.

```
project-root/
  fst.json                        # project identity (project_id, project_name)
  .fst/
    snapshots/                    # SHARED — all workspaces write here
    manifests/                    # SHARED — all workspaces write here
    blobs/                        # SHARED — all workspaces write here
  workspace-a/
    .fst/
      config.json                 # workspace-local (workspace_id, current_snapshot_id, base_snapshot_id)
      stat-cache.json             # workspace-local (performance cache)
      merge-parents.json          # workspace-local (temporary merge state)
      author.json                 # workspace-local (optional author override)
  workspace-b/
    .fst/
      config.json
      stat-cache.json
```

Key facts:
- **Snapshots, manifests, and blobs are project-scoped.** `GetSnapshotsDirAt` walks up to find `fst.json` and returns the project-level `.fst/snapshots/`. Multiple workspaces read and write the same snapshot DAG and blob store.
- **Config, stat cache, and merge parents are workspace-scoped.** Each workspace has its own `.fst/config.json` tracking its head (`current_snapshot_id`).
- **Standalone workspaces** (no parent `fst.json`) store everything in their own `.fst/`. The `FindParentRootFrom` fallback handles this.
- **Cross-workspace operations** (merge, drift, diff) read from the other workspace's config to find its head snapshot, then read snapshot/manifest data from the shared project store.

## The Library Layer

The central refactoring is introducing two packages that own state transitions:

### `cli/internal/store/` — project-level shared store

Owns the project-level `.fst/` directory: snapshots, manifests, and blobs. This is the DAG.

```go
// Open loads a project store from the project root (where fst.json lives).
// Acquires a project-level lock since multiple workspaces write here concurrently.
store, err := store.Open(projectRoot)
defer store.Close()

// Read operations
store.LoadSnapshotMeta(id)         // read a snapshot's metadata
store.LoadManifest(hash)           // read a manifest by hash
store.ReadBlob(hash)               // read a blob by hash
store.GetMergeBase(headA, headB)   // DAG traversal for common ancestor
store.WalkChain(head, limit)       // walk snapshot history

// Write operations
store.WriteSnapshot(meta)          // write snapshot metadata
store.WriteManifest(m)             // write manifest, return hash
store.WriteBlob(hash, content)     // write blob to store
store.ResolveSnapshotID(prefix)    // prefix resolution
```

The store is where the locking matters most — two workspaces snapshotting concurrently both write to the same `snapshots/` and `blobs/` directories. However, since snapshots and blobs are content-addressed (write-once, never mutated), concurrent writes to different files are naturally safe. The lock is primarily needed for operations that read-then-write non-content-addressed state (like history rewriting).

### `cli/internal/workspace/` — workspace-level operations

Owns a single workspace's `.fst/config.json`, stat cache, and merge state. References a `store` for reading/writing snapshots and blobs.

```go
// Open loads workspace state and its parent project store.
ws, err := workspace.Open(workspacePath)
defer ws.Close()

// High-level operations that handle all bookkeeping internally.
ws.Snapshot(message, opts)      // generate manifest, cache blobs (via store), write snapshot meta (via store), update config, populate stat cache
ws.Merge(target, mode)          // auto-snapshot, find merge base (via store), detect conflicts, apply resolution, create merge snapshot — no merge-parents.json
ws.Rollback(snapshotID, files)  // auto-snapshot, restore from blob store
ws.Export(gitOpts)              // read snapshot chain from store, write git commits
ws.Import(repoPath, opts)       // read git commits, write snapshots to store
```

### Relationship

```
commands/        → workspace/      → store/
(CLI wiring)       (workflows)       (DAG + blobs)
                   (workspace state)
                 → manifest/       (file hashing, diffing)
                 → conflicts/      (3-way conflict detection)
                 → drift/          (change analysis)
                 → agent/          (external agent invocation)
```

Commands call `workspace.Open()`. The workspace internally opens the project store via `FindParentRootFrom`. Commands never touch the store directly.

### What each layer internalizes

| Concern | Today | With `store` + `workspace` |
|---------|-------|----------------------------|
| Auto-snapshot before destructive ops | Each command calls `CreateAutoSnapshot` | `ws.Merge`, `ws.Rollback` do it automatically |
| Merge parent tracking | Commands write/read `merge-parents.json` | Internal to `ws.Merge` — no intermediate file |
| Stat cache population | Each snapshot call site does `BuildStatCacheFromManifest` | Internal to `ws.Snapshot` |
| Cloud upload after snapshot | `snapshot.go` manually calls upload helpers | Optional callback or mode on `ws.Snapshot` |
| Project store locking | None (concurrent corruption possible) | `store.Open` handles locking for write operations |
| Config update | Each command calls `config.Save` | Internal to workspace operations |
| Snapshot/manifest/blob I/O | Commands call `config.GetSnapshotsDirAt` and do raw file reads | `store` provides typed read/write methods |

### What stays outside

- **CLI parsing and output formatting** — stays in `commands/`
- **TUI rendering and state machine** — stays in `commands/ui.go`
- **HTTP API client** — stays in `api/`
- **Agent invocation** — stays in `agent/` (called by `workspace` for merge conflict resolution)
- **Ignore patterns** — stays in `ignore/`

### Migration path

Incremental approach:

1. Create `store/` — wrap the existing project-level snapshot/manifest/blob I/O that's currently scattered across `config.GetSnapshotsDirAt` + raw `os.ReadFile` in commands
2. Create `workspace/` with `Open`/`Close` — loads config, opens parent store
3. Move `Snapshot` workflow into `workspace` first (most self-contained, called from many places)
4. Move `Merge` next (eliminates `merge-parents.json` state)
5. Move `Rollback`, then `Export`/`Import` as needed
6. Commands shrink as logic moves into `workspace/`

## Immediate Cleanups

These are independent of the library layer and can be done now.

### 1. Move workspace registry types to `index/`

**Priority: high (concrete layering violation)**

`workspace.go` defines `RegisteredWorkspace`, `WorkspaceRegistry`, and their CRUD operations (`RegisterWorkspace`, `FindWorkspaceByName`, `LoadRegistry`, `SaveRegistry`, etc.). These are called from `clone.go`, `copy.go`, `init`, and other commands — they're data access logic living in the presentation layer.

Move to `cli/internal/index/` alongside the existing `index.go` which already manages the underlying `index.json` storage.

**Files affected:**
- `cli/cmd/fst/commands/workspace.go` — extract types and functions
- `cli/internal/index/index.go` — receive the extracted code
- All commands that call `RegisterWorkspace`, `LoadRegistry`, etc.

### 2. Split `config/` when it grows further

**Priority: low (coherent today, watch for growth)**

`config/` currently handles project root discovery, config I/O, directory paths, snapshot metadata loading, snapshot ID computation, author resolution, store migration, and merge parent tracking. ~700 lines, all touching `.fst/`.

**Natural split if needed:** `config/` (project config, paths, author) + the new `store/` package absorbs snapshot metadata loading, ID computation/verification, and manifest/blob path resolution.

### 3. Reduce lateral dependencies in the command layer

**Priority: low (cosmetic, resolves itself with the library layer)**

`ui.go` calls into other command-layer functions like `getWorkspaceChanges`. Commands share helpers via `id_resolve.go`, `api_helpers.go`, `util.go`, `init_snapshot.go`. These create lateral coupling within the command layer. Most of this resolves naturally when workflows move to `workspace/`.

## Locking Design

Two levels of locking, matching the two-level storage:

### Project store lock

```
project-root/.fst/lock
```

Needed for write operations to the shared store (snapshot creation, history rewriting, blob caching). Content-addressed writes (blobs, manifests) are naturally idempotent — writing the same hash twice is safe. The lock is primarily needed for:
- History rewriting (drop, squash, rebase) — reads and mutates snapshot metadata
- Any future GC operations — deletes orphaned blobs/snapshots

Snapshot creation writes content-addressed files (safe for concurrent writes to different files) and then updates workspace-local config (not shared). This means concurrent snapshots from different workspaces may not strictly need the project lock, but it's safer to acquire it.

### Workspace lock

```
workspace-root/.fst/lock
```

Needed for operations that mutate workspace-local state (`config.json`, `stat-cache.json`). Prevents two commands from modifying the same workspace simultaneously.

### Implementation

- Create lock with `O_CREATE|O_EXCL` (atomic, fails if exists)
- Store PID in the lock file for stale lock detection
- If a lock exists with a dead PID, it can be safely removed
- Read-only operations (status, drift, log, diff) skip locking — they operate on immutable snapshot data and the stat cache (which tolerates races gracefully)

## State Reduction

Intermediate state files that could be eliminated:

| File | Scope | Purpose | Elimination |
|------|-------|---------|-------------|
| `merge-parents.json` | workspace | Tracks pending merge parents between `merge` and `snapshot` | `ws.Merge` creates the merge snapshot atomically — no intermediate file |
| `stat-cache.json` | workspace | Performance cache for manifest generation | Keep — it's a cache, not state. Missing/corrupt is handled gracefully |
| `config.json` | workspace | Workspace head pointer and identity | Keep — this is primary state, not intermediate |
| `fst.json` | project | Project identity | Keep — this is primary state |
