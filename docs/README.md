# Fastest (fst)

Fastest is infrastructure for parallel agent workflows, built from the ground up. Existing tools treat parallel development as an afterthought — fst makes it the core primitive, providing immutable snapshots, workspace-level branching, drift detection, and three-way merge with agent-assisted conflict resolution.

The CLI binary is `fst`. The project is structured as a monorepo with a Go CLI, a Hono/Cloudflare Workers API, and a Vite+React web frontend.

## Quick start

```bash
# Authenticate with the cloud service
fst login

# Initialize a workspace in the current directory
fst workspace init my-project

# Capture a snapshot
fst snapshot -m "Initial version"

# Create a parallel workspace (from an existing project)
fst workspace clone my-project --to my-project-experiment

# Check what changed since last snapshot
fst status

# Compare two workspaces (drift + conflict detection)
fst drift other-workspace

# Merge changes from another workspace
fst merge other-workspace

# Show line-level diffs against another workspace
fst diff other-workspace

# Restore files from a previous snapshot
fst rollback

# Sync local and remote state
fst sync

# Pull latest snapshot from cloud
fst pull

# Export workspace history to Git
fst git export

# Import Git history into a workspace
fst git import <repo-path>
```

## Key CLI commands

| Command | Description |
|---------|-------------|
| `fst project init` | Initialize current directory as a project |
| `fst workspace init` | Initialize a workspace with `.fst/` directory |
| `fst workspace create` | Create a new workspace under a project |
| `fst snapshot` | Capture current state as an immutable snapshot |
| `fst status` | Show workspace status and drift summary |
| `fst drift` | Compare workspaces with DAG-based ancestor detection |
| `fst merge` | Three-way merge from another workspace |
| `fst diff` | Line-level content differences between workspaces |
| `fst rollback` | Restore files from a previous snapshot |
| `fst clone` | Clone a project or snapshot to a new workspace |
| `fst sync` | Sync local and remote workspace state |
| `fst pull` | Pull latest snapshot from cloud |
| `fst login` / `fst logout` | Authenticate with Fastest cloud |
| `fst whoami` | Show current user |
| `fst log` | Show snapshot history |
| `fst info` | Show workspace or project details |
| `fst info workspaces` | List all workspaces for a project |
| `fst info workspace` | Show details for a specific workspace |
| `fst info project` | Show current project details |
| `fst edit` / `fst drop` / `fst squash` | History rewriting operations |
| `fst gc` | Garbage collect orphaned snapshots and blobs |
| `fst agents` | List and configure coding agents |
| `fst config` | Author identity configuration |
| `fst git export` / `fst git import` | Bidirectional Git interop |
| `fst ui` | Open the web UI |

## Documentation

- [Architecture overview](architecture/overview.md) -- system components and how they connect
- [Data model](architecture/data-model.md) -- projects, workspaces, snapshots, manifests
- [Storage](architecture/storage.md) -- blob hashing, manifest format, `.fst/` layout, R2
- [Authentication](architecture/auth.md) -- device flow, Google OAuth, token storage
- [Security](architecture/security.md) -- trust boundaries, token scoping, storage isolation

## Testing

```bash
# Go unit/integration tests
cd cli && go test ./...

# End-to-end workflow tests (builds binary, runs 9 workflow scripts)
./tests/e2e/run.sh
```

## Repository structure

```
cli/           Go CLI tool (module github.com/anthropics/fastest/cli)
api/           Hono API on Cloudflare Workers
web/           Vite + React frontend (TanStack Router)
packages/shared/  Shared TypeScript types and manifest utilities
tests/e2e/     End-to-end bash workflow tests
```
