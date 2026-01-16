# Test plan (v1)

## Unit tests

### CLI
- Ignore rules correctness
- Deterministic manifest generation:
  - same tree → same manifest bytes → same hash
- Path normalization (`\` to `/`)
- File mode handling (exec bit)

### API
- Auth flows
- Project CRUD permissions
- Snapshot registration idempotency
- Blob exists endpoint correctness

## Integration tests

### Cloud sync happy path
1) Create project (web)
2) Link project (cli)
3) Push snapshot (cli)
4) See snapshot + status in web
5) Clone snapshot (cli on fresh dir)
6) Compare directory hashes

### Idempotency
- Repeat `fast snapshot` without changes:
  - no new blobs uploaded
  - snapshot registration returns existing snapshot or creates deduped one

### Failure recovery
- Simulate network failure mid-upload:
  - resume and complete
- Manifest uploaded but snapshot register fails:
  - retry register and succeed

## Manual QA checklist
- Web UI on mobile viewport
- Copy/paste CLI commands from web works
- Git export creates usable repo
