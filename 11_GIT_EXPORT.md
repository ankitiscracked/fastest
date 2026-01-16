# Git export (v1)

## Why
- Reliability: users can host on GitHub/GitLab
- Trust: no lock-in
- Works in both cloud and local-only modes

## Supported exports

### Snapshot → commit
`fast export git --snapshot <snapshot_id> --repo <path>`

Behavior:
- materialize snapshot into a temp dir
- init git repo if missing
- copy files into repo working tree
- commit with message:
  - `fastest: snapshot <snapshot_id>`
- tag optional: `fastest/snapshot/<snapshot_id>`

### Project latest → commit
`fast export git --project <project_id> --repo <path>`
- resolves latest snapshot from cloud and exports it

## Non-goals (v1)
- Import from git
- Two-way sync
- Preserving existing git history perfectly (we overwrite working tree)

## Safety
- Default behavior should refuse if repo has uncommitted changes unless `--force`.
