# CLI Command Reference

Complete reference for all `fst` commands. Source: `cli/cmd/fst/commands/`.

## Authentication

| Command | Description | Source |
|---------|-------------|--------|
| `fst login` | Authenticate via device authorization flow | `login.go` |
| `fst logout` | Remove stored credentials | `login.go` |
| `fst whoami` | Show current authenticated user | `login.go` |

## Projects

| Command | Aliases | Description | Source |
|---------|---------|-------------|--------|
| `fst project init [name]` | | Initialize current directory as a project | `parent.go` |
| `fst project create <name>` | | Create a new project on the server | `parent.go` |

**`project init` flags:** `--project-id`, `--keep-name`, `--force`
**`project create` flags:** `--no-snapshot`, `--force`, `--path`

## Workspaces

| Command | Aliases | Description | Source |
|---------|---------|-------------|--------|
| `fst workspace` | | Manage workspaces (requires subcommand) | `workspace.go` |
| `fst workspace init` | | Initialize workspace in an existing project dir | `workspace.go` |
| `fst workspace create` | | Create a new workspace (cloud + local) | `workspace.go` |
| `fst workspace set-main` | | Set this workspace as the project's main workspace | `workspace.go` |
| `fst workspace clone <project\|snapshot>` | | Clone a project/snapshot from cloud | `clone.go` |

**`workspace init` flags:** `--workspace, -w`, `--no-snapshot`, `--force`
**`workspace clone` flags:** `--to, -t`

## Snapshots

| Command | Description | Source |
|---------|-------------|--------|
| `fst snapshot` | Create an immutable snapshot of the workspace | `snapshot.go` |
| `fst log` | Show snapshot history chain | `log.go` |
| `fst rollback [files...]` | Restore files from a previous snapshot | `rollback.go` |

**`snapshot` flags:** `--message, -m`, `--agent-summary`, `--agent`
**`log` flags:** `--limit, -n` (default 10), `--all, -a`
**`rollback` flags:** `--to`, `--to-base`, `--dry-run`, `--force`

## History Rewriting

| Command | Description | Source |
|---------|-------------|--------|
| `fst edit <snapshot>` | Edit a snapshot's message | `history.go` |
| `fst drop <snapshot>` | Remove a snapshot from the chain | `history.go` |
| `fst squash <from>..<to>` | Squash a range of snapshots into one | `history.go` |
| `fst rebase <from>..<to>` | Rebase snapshots onto a different base | `history.go` |

**`edit` flags:** `--message, -m`
**`squash` flags:** `--message, -m`
**`rebase` flags:** `--onto` (required)

## Drift, Merge, and Sync

| Command | Description | Source |
|---------|-------------|--------|
| `fst drift [workspace]` | Three-way drift comparison via DAG merge-base | `drift.go` |
| `fst merge [workspace]` | Three-way merge with conflict resolution | `merge.go` |
| `fst diff [workspace] [file...]` | Line-by-line content diff between workspaces | `diff.go` |
| `fst pull [workspace]` | Pull changes from another workspace | `pull.go` |
| `fst sync` | Sync with the upstream workspace | `sync.go` |
| `fst status` | Show workspace status with drift summary | `status.go` |
| `fst info` | Show workspace or project info (context-aware) | `info.go` |
| `fst info workspaces` | `ws` | List all workspaces for the current project | `info.go` |
| `fst info workspace [name\|id]` | | Show details for a specific workspace | `info.go` |
| `fst info project` | | Show current project details | `info.go` |

**`drift` flags:** `--json`, `--agent-summary`, `--no-dirty`
**`merge` flags:** `--manual`, `--theirs`, `--ours`, `--dry-run`, `--agent-summary`, `--no-pre-snapshot`, `--force`, `--abort`
**`diff` flags:** `--context, -C` (default 3), `--no-color`, `--names-only`
**`pull` flags:** `--snapshot`, `--hard`, `--manual`, `--theirs`, `--ours`, `--dry-run`, `--agent-summary`
**`sync` flags:** `--manual`, `--theirs`, `--ours`, `--files`, `--dry-run`, `--agent-summary`, `--no-snapshot`
**`status` flags:** `--json`
**`info` flags:** `--json`
**`info workspace` flags:** `--json`
**`info project` flags:** `--json`

### Merge conflict modes

Merge supports four conflict resolution strategies (set via flags on `merge`, `pull`, or `sync`):

- **Agent** (default) -- invokes the preferred coding agent to resolve conflicts
- **Manual** (`--manual`) -- writes conflict markers for manual resolution
- **Theirs** (`--theirs`) -- accepts the other workspace's version
- **Ours** (`--ours`) -- keeps the current workspace's version

## Git Interop

| Command | Description | Source |
|---------|-------------|--------|
| `fst git export` | Export snapshot chain to git commits | `export.go` |
| `fst git import <repo-path>` | Import from a git repo exported by fst | `import.go` |
| `fst github export <owner>/<repo>` | Export to a GitHub repository | `github.go` |
| `fst github import <owner>/<repo>` | Import from a GitHub repository | `github.go` |

**`git export` flags:** `--branch, -b`, `--include-dirty`, `--message, -m`, `--init`, `--rebuild`
**`git import` flags:** `--branch, -b`, `--workspace, -w`, `--project, -p`, `--rebuild`
**`github export` flags:** `--branch, -b`, `--include-dirty`, `--message, -m`, `--init`, `--rebuild`, `--remote`, `--create`, `--private`, `--push-all`, `--force-remote`, `--no-gh`
**`github import` flags:** `--branch, -b`, `--workspace, -w`, `--project, -p`, `--rebuild`, `--no-gh`

Git export stores commit-to-snapshot mapping in `.fst/export/git-map.json`. GitHub commands use `gh` CLI when available, falling back to direct git operations with `--no-gh`.

## Agents

| Command | Aliases | Description | Source |
|---------|---------|-------------|--------|
| `fst agents` | | List detected coding agents | `agents.go` |
| `fst agents list` | `ls` | Show all known agents with availability | `agents.go` |
| `fst agents set-preferred [name]` | | Set the preferred agent for summaries/merges | `agents.go` |

## Configuration

| Command | Description | Source |
|---------|-------------|--------|
| `fst config` | Interactive author identity setup (project-level) | `cmd_config.go` |
| `fst config --global` | Interactive author identity setup (global) | `cmd_config.go` |
| `fst config set name "John Doe"` | Set author name (project-level) | `cmd_config.go` |
| `fst config set email "john@example.com"` | Set author email (project-level) | `cmd_config.go` |
| `fst config set --global name "John Doe"` | Set author name (global) | `cmd_config.go` |
| `fst config get` | Show resolved author identity | `cmd_config.go` |
| `fst config get name` | Show a specific field | `cmd_config.go` |

**`config` flags:** `--global` (use global instead of project-level)
**`config set` flags:** `--global` (set globally instead of project-level)

Author identity is embedded in snapshot metadata and used to compute content-addressed snapshot IDs. Project-level config (`.fst/author.json`) overrides global config (`~/.config/fst/author.json`). If no author is configured when creating a snapshot interactively, a prompt is shown.

## Deprecated

| Command | Replacement | Source |
|---------|-------------|--------|
| `fst conflicts <workspace-path>` | `fst merge --dry-run` | `conflicts.go` |
