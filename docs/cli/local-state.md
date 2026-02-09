# Local State Layout

How `fst` stores state on disk. Source: `cli/internal/config/config.go`, `cli/internal/store/`.

## Per-Workspace: `.fst/`

Created by `fst workspace init` or `fst project init` in the workspace root.

```
.fst/
  config.json       # Workspace configuration
  lock              # Exclusive flock for workspace-level locking
  author.json       # Optional project-level author identity (name, email)
  snapshots/        # Snapshot metadata files
    <id>.meta.json  # SnapshotMeta: ID, ManifestHash, Parents, Author, CreatedAt, Message
  manifests/        # Manifest files (file tree hashes)
    <hash>.json     # Manifest: map of relative paths to content hashes
  blobs/            # Content-addressed blob storage (project-scoped)
    <sha256-hash>   # Raw file content keyed by SHA-256 hash
  workspaces/       # Project-level workspace registry (project root only)
    <ws-id>.json    # Per-workspace metadata (name, path, snapshot IDs)
  stat-cache.json   # Stat cache for accelerating manifest generation
  export/           # Git export state (created by `fst git export`)
    git-map.json    # Snapshot ID <-> git commit SHA mapping
  .gitignore        # Auto-generated, ignores .fst internals
```

### `config.json` fields

```json
{
  "project_id": "uuid",
  "workspace_id": "uuid",
  "workspace_name": "my-workspace",
  "base_snapshot_id": "uuid",
  "current_snapshot_id": "uuid",
  "api_url": "https://...",
  "mode": ""
}
```

Defined as `ProjectConfig` in `cli/internal/config/config.go`. The `fork_snapshot_id` field is deprecated and migrated to `base_snapshot_id` on load.

## Global Config: `~/.config/fst/`

Respects `XDG_CONFIG_HOME`. Contains user-level state shared across all projects.

```
~/.config/fst/
  agents.json       # Preferred agent configuration
  author.json       # Global author identity (name, email)
  auth.json         # Authentication tokens (managed by login/logout)
```

### `agents.json` structure

```json
{
  "preferred_agent": "claude"
}
```

Source: `cli/internal/agent/agent.go`.

## `.fstignore`

Located at the workspace root (alongside `.fst/`). Created automatically by `fst workspace init` if not present. See [ignore.md](ignore.md) for pattern syntax. A default set of patterns is embedded into the binary from `cli/internal/ignore/default.fstignore`.

## Project root detection

`config.FindProjectRoot()` walks up from the current directory looking for a `.fst/` directory. This determines which workspace context commands operate in.
