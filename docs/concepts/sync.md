# Sync

Sync keeps a workspace's local and cloud state aligned. It handles uploading local snapshots to the server and downloading remote changes, using the same three-way merge machinery as `fst merge` when histories have diverged.

## Upload Flow

Uploading a snapshot to the cloud (used by `fst sync` and `fst pull` after merging):

1. **Check missing blobs**: Send file content hashes to `POST /v1/blobs/exists`, which returns the list of hashes not yet on the server. Hashes are batched in groups of 100.
2. **Upload blobs**: For each missing hash, request a presigned upload URL via `POST /v1/blobs/presign-upload`, then PUT the file content to that URL.
3. **Upload manifest**: PUT the manifest JSON to `/v1/blobs/manifests/{hash}`.
4. **Create snapshot**: POST to `/v1/projects/{id}/snapshots` with the snapshot ID, manifest hash, parent IDs, and workspace ID.

Implementation: `cli/cmd/fst/commands/snapshot.go` (`uploadSnapshotToCloud`), `cli/internal/api/client.go` (`BlobExists`, `PresignUpload`, `UploadBlob`, `UploadManifest`, `CreateSnapshot`).

## Download Flow (Pull)

`fst pull` downloads a remote snapshot and merges it into the local workspace:

1. Fetch the remote workspace to get `current_snapshot_id`
2. If local and remote heads match, report "already in sync"
3. Download the remote snapshot's manifest via `GET /v1/blobs/manifests/{hash}`
4. Materialize the remote snapshot into a temp directory by downloading all blobs via presigned download URLs
5. Find the merge base between local and remote heads
6. Compute three-way merge actions (same as `fst merge`)
7. Apply non-conflicting changes; resolve conflicts per the chosen strategy
8. Create a post-merge snapshot and upload it

Hard pull (`--hard`) replaces local files entirely with the remote snapshot, discarding local changes.

Implementation: `cli/cmd/fst/commands/pull.go` (`runPull`).

## The `fst sync` Command

Sync is a bidirectional operation for the same workspace's local and remote state:

1. Fetch the remote workspace's `current_snapshot_id`
2. Compare with the local head; if they match, report "already in sync"
3. Download and materialize the remote snapshot to a temp directory
4. Find the merge base between local and remote heads (walks local parent chain, then walks remote parents via API to find intersection)
5. Compute and execute three-way merge
6. Create a merge snapshot with both local and remote heads as parents
7. Upload the merged snapshot to the cloud

The merge base finder for sync (`getSyncMergeBase`) differs from the local DAG walker: it walks the local snapshot chain in memory, then traverses the remote chain via `client.GetSnapshot` API calls until it finds an intersection. It returns the base manifest, the merge base ID, and any error.

After a successful sync merge, a mini DAG diagram is printed showing the local and remote heads converging into the merged snapshot. When conflicts require manual resolution, the diagram shows `(pending)` with a conflict count. The `--dry-run` flag also displays a preview diagram.

Implementation: `cli/cmd/fst/commands/sync.go` (`runSync`, `getSyncMergeBase`).

## Conflict Resolution

Both `sync` and `pull` support the same conflict resolution modes as `fst merge`:

| Flag       | Behavior                                     |
|------------|----------------------------------------------|
| (default)  | AI agent resolves conflicts                  |
| `--manual` | Write conflict markers                       |
| `--theirs` | Take remote version                          |
| `--ours`   | Keep local version                           |

Additional flags:
- `--dry-run`: preview the merge plan without applying changes
- `--agent-summary`: generate AI summary of conflicts (with `--dry-run`)
- `--no-snapshot`: skip the pre-sync safety snapshot
- `--files`: sync only specific files (sync command only)

## Optimistic Locking

The server-side workspace table includes a `version` integer column (see `api/src/db/schema.ts`, `workspaces` table). This enables optimistic locking to prevent concurrent sync race conditions -- two clients syncing the same workspace simultaneously will not silently overwrite each other's changes.

## Materializing Snapshots

Downloading a remote snapshot's files to a local directory (`materializeSnapshot` in `cli/cmd/fst/commands/clone.go`):

1. Collect unique file hashes from the manifest
2. Batch request presigned download URLs via `POST /v1/blobs/presign-download`
3. Download each blob and cache it in `~/.cache/fst/blobs/`
4. Write files to the target directory with correct paths and modes

## Pre-Sync Snapshots

Before sync or pull modifies local files, a safety snapshot is created (via `CreateAutoSnapshot`) if there are uncommitted local changes. This allows restoring via `fst restore` if the sync produces undesirable results.

## Related Docs

- [Snapshots](snapshots.md) -- sync uploads and downloads snapshot data
- [Merge](merge.md) -- sync uses the three-way merge engine
- [Workspaces](workspaces.md) -- sync operates on a single workspace's local/cloud state
- [Git Integration](git-integration.md) -- alternative export/import via git
