# Implementation plan (phased, detailed)

This plan keeps v1 small but complete: **Project + Snapshot + Status sync**.

## Phase A — Repo + scaffolding (Day 1–2)

### Deliverables
- Monorepo (recommended):
  - `cli/` (Go)
  - `api/` (TS control plane)
  - `web/` (TS web UI)
  - `shared/` (schemas/types)
  - `docs/`

### Decisions to lock
- IDs: ULID or UUIDv7 (prefer ULID for lexicographic sorting)
- Hash: SHA-256 for blobs + manifest
- Ignore defaults: `.git/`, `.fast/`, `node_modules/`, `.next/`, `dist/`, `build/`

### Exit criteria
- `fast --help` works
- API health endpoint works
- Web boots and can login page stub

---

## Phase B — Auth (Day 2–5)

### Goal
One login works for CLI and Web.

### Deliverables
- Auth approach: **magic-link + one-time code** (fastest to ship) or OAuth device flow
- Token model:
  - short-lived access token (JWT or opaque)
  - long-lived refresh token (optional in v1)
- CLI secure storage:
  - keychain where available
  - fallback to encrypted file (acceptable for v1)

### Exit criteria
- Web login creates a session
- CLI `fast login` obtains token and can call `GET /me`

---

## Phase C — Projects (Day 4–7)

### Goal
Create/list/view projects in both CLI and Web.

### Deliverables
- API:
  - `POST /projects`
  - `GET /projects`
  - `GET /projects/:id`
- DB:
  - projects table + indexes
- CLI:
  - `fast init` (create or link)
  - `fast projects` (list)
  - `fast project <id>` (detail)
- Web:
  - projects list
  - create project modal
  - project detail page (copy project id)

### Exit criteria
- Create in CLI → visible in Web
- Create in Web → visible in CLI

---

## Phase D — Snapshot format + local hashing (Day 6–12)

### Goal
Deterministic snapshot manifest and blob hashing.

### Deliverables
- Manifest schema (see `05_STORAGE_FORMAT.md`)
- CLI can:
  - scan files with ignore rules
  - compute SHA-256 for each file
  - produce stable sorted manifest
  - compute manifest hash

### Exit criteria
- Two machines produce identical manifest hash for identical trees

---

## Phase E — Blob store + snapshot registry (Day 10–18)

### Goal
Upload/download snapshots to/from cloud.

### Deliverables
- Object store layout:
  - `blobs/<sha256>`
  - `manifests/<manifest_hash>.json`
- API:
  - `POST /blobs/presign-upload`
  - `POST /blobs/presign-download`
  - `POST /projects/:id/snapshots` (register snapshot by manifest hash + optional parent)
  - `GET /projects/:id/snapshots`
  - `GET /snapshots/:id`
- CLI:
  - `fast snapshot` (upload missing blobs, upload manifest, register snapshot)
  - `fast pull` (fetch snapshot list/head)
  - `fast clone <project|snapshot>` (download blobs+manifest, materialize)

### Exit criteria
- Push snapshot from laptop A
- Clone on laptop B is byte-for-byte identical

---

## Phase F — Status sync (Day 16–22)

### Goal
Both interfaces show the same “current status”.

### Deliverables
- Minimal status model (derived or stored):
  - `projects.updated_at` + `last_snapshot_id`
  - optional events table (append-only)
- API:
  - `GET /projects/:id/status` (or include in project detail)
- Web:
  - project list shows last updated + last snapshot
  - project detail shows recent activity (optional)

### Exit criteria
- After `fast snapshot`, web UI updates status within seconds

---

## Phase G — Git export (Day 20–26)

### Goal
Users can host elsewhere (GitHub/GitLab) even if they don’t use cloud.

### Deliverables
- `fast export git`:
  - snapshot → commit in an existing or new git repo
  - env heads optional (if you add envs)
- Commit message deterministic; optional later to use agent summary

### Exit criteria
- Fresh repo can be reconstructed from snapshots and pushed

---

## Phase H — Local-only mode hardening (Day 24–30)

### Goal
Cloud-disabled mode still provides a full experience locally.

### Deliverables
- local snapshot store + manifest cache
- local status + history
- local commands mirror cloud commands (where applicable)

### Exit criteria
- Entire workflow works without an account, and Git export works

---

## Phase I — UX polish + packaging (Day 28–35)

### Deliverables
- Homebrew install (or curl install)
- Web UI mobile-friendly layout
- Error messages and recovery flows

---

## Milestone definition: v1 “Validation Complete”

You can:
- create projects in CLI or Web
- push snapshots from CLI
- view status and snapshots in Web
- pull/clone on another machine
- export to Git (cloud optional)
