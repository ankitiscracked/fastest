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
fst projects                 # List your cloud projects
fst projects show [id|name]  # Show project details
fst project init [name]      # Initialize a project folder (fst.json); defaults to current folder name, workspace becomes main
  --keep-name                # Keep current workspace folder name instead of "main"
  --force                    # Skip safety checks (use with caution)
  # Not allowed inside an existing project folder; run from a plain or workspace folder.
fst project create <name>    # Create a new project folder with a main workspace
  --path <dir>               # Parent directory to create the project under
  --no-snapshot              # Don't create initial snapshot
  --force                    # Skip safety checks (use with caution)
```

**Location tags (LOC):**
- `local` = present on this machine
- `cloud` = listed in cloud
- `local+cloud` = present on this machine and listed in cloud

### Workspaces

```bash
fst workspace                # Show current workspace status
fst workspaces               # List all workspaces for this project
fst workspace init [name]    # Initialize a workspace in current directory (requires project folder)
  --workspace, -w <name>     # Workspace name (must match directory name)
  --no-snapshot              # Don't create initial snapshot
  --force                    # Skip safety checks

fst workspace create [workspace-name]
                           # Create a workspace under the project folder
fst workspace set-main [workspace]
                           # Set main workspace for drift comparisons

fst workspace copy           # Create a linked workspace copy
  --name, -n <name>          # Name for new workspace (required)
  --to, -t <path>            # Target directory (default: sibling)
```

**Example:**
```bash
fst workspace copy -n feature          # Creates ../myproject-feature
fst workspace copy -n exp -t ~/tmp/exp # Creates ~/tmp/exp
```

### Snapshots

```bash
fst snapshot                 # Capture current state
  --message, -m <msg>        # Snapshot message
  --agent-summary            # Generate message using local coding agent
  --agent <name>             # Record which AI agent made these changes

fst pull [workspace]         # Pull latest snapshot from cloud
  --snapshot <id>            # Pull a specific snapshot
  --hard                     # Replace local files with the remote snapshot (destructive)
  --manual                   # Write conflict markers
  --theirs                   # Take remote version for conflicts
  --ours                     # Keep local version for conflicts
  --dry-run                  # Show plan without making changes
  --agent-summary            # Generate LLM summary of conflicts (with --dry-run)

fst clone <project|snapshot> # Clone to new directory
  --to, -t <path>            # Target directory

fst log                      # Show snapshot history
  --limit, -n <num>          # Number of entries (default: 10)

fst rollback [snapshot-id]   # Restore files from snapshot
  --snapshot, -s <id>        # Snapshot to restore (default: latest)
  --to-base                  # Restore to fork/base snapshot
```

### Drift

```bash
fst drift                    # Show changes from fork snapshot
  --json                     # Output as JSON
  --agent-summary            # Generate LLM summary (requires agent)
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
  --manual                   # Write conflict markers
  --theirs                   # Take source version for conflicts
  --ours                     # Keep target version for conflicts
  --dry-run                  # Show plan without making changes
  --agent-summary            # Generate LLM summary of conflicts (with --dry-run)
  --no-pre-snapshot          # Skip pre-merge snapshot (only created if dirty)
  --force                    # Allow merge without a common base (two-way merge)
```

**Merge inputs:**
- Merges are computed from the latest snapshots of both workspaces (not live working trees).
- The source working tree is ignored; only its latest snapshot is used.
- The target workspace may have local changes, but the merge aborts if any of those would be overwritten.
- If either workspace has no snapshots, you must run `fst snapshot` first.
- After a successful conflict-free merge, a snapshot is created automatically.

### Sync

```bash
fst sync                     # Sync local and remote for this workspace
  --manual                   # Write conflict markers
  --theirs                   # Take remote version for conflicts
  --ours                     # Keep local version for conflicts
  --files <list>             # Only sync specific files
  --dry-run                  # Show plan without making changes
  --agent-summary            # Generate LLM summary of conflicts (with --dry-run)
  --no-snapshot              # Skip pre-sync snapshot
```

**Conflict resolution modes:**
- Default (no flag): Uses your preferred coding agent to intelligently merge
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
  --include-dirty            # Include uncommitted changes
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
fst export git --include-dirty -m "WIP"  # Include uncommitted
```

### Agents

```bash
fst agents                   # List detected coding agents
fst agents set-preferred [name]  # Set preferred agent (prompts if omitted)
```

**Supported agents:**
- `claude` — Claude Code CLI
- `codex` — OpenAI Codex CLI
- `amp` — Amp CLI
- `agent` — Cursor Agent CLI
- `gemini` — Gemini CLI
- `droid` — Factory Droid CLI

Configuration stored in `~/.config/fst/agents.json`.
If multiple agents are detected and none is preferred, the CLI will prompt you to choose one for the current run.

### Watch (Triaged)

```bash
  --summarize                # Regenerate summaries periodically
```

> **Note:** Watch daemon is triaged for future implementation.

---

## Local State

### Main Workspace (`.fst/` directory)

```
.fst/
├── config.json              # Workspace configuration
├── manifests/<hash>.json    # File index (manifest)
├── snapshots/
│   └── <id>.meta.json       # Snapshot metadata
├── workspaces/              # Linked workspace configs
│   └── <ws-id>/config.json
└── export/
    └── git-map.json         # Snapshot → git commit mapping
```

Global cache:
```
~/.cache/fst/
└── blobs/<sha256>           # content-addressed files
```

### Linked Workspace (`.fst` file)

```
main: /path/to/main/workspace
workspace_id: local-abc123
```

### Global Index

`~/.config/fst/index.json`:
```json
{
  "version": 1,
  "projects": [
    {
      "project_id": "proj-xyz",
      "project_name": "demo",
      "project_path": "/path/to/project",
      "created_at": "2024-01-15T10:00:00Z",
      "last_seen_at": "2024-01-20T12:00:00Z"
    }
  ],
  "workspaces": [
    {
      "workspace_id": "ws-abc123",
      "workspace_name": "main",
      "project_id": "proj-xyz",
      "path": "/path/to/project/main",
      "fork_snapshot_id": "snap-123",
      "created_at": "2024-01-15T10:00:00Z",
      "last_seen_at": "2024-01-20T12:00:00Z"
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
