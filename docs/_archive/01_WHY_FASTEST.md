# WHY FASTEST EXISTS

## Executive summary

Fastest exists because **agentic programming changes what “coordination” means**.

The pain is not “writing code”. The pain is:
- juggling multiple partial attempts (human + agent)
- keeping “the current state” reliable across machines
- reducing ceremony (branches/PRs) for rapid iteration
- continuing work from anywhere (especially when you’re off your laptop)

Git is excellent at *history*, but it is not a coordination system for agent-driven workflows. It does not give you:
- a clear “project status” that is consistent across interfaces
- a first-class notion of “current state” for staging/prod
- a clean way to sync projects between a CLI and a web console without forcing a Git workflow

Fastest introduces a simpler coordination layer built around:
- **Projects** (identity)
- **Snapshots** (immutable states)
- **Status** (what’s current and what happened last)

In v1, that’s it.

---

## What changed in our approach (and why)

We intentionally removed early complexity:
- No remote execution from the web
- No streaming logs
- No “attach to laptop”
- No job protocol / device runner security model

Reason: those features are valuable, but they create large security and operational surfaces and aren’t required to validate the core idea.

**v1 validates the foundation first:**
> “A project created on the CLI shows up on the web, and vice versa.  
> The latest state is reliably shareable via snapshots.  
> Git export is optional, not mandatory.”

Once this works, more advanced “agentic” features (workspaces, changesets, merges, remote runners) can be layered on safely.

---

## The core user story (v1)

1. I start a project on my laptop using `fast`.
2. The same project appears in the Fastest web UI.
3. I push snapshots as the project evolves.
4. On another machine (or later), I can pull/clone the project’s latest snapshot and continue.
5. If I don’t want cloud, I can still do everything locally and optionally export to Git for backup/hosting.

---

## Non-negotiables

### Trust
- Cloud mode must not feel like lock-in.
- Users can always export to Git.
- Local-only mode remains viable.

### Determinism
- Snapshot creation is deterministic (same tree => same manifest hash).
- Upload is content-addressed and deduped.

### Symmetry (within scope)
- CLI and Web are two interfaces over the same project registry and snapshot history.
- “Resume” means pulling/cloning the latest snapshot, not resuming a running process.

---

## One sentence summary

> Fastest exists to make agent-driven software iteration feel natural by syncing project identity and state across interfaces, without forcing a Git-centric workflow.
