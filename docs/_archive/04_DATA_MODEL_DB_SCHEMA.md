# Data model & DB schema (v1)

## Core entities

### users
- `id` (uuid)
- `email` (unique)
- `created_at`

### projects
- `id` (ulid/uuidv7) — canonical identity
- `owner_user_id` (fk users.id)
- `name` (string)
- `slug` (string, optional)
- `created_at`
- `updated_at`
- `last_snapshot_id` (nullable fk snapshots.id)

Indexes:
- `(owner_user_id, updated_at desc)`
- `(owner_user_id, name)` (for search)

### snapshots
- `id` (ulid)
- `project_id` (fk projects.id)
- `manifest_hash` (sha256 hex)
- `parent_snapshot_id` (nullable fk snapshots.id)
- `source` (enum: `cli`, `web`, `import`, `system`) — v1: mostly `cli`/`web`
- `created_at`

Constraints:
- unique `(project_id, manifest_hash)` (avoid duplicates)

Indexes:
- `(project_id, created_at desc)`
- `(project_id, parent_snapshot_id)`

### activity_events (optional but recommended)
Append-only “status sync” log.
- `id` (ulid)
- `project_id`
- `actor` (enum: `cli`, `web`, `system`)
- `type` (enum: `project.created`, `snapshot.pushed`, `snapshot.pulled`, `git.exported`)
- `snapshot_id` (nullable)
- `message` (nullable)
- `created_at`

Indexes:
- `(project_id, created_at desc)`

---

## Status derivation

### Minimal approach (OK for v1)
Status is:
- `projects.updated_at`
- `projects.last_snapshot_id`

Update rules:
- On snapshot registration:
  - set `projects.last_snapshot_id = snapshot.id`
  - set `projects.updated_at = now()`
  - insert `activity_events` (optional)

### Slightly richer (still easy)
Expose:
- last 20 events for project detail page.

---

## Notes on naming collisions

- Names can collide across users.
- If you use slugs: enforce uniqueness only within `(owner_user_id, slug)`.

The canonical identifier is always `project.id`.
