# Storage

This document describes how Fastest stores file content, manifests, and metadata both locally and in the cloud.

## Content-addressed blobs

Every tracked file is hashed with SHA-256. The hash serves as the blob identifier everywhere: in the manifest, in the local blob cache, and in cloud storage (R2).

Hashing is implemented in `cli/internal/manifest/manifest.go`:

```go
func HashFile(path string) (string, error) {
    f, err := os.Open(path)
    h := sha256.New()
    io.Copy(h, f)
    return hex.EncodeToString(h.Sum(nil)), nil
}
```

Blob identity is content-based: two files with identical content share the same hash and are stored once.

## Local directory layout

When `fst workspace init` runs, it creates the `.fst/` directory inside the workspace root. Structure:

```
<workspace-root>/
  .fst/
    config.json            # ProjectConfig (project_id, workspace_id, etc.)
    .gitignore             # Excludes snapshots/, manifests/, blobs/ from Git
    author.json            # Optional project-level author identity override
    snapshots/
      <snap-id>.meta.json  # Snapshot metadata (id, manifest_hash, parents, author, message)
    manifests/
      <hash>.json          # Full manifest JSON, keyed by SHA-256 of content
    blobs/
      <hash>               # Raw file content, keyed by SHA-256
    stat-cache.json        # Stat cache for fast manifest generation (mtime/size/mode/inode)
    merge-parents.json     # Temporary: pending merge parent IDs (during merge)
  .fstignore               # Ignore patterns for file scanning
```

The `.fst/.gitignore` is auto-created to exclude `snapshots/`, `manifests/`, `blobs/`, `*.log`, `merge-parents.json`, and `stat-cache.json` from Git tracking.

Config constants are defined in `cli/internal/config/config.go`:

- `ConfigDirName = ".fst"`
- `ConfigFileName = "config.json"`
- `SnapshotsDirName = "snapshots"`
- `ManifestsDirName = "manifests"`
- `BlobsDirName = "blobs"`

## Blob storage

File contents are stored at the project level so rollback and workspace operations can restore files without re-downloading from cloud. When a workspace is under a project (has `fst.json`), blobs are stored in the project-level `.fst/blobs/`. For standalone workspaces, blobs are stored in the workspace-local `.fst/blobs/`.

Each blob is stored as a flat file named by its SHA-256 hash:

```
<project-root>/.fst/blobs/
  a3f2b1c4d5e6...   # raw file content
  b7e8f9a0c1d2...
```

Blobs are written during `fst snapshot` (caches all current file contents) and during `fst workspace clone` / `fst pull` (caches downloaded blobs). The `fst rollback` command reads from this store to restore files.

Implemented in `config.GetBlobsDir()` and `config.GetBlobsDirAt()` which follow the same project-level resolution as snapshots and manifests. Orphaned blobs are cleaned up by `fst gc`.

## Global workspace index

All workspaces on the machine are registered in `~/.config/fst/index.json` (respects `XDG_CONFIG_HOME`). This allows commands like `fst merge <name>` and `fst workspaces` to resolve workspace names to filesystem paths without requiring cloud access.

Defined in `cli/internal/index/index.go`. The index contains both project and workspace entries with their paths, IDs, and timestamps.

## Manifest format

A manifest is a JSON document with version and a sorted array of file entries:

```json
{
  "version": "1",
  "files": [
    { "type": "dir", "path": "src", "mode": 493 },
    { "type": "file", "path": "src/main.go", "hash": "abc123...", "size": 512, "mode": 420 },
    { "type": "symlink", "path": "link", "target": "src/main.go" }
  ]
}
```

Files are sorted by path (then by type for same path) for reproducibility. The manifest hash is SHA-256 of the canonical JSON output from `json.MarshalIndent(m, "", "  ")`.

Three entry types are supported (see `cli/internal/manifest/manifest.go`):

- `file` -- regular file with hash, size, mode
- `dir` -- directory with mode
- `symlink` -- symbolic link with target path

The `mod_time` field is omitted by default (`Generate(root, false)`) for reproducible hashes. It can be included for caching purposes.

## Cloud storage (R2)

Blobs and manifests are stored in a Cloudflare R2 bucket, scoped per user:

- Blobs: `{user_id}/blobs/{sha256_hash}`
- Manifests: `{user_id}/manifests/{sha256_hash}.json`

The API routes in `api/src/routes/blobs.ts` handle:

1. **Existence check** (`POST /v1/blobs/exists`) -- accepts up to 100 hashes, returns which are missing
2. **Upload** (`PUT /v1/blobs/upload/{hash}`) -- verifies SHA-256 of uploaded content matches the hash, deduplicates
3. **Download** (`GET /v1/blobs/download/{hash}`) -- returns blob with immutable cache headers (`Cache-Control: public, max-age=31536000, immutable`)
4. **Manifest upload/download** (`PUT/GET /v1/blobs/manifests/{hash}`) -- same pattern as blobs but stored as JSON
5. **Garbage collection** (`POST /v1/blobs/gc`) -- finds orphaned blobs not referenced by any manifest
6. **Storage stats** (`GET /v1/blobs/stats`) -- counts and sizes for blobs and manifests

The upload flow (implemented in `snapshot.go` `uploadSnapshotToCloud`) batches blob existence checks and presigned URL requests in groups of 100 to avoid oversized API calls.

## Stat cache

Manifest generation requires walking the directory tree and SHA-256 hashing every file, which is expensive for large workspaces. The stat cache (`.fst/stat-cache.json`) accelerates read-path operations (`fst status`, `fst drift`, `fst diff`, etc.) by skipping re-hashing for files whose stat metadata hasn't changed.

Each cache entry records `(mtime_nano, size, mode, inode, hash)` for a file. On lookup, if all four stat fields match the current file, the cached hash is returned. The algorithm mirrors Git's index stat cache, including racily-clean detection: if a file's mtime is >= the cache's `written_at` timestamp, the file is re-hashed to avoid missing modifications that occurred in the same timestamp quantum as the cache write.

The cache is populated after snapshot creation (`fst snapshot`) so that subsequent status checks are near-instant. It is workspace-local (not shared at project level) and excluded from Git via `.gitignore`. Missing or corrupt cache files are silently ignored — the system falls back to full hashing.

Snapshot creation always does full hashing regardless of the cache, ensuring correctness on the write path.

Implementation: `cli/internal/manifest/statcache.go` (`GenerateWithCache`, `BuildStatCacheFromManifest`, `LoadStatCache`).

## Ignore patterns

File scanning respects `.fstignore` in the workspace root, using gitignore-style patterns. The ignore matcher is loaded in `cli/internal/ignore/` and applied during `manifest.Generate()`. A default `.fstignore` is created during `fst workspace init` with common patterns (node_modules, .git, build artifacts, etc.).
