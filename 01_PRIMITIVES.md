# Core primitives (V1)

## 1. Project
Represents a logical software project.

Fields:
- project_id (ULID / UUIDv7, immutable)
- name (string, user-facing, non-unique)
- owner_id
- created_at
- updated_at

Rules:
- Names may collide; IDs never do.
- All other objects belong to a project.

---

## 2. Snapshot
An immutable representation of the project state at a moment in time.

Fields:
- snapshot_id
- project_id
- manifest_hash
- created_at
- parent_snapshot_id (optional)

Rules:
- Snapshots are immutable.
- Parent is optional but recommended.
- Snapshots are content-addressed via manifest_hash.
- Snapshot IDs are deterministic: `snap-<manifest_hash>`.

---

## 3. File index (manifest)
Describes a snapshot's file tree.

Schema:
- version
- created_at
- files[]:
  - path
  - mode
  - size
  - sha256
- root_hash = sha256(canonical(manifest))

Rules:
- Canonical JSON encoding (sorted keys).
- Ignore rules applied before hashing.
- Line endings normalized.

---

## 4. Project Status
Derived or stored summary shown in UI.

Fields:
- project_id
- last_snapshot_id
- last_activity_type
- last_activity_at

Activity types:
- project_created
- snapshot_pushed
- snapshot_pulled
- git_exported
