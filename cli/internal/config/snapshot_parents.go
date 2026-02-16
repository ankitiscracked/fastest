package config

import "github.com/ankitiscracked/fastest/cli/internal/store"

// SnapshotParentIDsAt returns all parent snapshot IDs for a snapshot (multi-parent aware).
func SnapshotParentIDsAt(root, snapshotID string) ([]string, error) {
	s := store.OpenFromWorkspace(root)
	return s.SnapshotParentIDs(snapshotID)
}

// SnapshotPrimaryParentIDAt returns the first parent snapshot ID (for first-parent chain views).
func SnapshotPrimaryParentIDAt(root, snapshotID string) (string, error) {
	s := store.OpenFromWorkspace(root)
	return s.SnapshotPrimaryParentID(snapshotID)
}
