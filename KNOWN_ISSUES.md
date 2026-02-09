# Known Issues

## CRITICAL: Data Loss Risks

### ~~1. GC Can Delete Data Needed by In-Flight Operations~~ FIXED
- GC now acquires an exclusive project-level lock before running. Workspace operations hold a shared project-level lock, so GC blocks until all in-flight operations complete.

### ~~2. Silent Blob Caching Failures in `Snapshot()`~~ FIXED
- Blob caching failures now return errors instead of silently continuing. Snapshot creation aborts if any blob fails to cache.

### ~~3. Non-Atomic Multi-File Snapshot Write Sequence~~ FIXED
- Snapshot write sequence reordered: config.Save is now the commit point. If crash occurs before config is saved, the orphaned snapshot is harmless and GC cleans it up. Merge-parent cleanup and registry update are post-commit and non-fatal. Combined with workspace locking (#10) and GC locking (#1), the write sequence is crash-safe.

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

### ~~9. Rollback Has No Atomicity or Recovery~~ FIXED
- Rollback now creates an auto-snapshot before applying changes, providing a recovery point. If rollback is interrupted, users can `fst rollback --to <pre-rollback-snapshot>` to restore the previous state. Snapshot failure aborts the rollback.

## MEDIUM: Design Flaws

### ~~10. No Workspace-Level Locking~~ FIXED
- `workspace.Open()` now acquires an exclusive flock on `.fst/lock`. Concurrent operations on the same workspace block until the first completes. `Close()` releases the lock.

### ~~11. `workspaces` Command Uses Global Index, Not Project Registry~~ FIXED
- Now uses project-level registry consistently. Global index removed.

### ~~12. Merge/Diff/Drift Exit Codes Don't Distinguish Results~~ FIXED
- `drift` exits 1 when drift is detected, `diff` exits 1 when differences are found, `merge` exits 1 when unresolved conflicts remain. Exit 0 means no changes/conflicts. Uses `SilentExit` error type to suppress Cobra error output.

### ~~13. `RegisterWorkspace` Merge Semantics Can't Clear Fields~~ FIXED
- `RegisterWorkspace()` now overwrites all fields on upsert instead of merge-only-non-empty. Only `CreatedAt` is preserved from the existing entry if not explicitly set (immutable creation timestamp).

### ~~14. History Rewrite (drop/squash/rebase) Non-Atomic~~ FIXED
- Not actually broken: `RewriteChain()` creates new snapshots with new IDs without deleting old ones. If `config.Save()` fails afterward, the old chain remains intact and the workspace is functional. New orphaned snapshots are cleaned up by GC. No code change needed.

### ~~15. `checkDirtyConflicts` Fails Open~~ FIXED
- `checkDirtyConflicts` now returns errors instead of silently proceeding when it cannot load the current manifest or scan working tree files. Merge aborts with a clear error message if the dirty-tree check fails.

## LOW: Edge Cases & UX Issues

### ~~16. `status` Shows Project-Wide Latest Snapshot~~ FIXED
- `status` now uses `cfg.CurrentSnapshotID` (workspace-specific) instead of `GetLatestSnapshotIDAt` (project-wide scan).

### ~~17. Symlink Targets Not Path-Normalized~~ FIXED
- Symlink targets are now normalized with `filepath.ToSlash()` during manifest generation, matching the path normalization used for file paths.

### ~~18. Manifest `FromJSON()` Does Zero Validation~~ FIXED
- `FromJSON()` now validates all entries: paths must be non-empty and not contain `..`, files must have valid 64-character SHA-256 hashes, symlinks must have non-empty targets, and entry types must be one of `file`, `dir`, or `symlink`.

### ~~19. Merge Base Tiebreaker Non-Deterministic~~ FIXED
- When two merge base candidates have identical timestamps, the tiebreaker now uses lexicographic comparison of snapshot IDs (`item.id > bestID`) for deterministic results.

### ~~20. `fst clone` Silently Ignores Config Save Errors~~ FIXED
- `config.LoadAt()` and `config.SaveAt()` errors in clone now return errors instead of being silently ignored.

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

All 20 issues resolved.
