# Git Integration

Fastest can export workspace snapshot history to Git commits and import Git commit history back into workspaces. This enables interoperability with Git-based workflows, GitHub PRs, and CI systems.

## Commands

| Command                          | Description                                 |
|----------------------------------|---------------------------------------------|
| `fst git export`                 | Export snapshots to local Git commits       |
| `fst git import <repo-path>`     | Import Git commits into workspace snapshots |
| `fst github export <owner/repo>` | Export + push to a GitHub repository        |
| `fst github import <owner/repo>` | Clone + import from a GitHub repository     |

Implementation: `cli/cmd/fst/commands/git.go`, `cli/cmd/fst/commands/export.go`, `cli/cmd/fst/commands/import.go`, `cli/cmd/fst/commands/github.go`.

## Git Export

`fst git export` converts the workspace's snapshot chain into Git commits on a branch.

### Process

1. Build a topologically-sorted DAG of all snapshots reachable from `current_snapshot_id` (parent-before-child order via DFS with cycle detection)
2. For each snapshot in order:
   - Skip if already mapped to a Git commit (incremental export)
   - Restore files from the global blob cache into a temp working tree
   - Stage all files with `git add -A`
   - Resolve parent snapshot IDs to Git commit SHAs via the mapping
   - Create a Git commit with `git commit-tree`, preserving parent structure (merge commits get multiple `-p` flags)
   - Update the branch ref to point to the new commit
3. Record the snapshot-to-commit mapping in `.fst/export/git-map.json`
4. Update export metadata in `refs/fst/meta`

### Mapping File

The mapping at `.fst/export/git-map.json` tracks which snapshots have been exported:

```json
{
  "repo_path": "/path/to/workspace",
  "snapshots": {
    "snap-abc123...": "git-commit-sha...",
    "snap-def456...": "git-commit-sha..."
  }
}
```

This enables incremental exports -- subsequent runs only create commits for new snapshots.

### Commit Metadata

Snapshot metadata is preserved in Git commits:
- `created_at` becomes `GIT_AUTHOR_DATE` and `GIT_COMMITTER_DATE`
- `agent` field becomes the author name, with email as `{agent-slug}@fastest.local`
- `message` becomes the commit message (falls back to `"Snapshot {id}"`)
- Multi-parent snapshots (from merges) produce multi-parent Git commits

### Options

| Flag               | Description                                          |
|--------------------|------------------------------------------------------|
| `--branch` / `-b`  | Branch name (default: workspace name)                |
| `--include-dirty`  | Add uncommitted changes as a final commit            |
| `--message` / `-m` | Commit message for the dirty commit                  |
| `--init`           | Initialize git repo if it does not exist             |
| `--rebuild`        | Rebuild all commits from scratch (ignores mapping)   |

### Export Metadata

Export metadata is stored in a special Git ref `refs/fst/meta` containing `.fst-export/meta.json`:

```json
{
  "version": 1,
  "updated_at": "2025-01-15T10:30:00Z",
  "project_id": "proj-...",
  "workspaces": {
    "ws-abc": {
      "workspace_id": "ws-abc",
      "workspace_name": "main",
      "branch": "main"
    }
  }
}
```

This metadata is used by `fst git import` to discover which branches correspond to which workspaces.

## Git Import

`fst git import <repo-path>` converts Git commits back into workspace snapshots.

### Process

1. Load export metadata from `refs/fst/meta` in the Git repo
2. Determine target workspace(s) based on metadata, flags, and current directory context
3. For each target workspace:
   - List commits in topological order via `git rev-list --topo-order --reverse`
   - For each commit: checkout the tree, generate a manifest, cache blobs, create a snapshot with parent mappings
   - Agent name is recovered from the author email if it ends in `@fastest.local`
   - Set `current_snapshot_id` to the last imported snapshot, `base_snapshot_id` to the first
4. Register the workspace in the project-level workspace registry

### Options

| Flag               | Description                                          |
|--------------------|------------------------------------------------------|
| `--branch` / `-b`  | Branch to import (default: from export metadata)     |
| `--workspace` / `-w` | Target workspace name                              |
| `--project` / `-p` | Project name for new projects                        |
| `--rebuild`        | Overwrite existing snapshot history                  |

### Import Modes

The import adapts to the current directory context:
- **Inside a workspace**: imports into the current workspace (must match workspace name)
- **Inside a project folder**: imports workspaces as subdirectories
- **Bare directory**: creates a new project folder and imports all workspaces from metadata

## GitHub Export

`fst github export <owner/repo>` combines git export with pushing to GitHub:

1. Run `fst git export` to create/update local commits
2. Add or update the Git remote (default: `origin`)
3. Push the branch and `refs/fst/meta` to the remote
4. Optionally create the GitHub repo with `--create` (requires `gh` CLI)

Additional flags: `--push-all` (push all branches from export metadata), `--force-remote` (overwrite existing remote URL), `--create`/`--private` (create repo), `--no-gh` (disable `gh` CLI).

## GitHub Import

`fst github import <owner/repo>` clones a repo and runs git import:

1. Clone the repository to a temp directory (uses `gh repo clone` if available)
2. Fetch export metadata refs (`refs/fst/*`)
3. Run `fst git import` on the cloned repo

Supports the same `--branch`, `--workspace`, `--project`, and `--rebuild` flags as git import.

## Implementation Details

Git operations use a `gitEnv` struct that separates `GIT_DIR`, `GIT_WORK_TREE`, and `GIT_INDEX_FILE` to avoid modifying the user's working tree or index during export. All staging and commit-tree operations happen in a temporary directory.

Implementation: `cli/cmd/fst/commands/export.go` (`gitEnv`, `newGitEnv`, `createGitCommitWithParents`).

## Related Docs

- [Snapshots](snapshots.md) -- git export maps snapshots to commits
- [Workspaces](workspaces.md) -- git import creates/updates workspaces
- [Sync](sync.md) -- alternative to git for cloud synchronization
