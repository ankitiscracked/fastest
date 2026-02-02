# Mental Model

## Core Primitives

### Project
A container for identity and history.
- Stable ID (e.g., `proj-abc123`)
- Human-friendly name
- Can have multiple workspaces

### Workspace
A local working copy of a project.
- Tracks a fork snapshot (origin point)
- Tracks a current snapshot (latest saved state)
- Can detect drift (changes from fork)
- Two types:
  - **Main workspace** — owns the `.fst/` directory (manifests + metadata)
  - **Linked workspace** — lightweight copy, shares the global blob cache

```
                    Project
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   workspace-1    workspace-2    workspace-3
   (main)         (feature)      (experiment)
   ~/proj         ~/proj-feature ~/proj-exp
```

### Snapshot
An immutable project state:
- Content-addressed (SHA-256)
- Reproducible
- Has optional parent (forms a chain)
- Upload/download deduped by blob hashes

### Drift
Changes from the fork snapshot to current files:
- Files added, modified, deleted
- Can generate LLM summary via coding agents

### Merge
Combine changes from one workspace into another:
- 3-way merge (base ↔ target ↔ source)
- Agent-assisted conflict resolution
- Manual fallback with conflict markers

---

## Directory Structure

### Main Workspace
```
myproject/
├── .fst/
│   ├── config.json           # workspace config
│   ├── manifests/<hash>.json # file index (manifest)
│   ├── snapshots/<id>.meta.json
│   ├── workspaces/           # linked workspace configs
│   └── export/
│       └── git-map.json      # snapshot→commit mapping
├── src/
└── ...
```

Global cache (shared across workspaces):
```
~/.cache/fst/
└── blobs/<sha256>            # content-addressed files
```

### Linked Workspace
```
myproject-feature/
├── .fst                      # FILE (not directory) pointing to main
├── src/
└── ...
```

The `.fst` file contains:
```
main: /path/to/myproject
workspace_id: local-abc123
```

---

## What "Sync" Means

When cloud is enabled:
- Project registry is shared
- Snapshot history is shared
- Workspace status visible in Web UI

So:
- Create in CLI → visible in Web
- Snapshot in CLI → visible in Web, clonable anywhere
- Multiple agents can work in parallel, all visible in dashboard

---

## Workflow Example

```bash
# 1. Initialize project
cd myproject
fst workspace init

# 2. Create parallel workspaces
fst workspace copy -n agent-a
fst workspace copy -n agent-b

# 3. Work in each workspace independently
cd ../myproject-agent-a
# ... make changes ...
fst drift --agent-summary
fst snapshot -m "Added auth"

# 4. Merge best changes back
cd ../myproject
fst merge agent-a
fst merge agent-b --theirs  # prefer their version

# 5. Export to git
fst git export --branch main
```

---

## Global Index

Local projects and workspaces are indexed in `~/.config/fst/index.json`:
```json
{
  "version": 1,
  "projects": [
    {
      "project_id": "proj-xyz",
      "project_name": "demo",
      "project_path": "/Users/me/myproject"
    }
  ],
  "workspaces": [
    {
      "workspace_id": "ws-abc123",
      "workspace_name": "main",
      "project_id": "proj-xyz",
      "path": "/Users/me/myproject/main",
      "fork_snapshot_id": "snap-123"
    }
  ]
}
```

This enables:
- `fst workspaces` to list all workspaces
- `fst merge <name>` to find workspace by name
