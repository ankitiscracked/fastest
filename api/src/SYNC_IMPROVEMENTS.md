# File Sync Improvements

This document describes the improvements made to the file syncing system between OpenCode and R2 storage.

## Overview

The file sync system handles:
1. **File Collection** - Scanning workspace files and computing hashes
2. **Blob Upload** - Uploading file contents to R2 storage
3. **Manifest Management** - Creating and storing file manifests
4. **Workspace Sync** - Syncing workspaces with the main workspace

## Improvements Implemented

### 1. Optimistic Locking for Workspace Updates

**Problem**: Multiple concurrent sync operations on the same workspace could cause race conditions, leading to lost changes.

**Solution**: Added a `version` column to the workspaces table and implemented optimistic locking.

**Location**: `routes/workspaces.ts` (sync/execute endpoint)

**How it works**:
- Read the current workspace version when starting a sync
- When updating the workspace, include a version check in the WHERE clause
- Increment the version on successful update
- If the version changed (concurrent modification), return 409 Conflict and trigger rollback

```sql
-- Schema change
ALTER TABLE workspaces ADD COLUMN version INTEGER NOT NULL DEFAULT 1;

-- Update with optimistic lock
UPDATE workspaces
SET fork_snapshot_id = ?, version = version + 1, last_seen_at = ?
WHERE id = ? AND version = ?
```

### 2. Manifest Integrity Validation

**Problem**: A manifest could reference blob hashes that don't exist in R2, causing restore failures.

**Solution**: Validate that all blob hashes in a manifest exist in R2 before saving.

**Location**: `sync_utils.ts` (`validateManifestIntegrity`)

**How it works**:
- Extract all unique hashes from the manifest
- Check each hash exists in R2 using `BLOBS.head()`
- Return validation result with list of missing blobs
- If validation fails, rollback uploaded blobs and return error

### 3. Rollback on Partial Sync Failure

**Problem**: If a sync operation failed partway through, orphaned blobs would remain in R2.

**Solution**: Track uploaded resources and rollback on failure.

**Location**: `sync_utils.ts` (`createRollbackContext`, `executeRollback`, `uploadBlobWithRollback`)

**How it works**:
- Create a rollback context at the start of sync
- Track each blob uploaded using `uploadBlobWithRollback()`
- On any error, call `executeRollback()` to delete tracked resources
- Log any rollback errors for debugging

```typescript
const rollbackContext = createRollbackContext();

try {
  await uploadBlobWithRollback(blobs, userId, hash, content, rollbackContext);
  // ... more operations
} catch (error) {
  const result = await executeRollback(blobs, userId, rollbackContext);
  // Handle rollback result
}
```

### 4. Retry Logic with Exponential Backoff

**Problem**: Transient network failures would cause immediate sync failure with no recovery.

**Solution**: Wrap network operations with retry logic using exponential backoff.

**Location**: `sync_utils.ts` (`withRetry`, `fetchWithRetry`)

**Configuration**:
- `maxRetries`: 3 (default)
- `initialDelayMs`: 1000ms
- `maxDelayMs`: 10000ms
- `backoffMultiplier`: 2

**How it works**:
- Retry on network errors, timeouts, and 5xx server errors
- Exponential backoff: 1s → 2s → 4s
- Don't retry on 4xx client errors (these are not transient)

```typescript
const response = await fetchWithRetry(
  url,
  { method: 'POST', body: JSON.stringify(data) },
  { maxRetries: 3 }
);
```

### 5. Skipped File Tracking

**Problem**: Files that failed hash computation were silently skipped, making debugging difficult.

**Solution**: Track skipped files with reasons and include in sync result.

**Location**: `conversation_files.ts` (`collectAndUploadFiles`)

**Tracked information**:
- `skippedFiles`: Files that couldn't be processed (with reason)
- `failedFiles`: Files that failed to upload (with error)
- `uploadedFiles`: Count of successfully uploaded files
- `existingFiles`: Count of files already in R2 (deduplication)

```typescript
const result = await files.collectAndUploadFiles(...);
console.log(result.uploadStats);
// {
//   totalFiles: 100,
//   uploadedFiles: 45,
//   existingFiles: 50,
//   skippedFiles: [{ path: "binary.bin", reason: "Hash computation failed" }],
//   failedFiles: [{ path: "large.zip", hash: "abc...", error: "Upload timeout" }]
// }
```

### 6. Parallel Blob Uploads

**Problem**: Sequential blob uploads were slow for large workspaces.

**Solution**: Upload blobs in parallel with a concurrency limit.

**Location**: `sync_utils.ts` (`pMap`), `conversation_files.ts`

**Configuration**:
- Default concurrency: 5 parallel uploads
- Continues on error (doesn't fail entire sync for one bad file)

```typescript
await pMap(
  filesToUpload,
  async (file) => { /* upload logic */ },
  { concurrency: 5, stopOnError: false }
);
```

### 7. Blob Garbage Collection

**Problem**: Orphaned blobs accumulate over time, wasting storage.

**Solution**: Added garbage collection endpoint to find and delete orphaned blobs.

**Location**: `routes/blobs.ts` (`POST /gc`), `sync_utils.ts` (`collectGarbage`)

**API**:
```bash
# Dry run (find orphans without deleting)
POST /v1/blobs/gc
{ "dryRun": true, "maxBlobs": 10000 }

# Actually delete orphans
POST /v1/blobs/gc
{ "dryRun": false, "maxBlobs": 10000 }
```

**Response**:
```json
{
  "success": true,
  "dryRun": true,
  "scannedBlobs": 5000,
  "orphanedBlobs": 150,
  "freedBytes": 52428800,
  "freedMB": 50.0,
  "message": "Found 150 orphaned blobs (50.0 MB). Run with dryRun=false to delete."
}
```

**Also added**: Storage stats endpoint
```bash
GET /v1/blobs/stats
```

## Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| `SYNC_FAILED` | 500 | Sync failed and changes were rolled back |
| `MANIFEST_INVALID` | 500 | Manifest validation failed (missing blobs) |
| `CONCURRENT_MODIFICATION` | 409 | Optimistic lock failed (retry the sync) |
| `PREVIEW_EXPIRED` | 404 | Sync preview expired (prepare again) |

## Testing

### Test Optimistic Locking
1. Start a sync on workspace A
2. Before completing, start another sync on workspace A
3. One should succeed, the other should return 409 Conflict

### Test Rollback
1. Mock a blob upload failure
2. Verify that previously uploaded blobs are deleted
3. Verify the error response includes rollback information

### Test Retry Logic
1. Mock transient network failures (first 2 attempts fail)
2. Verify the operation succeeds on the 3rd attempt
3. Verify exponential backoff timing

### Test Garbage Collection
1. Create some manifests with blob references
2. Upload some blobs not referenced by any manifest
3. Run GC with `dryRun: true` to find orphans
4. Run GC with `dryRun: false` to delete them
5. Verify referenced blobs are preserved

## Performance Considerations

- **Parallel uploads**: Configurable concurrency (default 5) balances speed vs. resource usage
- **Garbage collection**: Should be run as a scheduled job, not on every request
- **Manifest validation**: Checks blobs in parallel (concurrency 20)
- **Retry delays**: Exponential backoff prevents thundering herd

## Future Improvements

1. **Streaming uploads** for large files (avoid loading entire file into memory)
2. **Chunked uploads** for files > 100MB
3. **Scheduled GC job** instead of manual endpoint
4. **Metrics/observability** for sync operations
5. **Rate limiting** on GC to prevent excessive R2 operations
