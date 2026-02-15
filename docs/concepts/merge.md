# Merge

Merge integrates changes from one workspace (source) into another (target) using three-way comparison against a common ancestor found via the snapshot DAG.

## Three-Way Merge

The merge operates on three manifests:

1. **BASE**: The common ancestor snapshot, found via `dag.GetMergeBase` (see [Snapshots](snapshots.md))
2. **CURRENT**: The target workspace's latest snapshot
3. **SOURCE**: The source workspace's latest snapshot

Merge inputs are snapshot-based -- working tree files are not used as merge inputs. The merge aborts if it would overwrite local uncommitted changes that overlap with files the merge would touch.

Implementation: `cli/cmd/fst/commands/merge.go` (`runMerge`), `cli/internal/store/merge.go` (`computeMergeActions`).

## Merge Actions

For each file path across all three manifests, `computeMergeActions` classifies it:

| Scenario                                            | Action       |
|-----------------------------------------------------|--------------|
| Only source changed                                 | `apply`      |
| Only current changed                                | `in_sync`    |
| Both changed, same content                          | `in_sync`    |
| Both changed, non-overlapping lines                 | `auto-merge` |
| Both changed, overlapping lines                     | `conflict`   |
| File only in source (new)                           | `apply`      |
| Current deleted, source has it                      | `conflict`   |
| Source deleted, current has it                       | `in_sync`    |

"Changed" means the file's hash differs from the base manifest, or the file was added since the base.

When both sides change the same file, the planner attempts a **line-level three-way merge** using the diff3 algorithm (`epiclabs-io/diff3`). If changes are on non-overlapping lines, the file is auto-merged with both sets of changes applied. Only files with true line-level overlaps are classified as conflicts. Binary files (containing null bytes) and files without a base version skip auto-merge and go directly to conflict.

## Conflict Resolution Strategies

In all modes, files with non-overlapping changes are auto-merged first via diff3. The conflict resolution strategy only applies to files with true line-level conflicts:

| Flag       | Mode         | Behavior                                          |
|------------|--------------|---------------------------------------------------|
| (default)  | Agent        | Invokes AI agent with base/current/source content |
| `--manual` | Manual       | Writes `<<<<<<<`/`=======`/`>>>>>>>` markers      |
| `--theirs` | Theirs       | Takes the source version for all conflicts        |
| `--ours`   | Ours         | Keeps the current version for all conflicts       |

When agent resolution fails for a file, the merge falls back to manual conflict markers for that file.

Implementation: `cli/cmd/fst/commands/merge.go` (`ConflictMode`, conflict handling in `runMerge`), `cli/internal/workspace/merge.go` (`ApplyMerge`).

## Conflict Detection

The `cli/internal/conflicts/conflicts.go` package provides two detection functions:

### `Detect(root, otherRoot, includeDirty)`

Asymmetric conflict detection. Uses the current workspace's `base_snapshot_id` as the common ancestor. The current workspace always uses live filesystem files. The other workspace uses live files if `includeDirty=true`, otherwise its latest snapshot.

### `DetectFromAncestor(root, otherRoot, commonAncestorID, includeDirty)`

Symmetric conflict detection with an explicit ancestor ID. When `includeDirty=false`, both sides use their latest snapshots. When `includeDirty=true`, both sides use current filesystem files. Used by `fst drift` for accurate conflict reporting.

### Line-Level Conflicts

For each file modified in both workspaces since the ancestor:
1. Load base, local, and remote file contents via blob accessors
2. Compute changed line ranges using `go-diff/diffmatchpatch` for base-to-local and base-to-remote
3. Find overlapping line ranges between the two sets of changes
4. Build `Hunk` records with start/end lines and content previews

### Types

```go
type FileConflict struct {
    Path  string
    Hunks []Hunk
}

type Hunk struct {
    StartLine    int
    EndLine      int
    CurrentLines []string  // local version at conflict region
    SourceLines  []string  // remote version at conflict region
    BaseLines    []string  // ancestor version at conflict region
}

type Report struct {
    BaseSnapshotID   string
    Conflicts        []FileConflict
    OverlappingFiles []string  // modified in both, may or may not conflict
    TrueConflicts    int       // count of files with actual line overlaps
}
```

## Dry Run

`fst merge --dry-run` previews the merge without modifying files. It shows:
- The merge plan (files to apply, conflicts, in-sync)
- Line-level conflict details with region line numbers and content previews
- Auto-merged file count (files modified in both workspaces with non-overlapping line changes)
- Optional AI summary with `--agent-summary`

## The `fst diff` Command

Shows line-by-line content differences between two workspaces. Unlike `fst drift` (which shows file-level changes from a common ancestor), `fst diff` compares current filesystem contents directly between two workspaces using `go-diff/diffmatchpatch`.

Options:
- No argument: diffs against the upstream workspace
- Workspace name or path as argument
- `--names-only`: list changed files without content
- `--context` / `-C`: context lines around changes
- File arguments to filter specific files

Implementation: `cli/cmd/fst/commands/diff.go` (`runDiff`).

## DAG Diagrams

After a merge completes, a mini DAG diagram is printed showing the two input heads converging into the merged snapshot:

```
  my-workspace      feature
       │                │
   a1b2c3d4        i9j0k1l2
       ╰────────┬───────╯
            y5z6a7b8
         Merged feature
       (base: q7r8s9t0)
```

When conflicts require manual resolution (`--manual`), the diagram shows a `(pending)` state with the conflict count instead of a merged snapshot ID:

```
  my-workspace      feature
       │                │
   a1b2c3d4        i9j0k1l2
       ╰────────┬───────╯
           (pending)
         Merged feature
    (3 conflicts to resolve)
       (base: q7r8s9t0)
```

The `--dry-run` flag also shows a diagram with `merge?` as the merged snapshot placeholder. Diagrams use Unicode box-drawing characters when the terminal supports UTF-8, falling back to ASCII otherwise.

## Merge Safety

- The merge aborts if uncommitted local changes overlap with files the merge would touch
- A pre-merge auto-snapshot is created when the target has dirty changes (skip with `--no-pre-snapshot`)
- After a conflict-free merge, a post-merge snapshot is created automatically
- Merge parents (both heads) are recorded in `.fst/merge-parents.json` for the next snapshot
- `--force` allows merge without a common base (two-way merge, treats all changes as additions)
- `--abort` clears pending merge state

## Related Docs

- [Snapshots](snapshots.md) -- merge base found via DAG traversal
- [Drift](drift.md) -- `fst drift` uses conflict detection to report risks
- [Sync](sync.md) -- sync uses the same merge machinery for remote changes
- [Workspaces](workspaces.md) -- merge operates between workspace directories
