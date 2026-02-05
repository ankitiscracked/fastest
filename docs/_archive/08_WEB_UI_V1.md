# Web UI spec (v1)

## Principles
- No file editor
- No remote execution
- Web is a *mirror* of cloud state: projects + snapshots + status

## Pages

### 1) Auth
- Login screen
- “Enter code” (if magic-link flow uses code)
- Logout

### 2) Projects list
- Create project
- List projects:
  - name
  - last updated
  - last snapshot id (short)
- Search/filter (optional)

### 3) Project detail
- Project name + ID (copy)
- “CLI quick actions” (copy/paste commands):
  - `fast link <project_id>`
  - `fast clone <project_id>`
  - `fast snapshot` (run inside linked repo)
- Status card:
  - last snapshot
  - last activity timestamp
- Recent events (optional):
  - last 10 actions: created, snapshot pushed, snapshot pulled, git exported
- Snapshots preview (latest 10)

### 4) Snapshots list (per project)
- Table:
  - snapshot id
  - created_at
  - parent snapshot (optional)
  - source
- Actions:
  - copy snapshot id
  - show “clone command”

### 5) Snapshot detail
- Snapshot metadata
- Manifest summary:
  - total files
  - total bytes
- Optional: download manifest JSON

### 6) Settings (v1 minimal)
- API base URL (for debugging)
- Account info

---

## UX success criteria
A user on mobile should be able to:
- create a project
- see snapshots as they are pushed from CLI
- copy the exact command to pull/clone and continue on another machine

That alone validates the “web + cli in sync” promise.
