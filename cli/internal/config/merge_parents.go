package config

import (
	"encoding/json"
	"os"
	"path/filepath"
)

const mergeParentsFileName = "merge-parents.json"

type mergeParentsMeta struct {
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
}

// ReadPendingMergeParents returns pending merge parent IDs for the current workspace.
func ReadPendingMergeParents() ([]string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return nil, err
	}
	return ReadPendingMergeParentsAt(root)
}

// ReadPendingMergeParentsAt returns pending merge parent IDs for a specific workspace root.
func ReadPendingMergeParentsAt(root string) ([]string, error) {
	path := filepath.Join(root, ConfigDirName, mergeParentsFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var meta mergeParentsMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}

	return normalizeParentIDs(meta.ParentSnapshotIDs), nil
}

// WritePendingMergeParents saves pending merge parent IDs for a specific workspace root.
func WritePendingMergeParentsAt(root string, parents []string) error {
	parents = normalizeParentIDs(parents)
	if len(parents) == 0 {
		return ClearPendingMergeParentsAt(root)
	}

	meta := mergeParentsMeta{ParentSnapshotIDs: parents}
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	path := filepath.Join(root, ConfigDirName, mergeParentsFileName)
	return os.WriteFile(path, data, 0644)
}

// ClearPendingMergeParents removes any pending merge parent IDs for a specific workspace root.
func ClearPendingMergeParentsAt(root string) error {
	path := filepath.Join(root, ConfigDirName, mergeParentsFileName)
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}
