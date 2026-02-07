package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// SnapshotMeta represents snapshot metadata. This is the canonical type —
// all packages should use store.SnapshotMeta instead of defining their own.
type SnapshotMeta struct {
	ID                string   `json:"id"`
	WorkspaceID       string   `json:"workspace_id"`
	WorkspaceName     string   `json:"workspace_name,omitempty"`
	ManifestHash      string   `json:"manifest_hash"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	AuthorName        string   `json:"author_name,omitempty"`
	AuthorEmail       string   `json:"author_email,omitempty"`
	Message           string   `json:"message,omitempty"`
	Agent             string   `json:"agent,omitempty"`
	CreatedAt         string   `json:"created_at"`
	Files             int      `json:"files,omitempty"`
	Size              int64    `json:"size,omitempty"`
}

// LoadSnapshotMeta reads snapshot metadata by ID from the store.
func (s *Store) LoadSnapshotMeta(id string) (*SnapshotMeta, error) {
	if id == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	metaPath := filepath.Join(s.snapshotsDir, id+".meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("snapshot metadata not found: %w", err)
	}

	var meta SnapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("failed to parse snapshot metadata: %w", err)
	}
	return &meta, nil
}

// WriteSnapshotMeta writes snapshot metadata to the store.
func (s *Store) WriteSnapshotMeta(meta *SnapshotMeta) error {
	if meta == nil || meta.ID == "" {
		return fmt.Errorf("snapshot metadata missing ID")
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal snapshot metadata: %w", err)
	}

	metaPath := filepath.Join(s.snapshotsDir, meta.ID+".meta.json")
	return os.WriteFile(metaPath, data, 0644)
}

// SnapshotExists checks if a snapshot with the given ID exists.
func (s *Store) SnapshotExists(id string) bool {
	metaPath := filepath.Join(s.snapshotsDir, id+".meta.json")
	_, err := os.Stat(metaPath)
	return err == nil
}

// DeleteSnapshot removes a snapshot's metadata file.
func (s *Store) DeleteSnapshot(id string) error {
	metaPath := filepath.Join(s.snapshotsDir, id+".meta.json")
	return os.Remove(metaPath)
}

// ResolveSnapshotID resolves a snapshot prefix to a full ID.
func (s *Store) ResolveSnapshotID(prefix string) (string, error) {
	if prefix == "" {
		return "", fmt.Errorf("empty snapshot ID")
	}

	entries, err := os.ReadDir(s.snapshotsDir)
	if err != nil {
		return "", err
	}

	matches := make([]string, 0, 4)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		id := strings.TrimSuffix(name, ".meta.json")
		if strings.HasPrefix(id, prefix) {
			matches = append(matches, id)
		}
	}

	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("snapshot %q not found", prefix)
	}
	sort.Strings(matches)
	return "", fmt.Errorf("snapshot %q is ambiguous: %s", prefix, strings.Join(matches, ", "))
}

// GetLatestSnapshotID returns the most recent snapshot ID across all workspaces.
func (s *Store) GetLatestSnapshotID() (string, error) {
	entries, err := os.ReadDir(s.snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}

	var latestID string
	var latestTime string

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		metaPath := filepath.Join(s.snapshotsDir, name)
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}

		var meta SnapshotMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		if meta.CreatedAt > latestTime {
			latestTime = meta.CreatedAt
			latestID = meta.ID
		}
	}

	return latestID, nil
}

// GetLatestSnapshotIDForWorkspace returns the most recent snapshot ID for a
// specific workspace, filtering by workspace_id.
func (s *Store) GetLatestSnapshotIDForWorkspace(workspaceID string) (string, error) {
	if workspaceID == "" {
		return s.GetLatestSnapshotID()
	}

	entries, err := os.ReadDir(s.snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}

	var latestID string
	var latestTime string

	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		metaPath := filepath.Join(s.snapshotsDir, name)
		data, err := os.ReadFile(metaPath)
		if err != nil {
			continue
		}

		var meta SnapshotMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		if meta.WorkspaceID != workspaceID {
			continue
		}

		if meta.CreatedAt > latestTime {
			latestTime = meta.CreatedAt
			latestID = meta.ID
		}
	}

	return latestID, nil
}

// ManifestHashFromSnapshotID resolves a snapshot ID to its manifest hash.
func (s *Store) ManifestHashFromSnapshotID(snapshotID string) (string, error) {
	if snapshotID == "" {
		return "", fmt.Errorf("empty snapshot ID")
	}

	meta, err := s.LoadSnapshotMeta(snapshotID)
	if err == nil {
		if meta.ManifestHash == "" {
			return "", fmt.Errorf("snapshot metadata missing manifest hash for: %s", snapshotID)
		}
		if IsContentAddressedSnapshotID(snapshotID) {
			if !VerifySnapshotID(snapshotID, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
				return "", fmt.Errorf("snapshot integrity check failed for %s: ID does not match content", snapshotID)
			}
		}
		return meta.ManifestHash, nil
	}

	// Fallback for legacy snapshot IDs that embedded the manifest hash.
	const prefix = "snap-"
	if strings.HasPrefix(snapshotID, prefix) {
		legacy := strings.TrimPrefix(snapshotID, prefix)
		if len(legacy) == 64 {
			return legacy, nil
		}
		if resolved, err := s.ResolveSnapshotID(snapshotID); err == nil && resolved != snapshotID {
			if meta, err := s.LoadSnapshotMeta(resolved); err == nil && meta.ManifestHash != "" {
				return meta.ManifestHash, nil
			}
		} else if err != nil && strings.Contains(err.Error(), "ambiguous") {
			return "", err
		}
	}

	return "", fmt.Errorf("snapshot metadata not found for: %s", snapshotID)
}

// SnapshotParentIDs returns all parent snapshot IDs for a snapshot.
func (s *Store) SnapshotParentIDs(snapshotID string) ([]string, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	meta, err := s.LoadSnapshotMeta(snapshotID)
	if err != nil {
		return nil, err
	}

	if IsContentAddressedSnapshotID(snapshotID) && meta.ManifestHash != "" {
		if !VerifySnapshotID(snapshotID, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
			return nil, fmt.Errorf("snapshot integrity check failed for %s: ID does not match content", snapshotID)
		}
	}

	return normalizeParentIDs(meta.ParentSnapshotIDs), nil
}

// SnapshotPrimaryParentID returns the first parent snapshot ID.
func (s *Store) SnapshotPrimaryParentID(snapshotID string) (string, error) {
	parents, err := s.SnapshotParentIDs(snapshotID)
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
