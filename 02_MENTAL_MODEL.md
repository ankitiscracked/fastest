# Mental model

## Primitives (v1)

### Project
A container for identity and history.
- stable ID
- human-friendly name (can collide; ID cannot)

### Snapshot
An immutable “project state”:
- content-addressed
- reproducible
- upload/download deduped by blob hashes

### Status
A small, shared “what’s current” view:
- latest snapshot
- last activity (what happened last)
- timestamps

---

## What “sync” means

When cloud is enabled:
- the Project registry is shared
- snapshot history is shared
- status is shared

So:
- Create in CLI → visible in Web
- Create in Web → pull/link in CLI
- Snapshot in CLI → visible in Web, clonable anywhere

---

## What “resume work” means (v1)

It does **not** mean resuming a running process.

It means:
1) identify the latest snapshot for a project (or env head if you use envs)
2) materialize it locally (`fast clone`)
3) continue from that state

---

## Out of scope (v1)

- remote command execution
- streaming logs / attach
- multi-workspace parallel merging
- changesets / semantic diff merging
- cloud sandboxes

We can add these later once the foundation is stable.
