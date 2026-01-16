# Local-only mode (non-cloud offering)

## Goal
Everything works on one machine without an account:
- projects
- snapshots
- status
- optional git export

## Local storage layout (per project)
```
.fast/
  local.json                 # local project identity + settings
  snapshots/
    <manifest_hash>.json     # manifests
  blobs/
    <sha256>                 # blob store
  status.json                # last snapshot id, timestamps
  events.ndjson              # optional append-only log
```

## Local commands
- `fast init --local`
- `fast snapshot --local`
- `fast clone --local <snapshot_id>`
- `fast status --local`
- `fast export git ...`

## Compatibility principle
Use the **same manifest format** in local and cloud mode so:
- local snapshots can later be uploaded
- cloud snapshots can be cloned locally

## Agents (optional in v1)
Local-only mode can optionally invoke user-installed agent CLIs to generate patches,
but this is not required for the “sync foundation”.
If included:
- agents only propose patches
- CLI applies patch then snapshots

(Agent adapters can be Phase 2+.)
