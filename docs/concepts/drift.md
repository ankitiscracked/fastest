# Drift

Drift is the set of file-level changes between a reference manifest and the current filesystem state. It is the primary mechanism for understanding what has changed in a workspace.

## How Drift Is Computed

The drift engine compares two manifests by diffing their file entries. Each file is identified by path and content hash (SHA-256). The result is a `Report` containing:

| Field            | Description                                      |
|------------------|--------------------------------------------------|
| `files_added`    | Files present in current but not in the base     |
| `files_modified` | Files present in both but with different hashes  |
| `files_deleted`  | Files present in base but not in current         |
| `bytes_changed`  | Estimated total bytes affected                   |
| `summary`        | Optional text summary                            |

Bytes changed is calculated as: full size for added files, absolute size delta for modified files, and full size for deleted files.

Implementation: `cli/internal/drift/drift.go` (`Report`, `Compute`, `CompareManifests`).

## Drift Computation Modes

### Against Base Snapshot (`ComputeFromCache`)

Compares the current filesystem against `base_snapshot_id` from the workspace config. This is the drift used by `fst workspace` status display. If no base snapshot exists, all files are reported as added.

### Against Latest Snapshot (`ComputeFromLatestSnapshot`)

Compares the current filesystem against the most recent snapshot (by `created_at`). This is used by `fst status` to show uncommitted changes.

### Between Two Manifests (`CompareManifests`)

Compares any two manifests directly. Used by `fst drift` to compute each side's changes from their common ancestor.

## The `fst status` Command

Displays single-workspace status:
- Workspace name and path
- Latest snapshot ID and time
- Base snapshot ID and time
- Upstream workspace (if the base snapshot was created by a different workspace)
- File change summary since the latest snapshot

Supports `--json` output.

Implementation: `cli/cmd/fst/commands/status.go` (`runStatus`).

## The `fst drift` Command

Compares the current workspace against another workspace (or the project's main workspace by default). Uses the DAG merge base algorithm to find their common ancestor, then computes changes on each side from that ancestor.

The drift report includes:
- **Our changes**: files this workspace modified since the common ancestor
- **Their changes**: files the target workspace modified since the common ancestor
- **Snapshot conflicts**: files with overlapping line-level changes (committed snapshots only)
- **Dirty conflicts**: additional conflicts introduced by uncommitted changes
- **Overlapping files**: files modified in both workspaces (may or may not conflict)

Modes:
- Default (dirty): includes current filesystem state for both workspaces
- `--no-dirty`: compares committed snapshots only
- `--json`: structured JSON output
- `--agent-summary`: generates an AI risk assessment of the drift

Implementation: `cli/cmd/fst/commands/drift.go` (`runDrift`, `driftResult`).

## Upstream Workspace

A workspace can have an "upstream" -- the workspace that created its base snapshot. This is determined by examining the `workspace_id` field in the base snapshot's metadata. If it differs from the current workspace's ID, that workspace is the upstream.

Used by `fst diff` (with no arguments) to default to diffing against the upstream.

Implementation: `cli/internal/drift/drift.go` (`GetUpstreamWorkspace`).

## Agent Summaries

When `--agent-summary` is used with `fst drift`, the system invokes a configured AI agent to produce a risk assessment. The agent receives structured context about both sides' changes and any detected conflicts.

Implementation: `cli/cmd/fst/commands/drift.go` (`generateDriftSummary`), `cli/internal/agent/`.

## Related Docs

- [Snapshots](snapshots.md) -- drift is computed against snapshot manifests
- [Merge](merge.md) -- conflict detection builds on drift computation
- [Workspaces](workspaces.md) -- each workspace tracks its own drift state
