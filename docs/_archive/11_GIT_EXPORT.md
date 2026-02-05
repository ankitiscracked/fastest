# Git Export

## Why

- **Reliability**: Host on GitHub/GitLab as backup
- **Trust**: No lock-in to fst
- **Collaboration**: Share via standard git workflows
- **CI/CD**: Integrate with existing pipelines

## Unified Export Model

The export maps fst concepts to git:

| fst | git |
|-----|-----|
| Workspace name | Branch name |
| Snapshot chain | Commit history |
| Drift | Optional HEAD commit |
| Snapshot ID | Tracked in mapping file |

## Commands

```bash
fst git export               # Export snapshots to git
  --branch, -b <name>        # Branch name (default: workspace name)
  --include-dirty            # Include uncommitted changes as commit
  --message, -m <msg>        # Commit message for drift
  --init                     # Initialize git repo if needed
  --rebuild                  # Rebuild all commits from scratch
```

```bash
fst git import <repo-path>   # Import from a repo previously exported by fst
  --branch, -b <name>        # Branch to import (default: from export metadata)
  --workspace, -w <name>     # Target workspace name
  --project, -p <name>       # Project name when creating a new project
  --rebuild                  # Rebuild snapshots from scratch
```

## How It Works

### First Export
```bash
fst git export --init
```

1. Initialize git repo if needed
2. Build full snapshot DAG (walk all parent references)
3. For each snapshot (parents before children):
   - Restore files from cached blobs into a temporary work tree
   - Stage all files
   - Create commit with snapshot message
   - Record snapshot→commit mapping
4. Save mapping to `.fst/export/git-map.json`
5. Update metadata ref `refs/fst/meta` with `.fst-export/meta.json` (workspace↔branch map)

### Incremental Export
```bash
fst git export
```

1. Load existing mapping
2. Skip already-exported snapshots
3. Only create commits for new snapshots
4. Update mapping

### Including Drift
```bash
fst git export --include-dirty -m "WIP changes"
```

After exporting snapshots, also commits current uncommitted changes.

## Import

`fst git import` only accepts repos that contain the metadata ref created by export.
It reads `refs/fst/meta` and reconstructs snapshots from commit history, preserving
parent relationships and timestamps.

## Mapping File

`.fst/export/git-map.json`:
```json
{
  "repo_path": "/path/to/project",
  "snapshots": {
    "snap-abc123": "a1b2c3d4e5f6...",
    "snap-def456": "f6e5d4c3b2a1..."
  }
}
```

## Repo Metadata Ref

`refs/fst/meta` points to a commit containing `.fst-export/meta.json`:
```json
{
  "version": 1,
  "updated_at": "2026-02-02T00:00:00Z",
  "project_id": "proj-123",
  "workspaces": {
    "ws-abc": {
      "workspace_id": "ws-abc",
      "workspace_name": "main",
      "branch": "main"
    }
  }
}
```

## Examples

### Basic Export
```bash
cd myproject
fst git export --init

# Output:
# Initializing git repository...
# Found 3 snapshots to export
#   snap-001: exported → a1b2c3d4
#   snap-002: exported → e5f6g7h8
#   snap-003: exported → i9j0k1l2
# ✓ Exported 3 new commits to branch 'main'
```

### Export to Specific Branch
```bash
fst git export --branch feature-auth
```

### Re-export After More Snapshots
```bash
fst snapshot -m "Added tests"
fst git export

# Output:
# Found 4 snapshots to export
#   snap-001: already exported (commit a1b2c3d4)
#   snap-002: already exported (commit e5f6g7h8)
#   snap-003: already exported (commit i9j0k1l2)
#   snap-004: exported → m3n4o5p6
# ✓ Exported 1 new commits to branch 'main'
```

### Export with WIP Changes
```bash
# Make some changes...
fst git export --include-dirty -m "Work in progress"

# Output:
# ...
#   drift: exported → q7r8s9t0
# ✓ Exported 1 new commits to branch 'main'
```

### Fresh Rebuild
```bash
fst git export --rebuild

# Ignores existing mapping, recreates all commits
```

## Edge Cases

### No Git Repo
- Use `--init` to create one
- Or interactive prompt asks to initialize

### Missing Commits
If mapped commits are missing (e.g., repo was reset):
- Detected automatically
- Re-exports affected snapshots

### Multiple Workspaces
Each workspace can export to its own branch:
```bash
cd myproject
fst git export --branch main

cd ../myproject-feature
fst git export --branch feature
```

## Limitations

- **No merge**: Export only, git handles merging

## Safety

- Refuses if git has uncommitted changes (unless `--include-dirty`)
- Mapping prevents duplicate commits
- `--rebuild` for intentional fresh start
