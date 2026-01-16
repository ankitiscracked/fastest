# Fast (CLI) spec (v1)

## Commands

### Auth
- `fast login`
- `fast logout`
- `fast whoami`

### Projects
- `fast init` (create or link; creates `.fast/`)
- `fast link <project_id>` (bind current directory to project)
- `fast projects` (list cloud projects)
- `fast project <project_id>` (detail)

### Snapshots (cloud mode)
- `fast snapshot`
  - scans dir, hashes blobs, uploads missing, uploads manifest, registers snapshot
- `fast pull`
  - fetch latest project metadata + latest snapshot id
- `fast clone <project_id|snapshot_id> [--to <dir>]`
  - downloads manifest + blobs and materializes to directory

### Local-only mode (no cloud)
- `fast snapshot --local`
- `fast clone --local <snapshot_id>`
- `fast status --local`

### Git export
- `fast export git --snapshot <snapshot_id> --repo <path>`
- `fast export git --project <project_id> --repo <path>` (exports latest snapshot)

---

## Local state directory

In each project working directory:
```
.fast/
  config.json          # project binding + api url + mode
  auth.json            # token reference (or empty if stored in keychain)
  cache/
    blobs/<sha256>     # optional local cache
  manifests/<hash>.json
```

In local-only mode, `.fast/` also stores:
- local snapshots registry
- local status + events

---

## Snapshot algorithm (v1)
1) Load ignore rules (defaults + optional `.fastignore`)
2) Walk files
3) For each file:
   - read bytes
   - sha256
   - record size + mode + path
4) Build manifest:
   - paths normalized to `/`
   - sorted by path
5) Hash canonical JSON manifest
6) Cloud mode:
   - ask server which blobs are missing
   - upload missing
   - upload manifest
   - register snapshot
7) Update local cache and status

---

## Reliability requirements
- Upload is resumable-ish (retry blobs individually)
- If manifest upload succeeds but snapshot registration fails:
  - registration is retryable and idempotent by (project_id, manifest_hash)
