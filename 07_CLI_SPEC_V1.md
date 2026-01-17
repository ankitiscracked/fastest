# fst CLI Specification

## Installation

```bash
# Build from source
cd cli && go build -o fst ./cmd/fst

# Or install via go
go install github.com/anthropics/fastest/cli/cmd/fst@latest
```

---

## Commands

### Auth

```bash
fst login                    # Log in to Fastest cloud
fst logout                   # Log out
fst whoami                   # Show current user
```

### Projects

```bash
fst init [name]              # Initialize new project
  --workspace, -w <name>     # Workspace name (default: main)
  --no-snapshot              # Don't create initial snapshot
  --force                    # Skip safety checks

fst projects                 # List your cloud projects
fst project [id]             # Show project details
```

### Workspaces

```bash
fst workspace                # Show current workspace status
fst workspaces               # List all workspaces for this project

fst copy                     # Create a linked workspace copy
  --name, -n <name>          # Name for new workspace (required)
  --to, -t <path>            # Target directory (default: sibling)
```

**Example:**
```bash
fst copy -n feature          # Creates ../myproject-feature
fst copy -n exp -t ~/tmp/exp # Creates ~/tmp/exp
```

### Snapshots

```bash
fst snapshot                 # Capture current state
  --message, -m <msg>        # Snapshot message

fst clone <project|snapshot> # Clone to new directory
  --to, -t <path>            # Target directory

fst log                      # Show snapshot history
  --limit, -n <num>          # Number of entries (default: 10)

fst rollback [snapshot-id]   # Restore files from snapshot
  --snapshot, -s <id>        # Snapshot to restore (default: base)
```

### Drift

```bash
fst drift                    # Show changes from base snapshot
  --json                     # Output as JSON
  --summary                  # Generate LLM summary (requires agent)
  --sync                     # Sync drift report to cloud
```

**Example output:**
```
Drift from base: +2 ~3 -1 (1.2 KB)

Added (2):
  + src/new-feature.ts
  + src/utils/helper.ts

Modified (3):
  ~ src/index.ts
  ~ src/api.ts
  ~ package.json

Deleted (1):
  - src/old-file.ts

Summary:
  Added new feature module with helper utilities. Updated API endpoints.
```

### Merge

```bash
fst merge <workspace>        # Merge from another workspace
  --from <path>              # Source path (instead of name lookup)
  --agent                    # Use AI for conflict resolution (default)
  --manual                   # Write conflict markers
  --theirs                   # Take source version for conflicts
  --ours                     # Keep target version for conflicts
  --files <list>             # Only merge specific files
  --dry-run                  # Show plan without making changes
```

**Conflict resolution modes:**
- `--agent` (default): Invokes Claude/Aider to intelligently merge
- `--manual`: Writes `<<<<<<<` conflict markers for manual editing
- `--theirs`: Takes source version for all conflicts
- `--ours`: Keeps target version for all conflicts

**Example:**
```bash
fst merge feature            # Merge 'feature' workspace
fst merge --from ../other    # Merge from path
fst merge feature --theirs   # Accept all their changes
fst merge feature --dry-run  # Preview only
```

### Export

```bash
fst export git               # Export snapshots to git
  --branch, -b <name>        # Branch name (default: workspace name)
  --include-drift            # Include uncommitted changes
  --message, -m <msg>        # Drift commit message
  --init                     # Initialize git repo if needed
  --rebuild                  # Rebuild all commits from scratch
```

**How it works:**
1. Each snapshot becomes a git commit
2. Workspace name becomes branch name
3. Mapping stored in `.fst/export/git-map.json`
4. Subsequent exports are incremental (only new snapshots)

**Example:**
```bash
fst export git --init        # First export, creates repo
fst export git               # Incremental export
fst export git --include-drift -m "WIP"  # Include uncommitted
```

### Agents

```bash
fst agents                   # List detected coding agents
fst agents set <name>        # Set preferred agent
```

**Supported agents:**
- `claude` — Claude Code CLI
- `aider` — Aider AI pair programming
- `cursor` — Cursor IDE
- `copilot` — GitHub Copilot CLI

Configuration stored in `~/.config/fst/agents.json`.

### Watch (Triaged)

```bash
fst watch                    # Watch for changes (daemon)
  --summarize                # Regenerate summaries periodically
```

> **Note:** Watch daemon is triaged for future implementation.

---

## Local State

### Main Workspace (`.fst/` directory)

```
.fst/
├── config.json              # Workspace configuration
├── cache/
│   ├── blobs/<sha256>       # Content-addressed file cache
│   └── manifests/
│       ├── <id>.json        # Manifest files
│       └── <id>.meta.json   # Snapshot metadata
├── workspaces/              # Linked workspace configs
│   └── <ws-id>/config.json
└── export/
    └── git-map.json         # Snapshot → git commit mapping
```

### Linked Workspace (`.fst` file)

```
main: /path/to/main/workspace
workspace_id: local-abc123
```

### Global Registry

`~/.config/fst/workspaces.json`:
```json
{
  "workspaces": [
    {
      "id": "ws-abc123",
      "project_id": "proj-xyz",
      "name": "main",
      "path": "/path/to/project",
      "base_snapshot_id": "snap-123",
      "created_at": "2024-01-15T10:00:00Z"
    }
  ]
}
```

---

## Ignore Rules

Default patterns (always ignored):
```
.fst/
.fst
.git/
.svn/
.hg/
node_modules/
__pycache__/
.DS_Store
Thumbs.db
*.pyc
*.pyo
*.class
*.o
*.obj
*.exe
*.dll
*.so
*.dylib
```

Custom patterns in `.fstignore` (gitignore syntax):
```
# Build outputs
dist/
build/
*.log

# Secrets
.env
*.key
```

---

## Safety Features

### Init Safety Checks
- Refuses home directory
- Refuses root directory
- Detects nested projects
- Warns on >5000 files
- `--force` to bypass

### Git Export Safety
- Won't overwrite uncommitted changes
- Mapping prevents duplicate commits
- `--rebuild` for fresh start
