ALTER TABLE workspaces ADD COLUMN current_snapshot_id TEXT REFERENCES snapshots(id);
