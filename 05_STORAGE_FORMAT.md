# Storage format (v1): blobs + manifests

## Goals
- Deterministic snapshot IDs (via manifest hash)
- Deduped uploads/downloads
- Cross-platform reproducibility

---

## Blob hashing
- Hash algorithm: **SHA-256**
- Blob key: `sha256:<hex>` (store as hex; key path uses the hex)

### What is hashed?
- File bytes exactly as on disk
- No normalization (no CRLF conversion)

### Exclusions (default ignores)
- `.git/`
- `.fast/`
- `node_modules/`
- build outputs (`dist/`, `build/`, `.next/`) — configurable

---

## Manifest schema

### File record
Each record:
- `path` (posix style `/` separators)
- `mode` (int; include executable bit)
- `size` (int)
- `sha256` (hex)
- `mtime` is *not* included (non-deterministic)

### Manifest JSON (versioned)
```json
{
  "version": 1,
  "created_at": "2026-01-13T00:00:00Z",
  "root": {
    "total_files": 123,
    "total_bytes": 456789
  },
  "files": [
    {"path":"package.json","mode":420,"size":1234,"sha256":"..."},
    {"path":"src/index.ts","mode":420,"size":5678,"sha256":"..."}
  ]
}
```

### Determinism rules
To ensure identical manifests:
- Convert all paths to `/`
- Sort `files` by `path` ascending
- Use UTF-8 JSON with stable formatting for hashing:
  - recommended: canonical JSON (minified, sorted keys)
- Manifest hash:
  - `sha256(canonical_manifest_bytes)`

Store the manifest object under:
- `manifests/<manifest_hash>.json`

---

## Object store layout (cloud mode)
- `blobs/<sha256>`
- `manifests/<manifest_hash>.json`

Optional:
- `exports/git/<project_id>/<snapshot_id>.tar.gz` (later)

---

## Upload optimization

Preferred flow:
1) CLI computes required blob hashes
2) CLI asks API which hashes are missing
3) CLI uploads only missing blobs
4) CLI uploads manifest
5) CLI registers snapshot referencing manifest hash

This avoids redundant PUT attempts.

API to support:
- `POST /blobs/exists` with list of hashes → returns missing set
or
- `POST /blobs/presign-upload` returns URLs only for missing

---

## Materialization (clone)
Given a manifest:
- create directories
- write file bytes from blobs
- set file mode (exec bit)
