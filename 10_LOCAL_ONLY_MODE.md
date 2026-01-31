# Local-Only Mode

## Overview

Everything works on one machine without a cloud account:
- Projects and workspaces
- Snapshots with full history
- Drift detection with LLM summaries
- Merge between workspaces
- Git export

**No `--local` flag needed** — local mode is the default when not logged in.

## How It Works

When you run `fst workspace init` without being logged in:
1. Project is created with a local ID (`proj-abc123`)
2. All data stays in `.fst/` directory
3. Full functionality available

When you later run `fst login`:
1. Local projects can be synced to cloud
2. Snapshots become visible in Web UI
3. Workspaces can sync status

## Local Storage Layout

### Main Workspace
```
myproject/
├── .fst/
│   ├── config.json           # Project and workspace config
│   ├── manifests/<hash>.json # File index (manifest)
│   ├── snapshots/
│   │   └── snap-xxx.meta.json # Metadata (parent, message, etc.)
│   ├── workspaces/           # Linked workspace configs
│   └── export/
│       └── git-map.json      # Git export mapping
└── ... (your files)
```

Global cache (shared across workspaces):
```
~/.cache/fst/
└── blobs/<sha256>            # content-addressed files
```

### Linked Workspace
```
myproject-feature/
├── .fst                      # File pointing to main workspace
└── ... (your files)
```

### Global Index
```
~/.config/fst/
├── index.json                # Projects and workspaces on this machine
└── agents.json               # Preferred coding agent
```

## Local Commands

All commands work identically in local and cloud modes:

```bash
fst workspace init myproject           # Create project
fst workspace copy -n feature          # Create linked workspace
fst snapshot -m "message"    # Capture snapshot
fst drift                    # Show changes
fst drift --summary          # LLM summary (requires agent)
fst merge feature            # Merge workspaces
fst export git               # Export to git
```

## Agent Integration

Local mode supports LLM-powered features via installed coding agents:

```bash
fst agents                   # List detected agents
```

Supported agents:
- `claude` — Claude Code CLI
- `aider` — Aider
- `cursor` — Cursor IDE
- `copilot` — GitHub Copilot CLI

Features requiring agents:
- `fst drift --summary` — Generate change summary
- `fst merge --agent` — AI conflict resolution

## Migrating to Cloud

When ready to sync to cloud:

```bash
fst login                    # Authenticate
# Future: fst sync           # Push local project to cloud
```

## Compatibility

The manifest format is identical for local and cloud modes:
- Local snapshots can later be uploaded
- Cloud snapshots can be cloned locally
- Seamless transition between modes
