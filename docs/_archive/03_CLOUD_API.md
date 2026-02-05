# Cloud control plane – V1

## Responsibilities
- Auth
- Project registry
- Snapshot registry
- Blob storage coordination
- Project status tracking

---

## API (minimal)

### Auth
POST /auth/login
GET  /me

### Projects
POST /projects
GET  /projects
GET  /projects/:id

### Snapshots
POST /projects/:id/snapshots
GET  /projects/:id/snapshots
GET  /snapshots/:id

### Blobs
POST /blobs/sign-upload
POST /blobs/sign-download

---

## Storage layout (object store)
blobs/{sha256}
manifests/{manifest_hash}.json
