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

All workspaces on a machine are tracked in a global index at `~/.config/fst/index.json` (respects `XDG_CONFIG_HOME`). The index contains both project and workspace entries:

```
{
  "version": 1,
  "projects": [{ "project_id", "project_name", "project_path", ... }],
  "workspaces": [{ "workspace_id", "workspace_name", "project_id", "path", "base_snapshot_id", ... }]
}
```

The registry enables cross-workspace commands like `fst drift` and `fst merge` to locate other workspaces by name. Entries include `last_seen_at` timestamps updated via `TouchWorkspace`.

Implementation: `cli/internal/index/index.go` (`Index`, `WorkspaceEntry`, `UpsertWorkspace`, `Load`, `Save`).

## Lifecycle

### Init (`fst workspace init`)

Creates a new workspace in the current directory:
1. Creates `.fst/` with `config.json`, `snapshots/`, `manifests/`
2. Creates `.fstignore` with default patterns if missing
3. Optionally creates an initial snapshot (`--no-snapshot` to skip)
4. Registers the workspace in the global index

Implementation: `cli/cmd/fst/commands/workspace.go` (`runInit`), `cli/internal/config/config.go` (`InitAt`).

### Create (`fst workspace create`)

Creates a new workspace directory under the current project folder. When run inside a project container (with `fst.json`), the workspace is linked to that project's ID and placed as a subdirectory.

Implementation: `cli/cmd/fst/commands/workspace.go` (`newWorkspaceCreateCmd`).

### Copy (`fst workspace copy`)

Creates an independent copy of the current workspace:
1. Copies all project files (respecting `.fstignore`) to a new directory
2. Initializes a new `.fst/` with a fresh workspace ID
3. Sets `base_snapshot_id` to the source workspace's latest snapshot
4. Copies the fork-point snapshot metadata and manifest to the new workspace
5. Registers the new workspace in the global index

Blobs are stored in the global cache (`~/.cache/fst/blobs/`), so copies share blob storage with no duplication.

Implementation: `cli/cmd/fst/commands/copy.go` (`runCopy`).

## Main Workspace

Each project can designate one workspace as the "main" workspace. This is stored server-side only in `projects.main_workspace_id` (see `api/src/db/schema.ts`). The main workspace serves as the default comparison target for `fst drift` when no workspace argument is given.

Set via: `fst workspace set-main [workspace-name]`

Implementation: `cli/cmd/fst/commands/workspace.go` (`runSetMain`), `cli/internal/api/client.go` (`SetMainWorkspace`).

## Workspace Status

`fst workspace` (no subcommand) displays current workspace info including name, ID, project, directory, base snapshot, mode, and drift summary.

`fst workspaces` lists all workspaces for the current project (or all projects with `--all`). It merges local registry data with cloud workspace data and shows location tags (local, cloud, or both), status (ok, missing, current, cloud), and drift summary.

Implementation: `cli/cmd/fst/commands/workspace.go` (`runWorkspaceStatus`, `runWorkspaces`).

## Storage

- Blobs: `.fst/blobs/` (project-scoped, shared across workspaces under the same project)
- Config/index: `~/.config/fst/` (respects `XDG_CONFIG_HOME`)

Implementation: `cli/internal/config/config.go` (`GetBlobsDir`, `GetBlobsDirAt`, `GetGlobalConfigDir`).

## Related Docs

- [Snapshots](snapshots.md) -- the immutable state records within workspaces
- [Drift](drift.md) -- detecting changes within a workspace
- [Merge](merge.md) -- merging changes between workspaces
- [Sync](sync.md) -- syncing workspace state with the cloud
