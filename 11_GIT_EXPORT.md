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
fst export git               # Export snapshots to git
  --branch, -b <name>        # Branch name (default: workspace name)
  --include-drift            # Include uncommitted changes as commit
  --message, -m <msg>        # Commit message for drift
  --init                     # Initialize git repo if needed
  --rebuild                  # Rebuild all commits from scratch
```

## How It Works

### First Export
```bash
fst export git --init
```

1. Initialize git repo if needed
2. Build snapshot chain (walk parent references)
3. For each snapshot (oldest first):
   - Restore files from cached blobs
   - Stage all files
   - Create commit with snapshot message
   - Record snapshot→commit mapping
4. Save mapping to `.fst/export/git-map.json`

### Incremental Export
```bash
fst export git
```

1. Load existing mapping
2. Skip already-exported snapshots
3. Only create commits for new snapshots
4. Update mapping

### Including Drift
```bash
fst export git --include-drift -m "WIP changes"
```

After exporting snapshots, also commits current uncommitted changes.

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

## Examples

### Basic Export
```bash
cd myproject
fst export git --init

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
fst export git --branch feature-auth
```

### Re-export After More Snapshots
```bash
fst snapshot -m "Added tests"
fst export git

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
fst export git --include-drift -m "Work in progress"

# Output:
# ...
#   drift: exported → q7r8s9t0
# ✓ Exported 1 new commits to branch 'main'
```

### Fresh Rebuild
```bash
fst export git --rebuild

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
fst export git --branch main

cd ../myproject-feature
fst export git --branch feature
```

## Limitations

- **One-way**: No import from git
- **No merge**: Export only, git handles merging
- **Overwrites tree**: Each snapshot replaces working tree

## Safety

- Refuses if git has uncommitted changes (unless `--include-drift`)
- Mapping prevents duplicate commits
- `--rebuild` for intentional fresh start
