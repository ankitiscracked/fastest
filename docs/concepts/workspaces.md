# Workspaces

A workspace is the fundamental unit of work in Fastest. Each workspace is a directory containing project files and a `.fst/` metadata directory that tracks snapshots, manifests, and configuration.

## Local Configuration

Each workspace stores its config at `.fst/config.json` as a `ProjectConfig`:

| Field               | Description                                      |
|---------------------|--------------------------------------------------|
| `project_id`        | ID of the project this workspace belongs to      |
| `workspace_id`      | Unique ID for this workspace                     |
| `workspace_name`    | Human-readable name                              |
| `base_snapshot_id`  | The snapshot this workspace was forked from       |
| `current_snapshot_id` | The most recent snapshot (auto-derived if empty)|
| `mode`              | `"local"` or `"cloud"`                           |
| `api_url`           | Optional API URL override                        |

The `.fst/` directory also contains:
- `snapshots/` -- snapshot `.meta.json` files
- `manifests/` -- manifest JSON files (keyed by content hash)
- `.gitignore` -- ignores snapshots/manifests from git

Implementation: `cli/internal/config/config.go` (`ProjectConfig`, `Load`, `Save`, `InitAt`).

## Workspace Registry

All workspaces within a project are tracked in a project-level registry at `.fst/workspaces/<workspace-id>.json` (stored in the project root's `.fst/` directory). Each file contains a single workspace's metadata:

```json
{
  "workspace_id": "ws-abc123",
  "workspace_name": "feature-x",
  "path": "/path/to/feature-x",
  "base_snapshot_id": "snap-123",
  "current_snapshot_id": "snap-456",
  "created_at": "2025-01-01T00:00:00Z"
}
```

The registry enables cross-workspace commands like `fst drift` and `fst merge` to locate other workspaces by name. Per-workspace files avoid concurrent write conflicts when multiple workspaces operate in parallel.

Implementation: `cli/internal/store/` (`Store`, `WorkspaceInfo`, `RegisterWorkspace`, `FindWorkspaceByName`).

## Lifecycle

### Init (`fst workspace init`)

Creates a new workspace in the current directory:
1. Creates `.fst/` with `config.json`, `snapshots/`, `manifests/`
2. Creates `.fstignore` with default patterns if missing
3. Optionally creates an initial snapshot (`--no-snapshot` to skip)
4. Registers the workspace in the project-level workspace registry

Implementation: `cli/cmd/fst/commands/workspace.go` (`runInit`), `cli/internal/config/config.go` (`InitAt`).

### Create (`fst workspace create`)

Creates a new workspace directory under the current project folder. Forks from the source workspace's latest snapshot with all files copied. The new workspace is linked to the project's ID and placed as a subdirectory.

Implementation: `cli/cmd/fst/commands/workspace.go` (`newWorkspaceCreateCmd`).

## Main Workspace

Each project can designate one workspace as the "main" workspace. This is stored server-side only in `projects.main_workspace_id` (see `api/src/db/schema.ts`). The main workspace serves as the default comparison target for `fst drift` when no workspace argument is given.

Set via: `fst workspace set-main [workspace-name]`

Implementation: `cli/cmd/fst/commands/workspace.go` (`runSetMain`), `cli/internal/api/client.go` (`SetMainWorkspace`).

## Workspace Status

`fst status` displays current workspace info including name, ID, path, mode, snapshots, upstream, and change summary.

`fst workspaces` lists all workspaces for the current project (or all projects with `--all`). It merges local registry data with cloud workspace data and shows location tags (local, cloud, or both), status (ok, missing, current, cloud), and drift summary.

Implementation: `cli/cmd/fst/commands/status.go` (`runStatus`), `cli/cmd/fst/commands/workspace.go` (`runWorkspaces`).

## Storage

- Blobs: `.fst/blobs/` (project-scoped, shared across workspaces under the same project)
- Global config: `~/.config/fst/` (respects `XDG_CONFIG_HOME`) — agent preferences, author identity, auth tokens

Implementation: `cli/internal/config/config.go` (`GetBlobsDir`, `GetBlobsDirAt`, `GetGlobalConfigDir`).

## Related Docs

- [Snapshots](snapshots.md) -- the immutable state records within workspaces
- [Drift](drift.md) -- detecting changes within a workspace
- [Merge](merge.md) -- merging changes between workspaces
- [Sync](sync.md) -- syncing workspace state with the cloud
