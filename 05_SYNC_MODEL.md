# Sync model – V1

## What is synced
- Projects
- Snapshots
- Project status

## What is NOT synced
- Running processes
- Local filesystem
- Agent state
- Logs

---

## Sync rules
- CLI pushes snapshots explicitly.
- Cloud never mutates code.
- Web UI reflects last known snapshot.
- CLI pulls snapshots explicitly.

---

## Resume semantics
'Resume' means:
- pull latest snapshot
- continue work locally
