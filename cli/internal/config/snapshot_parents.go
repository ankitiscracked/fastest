package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// SnapshotParentIDsAt returns all parent snapshot IDs for a snapshot (multi-parent aware).
func SnapshotParentIDsAt(root, snapshotID string) ([]string, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	metaPath := filepath.Join(GetSnapshotsDirAt(root), snapshotID+".meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, err
	}

	var meta SnapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}

	if IsContentAddressedSnapshotID(snapshotID) && meta.ManifestHash != "" {
		if !VerifySnapshotID(snapshotID, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
			return nil, fmt.Errorf("snapshot integrity check failed for %s: ID does not match content", snapshotID)
		}
	}

	return normalizeParentIDs(meta.ParentSnapshotIDs), nil
}

// SnapshotPrimaryParentIDAt returns the first parent snapshot ID (for first-parent chain views).
func SnapshotPrimaryParentIDAt(root, snapshotID string) (string, error) {
	parents, err := SnapshotParentIDsAt(root, snapshotID)
	if err != nil {
		return "", err
	}
	if len(parents) == 0 {
		return "", nil
	}
	return parents[0], nil
}

func normalizeParentIDs(parents []string) []string {
	seen := make(map[string]struct{}, len(parents)+1)
	out := make([]string, 0, len(parents)+1)

	for _, p := range parents {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}

	return out
}
