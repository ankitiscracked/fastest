# API spec (v1)

All endpoints are assumed under `/v1`.

## Auth
- `POST /auth/start` → start login (magic link / code)
- `POST /auth/complete` → exchange code for token
- `GET /me` → current user

## Projects
- `POST /projects`
  - body: `{ name, slug? }`
  - returns: `{ project }`
- `GET /projects`
  - returns: `{ projects: [...] }`
- `GET /projects/:projectId`
  - returns: `{ project, status, last_events? }`

## Snapshots
- `POST /projects/:projectId/snapshots`
  - body: `{ manifest_hash, parent_snapshot_id? , source }`
  - server validates manifest exists in object store (optional in v1)
  - updates `projects.last_snapshot_id`
- `GET /projects/:projectId/snapshots?limit=50`
- `GET /snapshots/:snapshotId`
  - returns: `{ snapshot, manifest_url }` (signed)

## Blob store helpers
### Preferred: exists + presign
- `POST /blobs/exists`
  - body: `{ hashes: ["<sha256>", ...] }`
  - returns: `{ missing: ["<sha256>", ...] }`

- `POST /blobs/presign-upload`
  - body: `{ hashes: ["<sha256>", ...] }` (typically only missing)
  - returns: `{ urls: { "<sha256>": "<signed_put_url>", ... } }`

- `POST /blobs/presign-download`
  - body: `{ hashes: ["<sha256>", ...] }`
  - returns: `{ urls: { "<sha256>": "<signed_get_url>", ... } }`

### Manifests
- `POST /manifests/presign-upload`
  - body: `{ manifest_hash }`
  - returns: `{ url }`

- `POST /manifests/presign-download`
  - body: `{ manifest_hash }`
  - returns: `{ url }`

## Status (optional standalone)
- `GET /projects/:projectId/status`
  - returns: `{ last_snapshot_id, updated_at, last_activity? }`

## Events (optional but recommended)
- `GET /projects/:projectId/events?limit=20`
- `POST /projects/:projectId/events` (server-internal or CLI-reported)

---

## Error conventions
- 401 unauthorized
- 403 forbidden
- 404 not found
- 409 conflict (e.g., duplicate project slug)
- 422 validation errors

Return shape:
```json
{ "error": { "code": "SOME_CODE", "message": "Human readable", "details": {...} } }
```
