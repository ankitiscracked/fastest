# Known Issues

## CRITICAL: Data Loss Risks

### ~~1. GC Can Delete Data Needed by In-Flight Operations~~ FIXED
- GC now acquires an exclusive project-level lock before running. Workspace operations hold a shared project-level lock, so GC blocks until all in-flight operations complete.

### ~~2. Silent Blob Caching Failures in `Snapshot()`~~ FIXED
- Blob caching failures now return errors instead of silently continuing. Snapshot creation aborts if any blob fails to cache.

### 3. Non-Atomic Multi-File Snapshot Write Sequence
- `workspace/snapshot.go:111-128` — Snapshot creation writes 3-4 things sequentially: (1) snapshot metadata, (2) config update, (3) clear merge parents, (4) registry update. A crash between any of these leaves inconsistent state:
  - After step 1, before step 2: Snapshot exists but config still points to old snapshot
  - After step 2, before step 4: Config updated but registry stale — GC could delete referenced snapshot
- **Impact**: Workspace left in partially-committed state.

### ~~4. Non-Atomic File Writes Throughout~~ FIXED
- All JSON metadata writes now use `AtomicWriteFile` (write-to-temp + fsync + rename). Covers snapshot metadata, manifests, blobs, workspace registry, workspace config, and parent config.

## HIGH: Consistency Issues

### ~~5. `workspace create` Doesn't Populate Files~~ FIXED
- Consolidated `workspace create` and `workspace copy` into a single command that forks from the source workspace's latest snapshot with all files copied.

### ~~6. `workspace create` Registers in Global Index But Not Project Registry~~ FIXED
- Now registers in project-level registry. Global index removed entirely.

### ~~7. Pre-Operation Safety Snapshots Are Non-Fatal~~ FIXED
- Pre-operation snapshot failures now abort the destructive operation. Users can opt out with `--no-pre-snapshot` (merge), `--hard` (pull), or `--no-snapshot` (sync).

### ~~8. Merge State Corruption on Mid-Apply Crash~~ FIXED
- Merge-parents.json is now written BEFORE applying file changes, not after. If a crash occurs mid-apply, the next `fst snapshot` still creates a merge commit with correct parent IDs. If all actions fail, merge parents are cleared.

### 9. Rollback Has No Atomicity or Recovery
- `workspace/rollback.go:164-221` — Rollback restores files one at a time in a loop. If crash occurs mid-loop, workspace is partially rolled back with no record of progress. Cannot safely retry (some files already restored, some not).
- **Impact**: Workspace in inconsistent state with no way to resume or undo partial rollback.

## MEDIUM: Design Flaws

### ~~10. No Workspace-Level Locking~~ FIXED
- `workspace.Open()` now acquires an exclusive flock on `.fst/lock`. Concurrent operations on the same workspace block until the first completes. `Close()` releases the lock.

### ~~11. `workspaces` Command Uses Global Index, Not Project Registry~~ FIXED
- Now uses project-level registry consistently. Global index removed.

### ~~12. Merge/Diff/Drift Exit Codes Don't Distinguish Results~~ FIXED
- `drift` exits 1 when drift is detected, `diff` exits 1 when differences are found, `merge` exits 1 when unresolved conflicts remain. Exit 0 means no changes/conflicts. Uses `SilentExit` error type to suppress Cobra error output.

### 13. `RegisterWorkspace` Merge Semantics Can't Clear Fields
- `store/registry.go:59-87` — `RegisterWorkspace()` only overwrites non-empty fields. This means if a workspace's `CurrentSnapshotID` needs to be *cleared* (set to empty), it's impossible through this API. The registry will keep the stale value.
- **Impact**: Registry can never be corrected for certain field values.

### 14. History Rewrite (drop/squash/rebase) Non-Atomic
- `history.go` — `RewriteChain()` modifies snapshot metadata, then `config.Save()` updates the workspace config. If `config.Save()` fails after the chain is already rewritten, the workspace config points to a snapshot that no longer exists in the rewritten chain.
- **Impact**: Workspace becomes broken with config pointing to deleted/modified snapshot.

### 15. `checkDirtyConflicts` Fails Open
- `workspace/merge.go:122-179` — The dirty-tree check returns `nil` (proceed) if it can't load the current manifest. This means if there's *any* error loading the current state, the merge proceeds without the safety check, potentially overwriting uncommitted work.
- **Impact**: Uncommitted changes can be silently overwritten during merge.

## LOW: Edge Cases & UX Issues

### 16. `status` Shows Project-Wide Latest Snapshot
- `status` shows "Latest" snapshot across all workspaces (project-wide), not the current workspace's latest — confusing.

### 17. Symlink Targets Not Path-Normalized
- Symlink targets aren't path-normalized (`filepath.ToSlash` is used for paths but not for symlink targets), breaking cross-platform compatibility.

### 18. Manifest `FromJSON()` Does Zero Validation
- Corrupt manifests with invalid hashes or paths load silently.

### 19. Merge Base Tiebreaker Non-Deterministic
- Merge base tiebreaker uses timestamp comparison, which can be non-deterministic if two snapshots have identical `CreatedAt` values.

### 20. `fst clone` Silently Ignores Config Save Errors
- `clone.go:140` — `_ = config.SaveAt(...)` shows "Clone complete!" even if the config wasn't written.

## Priority Summary

| Priority | Issue | Fix |
|----------|-------|-----|
| ~~P0~~ | ~~Non-atomic file writes (#3, #4)~~ | ~~FIXED — AtomicWriteFile (temp + fsync + rename)~~ |
| ~~P0~~ | ~~Silent blob caching failures (#2)~~ | ~~FIXED — errors now abort snapshot creation~~ |
| ~~P1~~ | ~~No workspace-level locking (#10)~~ | ~~FIXED — flock-based exclusive workspace lock~~ |
| ~~P1~~ | ~~Pre-operation snapshots should be fatal (#7)~~ | ~~FIXED — snapshot failure now aborts operation~~ |
| ~~P1~~ | ~~GC vs in-flight race (#1)~~ | ~~FIXED — shared/exclusive project-level GC lock~~ |
| ~~P2~~ | ~~Merge state crash recovery (#8)~~ | ~~FIXED — merge-parents.json written before applying changes~~ |
| ~~P2~~ | ~~Exit codes for drift/diff/merge (#12)~~ | ~~FIXED — SilentExit(1) for changes/conflicts found~~ |
