#!/usr/bin/env python3
import json
import os
from pathlib import Path
from datetime import datetime

HOME = Path.home()


def load_json(path: Path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None


def save_json(path: Path, data):
    path.write_text(json.dumps(data, indent=2) + "\n")


def get_global_config_dir() -> Path:
    config_home = os.environ.get("XDG_CONFIG_HOME")
    if not config_home:
        config_home = str(HOME / ".config")
    return Path(config_home) / "fst"


def find_parent_root(start: Path):
    cur = start.resolve()
    while True:
        candidate = cur / "fst.json"
        if candidate.exists():
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent


def load_snapshot_meta(meta_path: Path):
    try:
        return json.loads(meta_path.read_text())
    except Exception:
        return None


def pick_snapshot_id(snapshots_dir: Path, prefer="earliest"):
    if not snapshots_dir.exists():
        return None
    metas = []
    for meta_path in snapshots_dir.glob("*.meta.json"):
        meta = load_snapshot_meta(meta_path)
        if not meta:
            continue
        created_at = meta.get("created_at")
        if created_at:
            try:
                ts = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
            except Exception:
                ts = None
        else:
            ts = None
        metas.append((meta.get("id"), ts))
    metas = [(sid, ts) for sid, ts in metas if sid]
    if not metas:
        return None
    metas.sort(key=lambda x: (x[1] is None, x[1] or datetime.max))
    if prefer == "latest":
        return metas[-1][0]
    return metas[0][0]


def copy_base_snapshot(source_path: Path, target_path: Path, base_id: str) -> bool:
    source_snapshots = source_path / ".fst" / "snapshots"
    source_manifests = source_path / ".fst" / "manifests"
    target_snapshots = target_path / ".fst" / "snapshots"
    target_manifests = target_path / ".fst" / "manifests"

    meta_path = source_snapshots / f"{base_id}.meta.json"
    meta_data = load_json(meta_path)
    if not meta_data:
        return False
    manifest_hash = meta_data.get("manifest_hash")
    if not manifest_hash:
        return False

    manifest_path = source_manifests / f"{manifest_hash}.json"
    if not manifest_path.exists():
        return False

    target_snapshots.mkdir(parents=True, exist_ok=True)
    target_manifests.mkdir(parents=True, exist_ok=True)

    target_meta = target_snapshots / f"{base_id}.meta.json"
    target_manifest = target_manifests / f"{manifest_hash}.json"

    if not target_meta.exists():
        target_meta.write_text(json.dumps(meta_data, indent=2) + "\n")
    if not target_manifest.exists():
        target_manifest.write_text(manifest_path.read_text())
    return True


def main():
    cfg_dir = get_global_config_dir()
    index_path = cfg_dir / "index.json"
    index = load_json(index_path)
    if index is None:
        print(f"No index found at {index_path}")
        return

    workspaces = index.get("workspaces", [])
    projects = index.get("projects", [])

    ws_by_id = {w.get("workspace_id"): w for w in workspaces if w.get("workspace_id")}
    ws_by_project = {}
    for w in workspaces:
        pid = w.get("project_id")
        if not pid:
            continue
        ws_by_project.setdefault(pid, []).append(w)

    updated_configs = 0
    updated_index = 0
    updated_parents = 0
    copied_bases = 0

    # Fix workspace configs + index base_snapshot_id
    for w in workspaces:
        path = w.get("path")
        if not path:
            continue
        cfg_path = Path(path) / ".fst" / "config.json"
        cfg = load_json(cfg_path)
        if cfg is None:
            continue
        changed = False
        if not cfg.get("base_snapshot_id") and cfg.get("fork_snapshot_id"):
            cfg["base_snapshot_id"] = cfg.get("fork_snapshot_id")
            cfg.pop("fork_snapshot_id", None)
            changed = True
        if not cfg.get("base_snapshot_id"):
            snapshots_dir = Path(path) / ".fst" / "snapshots"
            base_id = pick_snapshot_id(snapshots_dir, prefer="earliest")
            if base_id:
                cfg["base_snapshot_id"] = base_id
                if not cfg.get("current_snapshot_id"):
                    cfg["current_snapshot_id"] = base_id
                changed = True
        if changed:
            save_json(cfg_path, cfg)
            updated_configs += 1

        base_id = cfg.get("base_snapshot_id")
        if base_id and not w.get("base_snapshot_id"):
            w["base_snapshot_id"] = base_id
            updated_index += 1

    # Fix parent configs
    for p in projects:
        pid = p.get("project_id")
        if not pid:
            continue
        parent_root = None
        project_path = p.get("project_path")
        if project_path:
            candidate = Path(project_path) / "fst.json"
            if candidate.exists():
                parent_root = Path(project_path)
        if parent_root is None:
            for w in ws_by_project.get(pid, []):
                wpath = w.get("path")
                if not wpath:
                    continue
                parent_root = find_parent_root(Path(wpath))
                if parent_root:
                    break
        if not parent_root:
            continue

        parent_cfg_path = parent_root / "fst.json"
        parent_cfg = load_json(parent_cfg_path)
        if parent_cfg is None:
            continue

        if not parent_cfg.get("base_snapshot_id"):
            # pick base workspace
            base_ws = None
            base_ws_id = parent_cfg.get("base_workspace_id")
            if base_ws_id and base_ws_id in ws_by_id:
                base_ws = ws_by_id[base_ws_id]
            if base_ws is None:
                candidates = ws_by_project.get(pid, [])
                best = None
                for w in candidates:
                    wpath = w.get("path")
                    if not wpath:
                        continue
                    base_id = w.get("base_snapshot_id")
                    if not base_id:
                        snapshots_dir = Path(wpath) / ".fst" / "snapshots"
                        base_id = pick_snapshot_id(snapshots_dir, prefer="earliest")
                    if not base_id:
                        continue
                    best = (w, base_id)
                    break
                if best:
                    base_ws, base_id = best
                else:
                    continue
            else:
                base_id = base_ws.get("base_snapshot_id")
                if not base_id:
                    wpath = base_ws.get("path")
                    if wpath:
                        base_id = pick_snapshot_id(Path(wpath) / ".fst" / "snapshots", prefer="earliest")

            if base_ws and base_id:
                parent_cfg["base_snapshot_id"] = base_id
                parent_cfg["base_workspace_id"] = base_ws.get("workspace_id")
                save_json(parent_cfg_path, parent_cfg)
                updated_parents += 1

    if updated_index > 0:
        save_json(index_path, index)

    # Copy base snapshot metadata/manifests to all workspaces
    for p in projects:
        pid = p.get("project_id")
        if not pid:
            continue
        parent_root = None
        project_path = p.get("project_path")
        if project_path:
            candidate = Path(project_path) / "fst.json"
            if candidate.exists():
                parent_root = Path(project_path)
        if parent_root is None:
            for w in ws_by_project.get(pid, []):
                wpath = w.get("path")
                if not wpath:
                    continue
                parent_root = find_parent_root(Path(wpath))
                if parent_root:
                    break
        if not parent_root:
            continue
        parent_cfg_path = parent_root / "fst.json"
        parent_cfg = load_json(parent_cfg_path)
        if parent_cfg is None:
            continue
        base_id = parent_cfg.get("base_snapshot_id")
        base_ws_id = parent_cfg.get("base_workspace_id")
        if not base_id or not base_ws_id:
            continue
        base_ws = ws_by_id.get(base_ws_id)
        if not base_ws:
            continue
        base_ws_path = base_ws.get("path")
        if not base_ws_path:
            continue
        base_ws_path = Path(base_ws_path)
        for w in ws_by_project.get(pid, []):
            wpath = w.get("path")
            if not wpath:
                continue
            if copy_base_snapshot(base_ws_path, Path(wpath), base_id):
                copied_bases += 1

    print(f"Updated workspace configs: {updated_configs}")
    print(f"Updated index entries: {updated_index}")
    print(f"Updated parent configs: {updated_parents}")
    print(f"Copied base snapshot into workspaces: {copied_bases}")


if __name__ == "__main__":
    main()
