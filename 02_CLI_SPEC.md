# CLI (Fast) specification – V1

## Responsibilities
- Run agents locally (BYO agent CLIs).
- Create snapshots from local filesystem.
- Sync snapshots to/from cloud.
- Export snapshots to Git.
- Maintain local continuity.

---

## Local state layout
.fast/
  project.json        # project_id, api_url
  snapshots/
    manifests/
    blobs/
  status.json         # last snapshot pulled/pushed
  config.json         # ignore rules, agent config

---

## Commands

### fast init
- Create project in cloud OR local-only.
- Write .fast/project.json.

### fast projects
- List cloud projects.

### fast link <project_id>
- Bind current folder to existing cloud project.

### fast snapshot
- Walk filesystem.
- Apply ignore rules.
- Create manifest + blobs.
- Upload missing blobs.
- Register snapshot.
- Update local + cloud status.

### fast pull
- Fetch latest snapshot metadata.
- Update local status.

### fast clone <project|snapshot>
- Materialize snapshot to directory.

### fast export git
- Snapshot → commit.
- Env-less in V1.
- Works offline.

---

## Agent integration (local)
- CLI invokes user-installed agents.
- Agents output patches only.
- CLI applies patch, then snapshots.
