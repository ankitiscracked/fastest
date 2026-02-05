# Snapshots

A snapshot is an immutable record of a workspace's file state at a point in time. Snapshots form a directed acyclic graph (DAG) through parent references, enabling merge-base computation and history traversal.

## Snapshot Metadata

Each snapshot is stored as a `.meta.json` file in `.fst/snapshots/`. The full metadata structure (defined in `cli/cmd/fst/commands/log.go` as `SnapshotMeta`):

```json
{
  "id": "snap-abc123...",
  "workspace_id": "ws-...",
  "workspace_name": "main",
  "manifest_hash": "sha256hex...",
  "parent_snapshot_ids": ["snap-parent1...", "snap-parent2..."],
  "message": "Add authentication module",
  "agent": "claude",
  "created_at": "2025-01-15T10:30:00Z",
  "files": 42,
  "size": 128000
}
```

The `manifest_hash` links to a manifest JSON file in `.fst/manifests/{hash}.json` that contains the full file listing with per-file SHA-256 hashes, sizes, and modes.

A minimal `SnapshotMeta` (in `cli/internal/config/config.go`) is used for resolution: just `id`, `created_at`, and `manifest_hash`.

## Snapshot IDs

Snapshot IDs are randomly generated with a `snap-` prefix (via `generateSnapshotID()`). They can be resolved by prefix -- if a short prefix uniquely matches one `.meta.json` file, it resolves to the full ID. Ambiguous prefixes return an error.

Implementation: `cli/internal/config/config.go` (`ResolveSnapshotIDAt`).

## The DAG

Snapshots reference zero or more parent snapshot IDs in `parent_snapshot_ids`:
- A regular snapshot has one parent (the previous `current_snapshot_id`)
- A merge snapshot has two parents (the local head and the merged-in head)
- The first snapshot in a workspace has no parents (or inherits from the fork point)

Parent IDs are resolved at snapshot creation time via `resolveSnapshotParents`, which checks for pending merge parents first (written by the merge command), then falls back to `current_snapshot_id`.

Implementation: `cli/cmd/fst/commands/snapshot.go` (`resolveSnapshotParents`).

## Merge Base Algorithm

Finding the common ancestor between two workspace heads uses BFS on the snapshot DAG, implemented in `cli/internal/dag/mergebase.go` (`GetMergeBase`):

1. BFS from the target head to build a distance map (snapshot ID to distance)
2. BFS from the source head, checking each visited node against the target distance map
3. When intersections are found, the algorithm minimizes the combined distance (source distance + target distance)
4. Ties are broken by preferring the more recently created snapshot (by `created_at` timestamp)
5. The search prunes early: if the current source distance already exceeds the best known combined score, it stops

Snapshot metadata is loaded from either workspace's `.fst/snapshots/` directory via `LoadSnapshotMetaAny`.

## Snapshot Creation Flow

`fst snapshot` (implemented in `cli/cmd/fst/commands/snapshot.go`):

1. Generates a manifest of the current filesystem (respecting `.fstignore`)
2. Computes the manifest's SHA-256 content hash
3. Generates a new random snapshot ID
4. Caches all file blobs in the global blob cache (`~/.cache/fst/blobs/`)
5. Saves the manifest JSON to `.fst/manifests/{hash}.json`
6. Writes snapshot metadata to `.fst/snapshots/{id}.meta.json`
7. Updates `current_snapshot_id` in config
8. Clears any pending merge parents

Options:
- `--message` / `-m`: Required description for the snapshot
- `--agent-summary`: Auto-generates a description using a configured AI agent
- `--agent`: Records which AI agent made the changes (auto-detected from `FST_AGENT` env var)

### Auto-Snapshots

`CreateAutoSnapshot` is used internally by merge and sync to create safety snapshots before destructive operations. It skips creation if the manifest hash matches the current snapshot (no changes).

## Snapshot History

`fst log` displays the snapshot chain starting from `current_snapshot_id`, walking backwards through `parent_snapshot_ids[0]`. Use `--all` to show all snapshots sorted by time regardless of chain membership. Output includes shortened IDs, relative timestamps, file counts, sizes, agent tags, and messages.

Implementation: `cli/cmd/fst/commands/log.go` (`walkSnapshotChain`).

## Cloud Snapshots

The server-side snapshot schema (in `api/src/db/schema.ts`) stores:
- `id`, `project_id`, `workspace_id`, `manifest_hash`
- `parent_snapshot_ids` (JSON array)
- `source` (default: `"cli"`)
- `summary` (LLM-generated)
- `created_at`

Cloud snapshots are created during `fst sync` upload via `client.CreateSnapshot`.

## Related Docs

- [Workspaces](workspaces.md) -- snapshots live inside workspaces
- [Drift](drift.md) -- drift is computed against the latest snapshot
- [Merge](merge.md) -- merge uses the DAG to find common ancestors
- [Sync](sync.md) -- sync uploads/downloads snapshots to/from the cloud
