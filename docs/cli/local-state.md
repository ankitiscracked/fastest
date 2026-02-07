# Local State Layout

How `fst` stores state on disk. Source: `cli/internal/config/config.go`, `cli/internal/index/index.go`.

## Per-Workspace: `.fst/`

Created by `fst workspace init` or `fst project init` in the workspace root.

```
.fst/
  config.json       # Workspace configuration
  author.json       # Optional project-level author identity (name, email)
  snapshots/        # Snapshot metadata files
    <id>.meta.json  # SnapshotMeta: ID, ManifestHash, Parents, Author, CreatedAt, Message
  manifests/        # Manifest files (file tree hashes)
    <hash>.json     # Manifest: map of relative paths to content hashes
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

Respects `XDG_CONFIG_HOME`. Contains cross-workspace state.

```
~/.config/fst/
  index.json        # Workspace and project registry
  agents.json       # Preferred agent configuration
  author.json       # Global author identity (name, email)
  auth.json         # Authentication tokens (managed by login/logout)
```

### `index.json` structure

Version 1 format. Migrates automatically from legacy `workspaces.json`.

```json
{
  "version": 1,
  "projects": [
    {
      "project_id": "uuid",
      "project_name": "my-project",
      "project_path": "/path/to/project",
      "created_at": "2024-01-01T00:00:00Z",
      "last_seen_at": "2024-01-01T00:00:00Z",
      "local_only": false
    }
  ],
  "workspaces": [
    {
      "workspace_id": "uuid",
      "workspace_name": "my-workspace",
      "project_id": "uuid",
      "path": "/path/to/workspace",
      "base_snapshot_id": "uuid",
      "created_at": "2024-01-01T00:00:00Z",
      "last_seen_at": "2024-01-01T00:00:00Z",
      "machine_id": "hostname",
      "local_only": false
    }
  ]
}
```

Source: `cli/internal/index/index.go`.

### `agents.json` structure

```json
{
  "preferred_agent": "claude"
}
```

Source: `cli/internal/agent/agent.go`.

## Global Cache: `~/.cache/fst/`

Respects `XDG_CACHE_HOME`. Contains content-addressable blob storage.

```
~/.cache/fst/
  blobs/
    <sha256-hash>   # File contents keyed by SHA-256 hash
```

Blobs are populated during `fst snapshot` and read during `fst rollback` and `fst clone`. Each blob is the raw file content stored under its SHA-256 digest.

## `.fstignore`

Located at the workspace root (alongside `.fst/`). Created automatically by `fst workspace init` if not present. See [ignore.md](ignore.md) for pattern syntax. A default set of patterns is embedded into the binary from `cli/internal/ignore/default.fstignore`.

## Project root detection

`config.FindProjectRoot()` walks up from the current directory looking for a `.fst/` directory. This determines which workspace context commands operate in.
