package dag

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/anthropics/fastest/cli/internal/config"
)

// SnapshotMeta represents snapshot metadata for DAG traversal
type SnapshotMeta struct {
	ID          string   `json:"id"`
	WorkspaceID string   `json:"workspace_id"`
	CreatedAt   string   `json:"created_at"`
	ParentIDs   []string `json:"parent_snapshot_ids"`
}

// LoadSnapshotMeta loads snapshot metadata from a specific snapshots directory
func LoadSnapshotMeta(snapshotsDir, snapshotID string) (*SnapshotMeta, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	metaPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
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

// LoadSnapshotMetaAny tries to load snapshot metadata from targetDir first, then sourceDir
func LoadSnapshotMetaAny(targetSnapshotsDir, sourceSnapshotsDir, snapshotID string) (*SnapshotMeta, error) {
	meta, err := LoadSnapshotMeta(targetSnapshotsDir, snapshotID)
	if err == nil {
		return meta, nil
	}
	meta, err = LoadSnapshotMeta(sourceSnapshotsDir, snapshotID)
	if err == nil {
		return meta, nil
	}
	return nil, err
}

// GetMergeBase finds the most recent common ancestor between two snapshot heads
// using BFS traversal of the snapshot DAG. It minimizes combined distance from
// both heads, with ties broken by preferring more recently created snapshots.
func GetMergeBase(targetRoot, sourceRoot, targetHead, sourceHead string) (string, error) {
	if targetHead == "" || sourceHead == "" {
		return "", fmt.Errorf("missing snapshots in one or both workspaces")
	}

	targetSnapshotsDir := config.GetSnapshotsDirAt(targetRoot)
	sourceSnapshotsDir := config.GetSnapshotsDirAt(sourceRoot)

	type node struct {
		id   string
		dist int
	}

	// BFS from target head to build distance map
	targetDist := make(map[string]int)
	queue := []node{{id: targetHead, dist: 0}}
	for i := 0; i < len(queue); i++ {
		item := queue[i]
		if _, ok := targetDist[item.id]; ok {
			continue
		}
		meta, err := LoadSnapshotMetaAny(targetSnapshotsDir, sourceSnapshotsDir, item.id)
		if err != nil {
			return "", fmt.Errorf("missing snapshot metadata for %s", item.id)
		}
		targetDist[item.id] = item.dist
		for _, parent := range meta.ParentIDs {
			if parent == "" {
				continue
			}
			if _, ok := targetDist[parent]; ok {
				continue
			}
			queue = append(queue, node{id: parent, dist: item.dist + 1})
		}
	}

	// BFS from source head to find intersections with target distances
	bestID := ""
	bestScore := -1
	bestTime := time.Time{}

	queue = []node{{id: sourceHead, dist: 0}}
	seenSource := make(map[string]struct{})
	for i := 0; i < len(queue); i++ {
		item := queue[i]
		if _, ok := seenSource[item.id]; ok {
			continue
		}
		if bestScore != -1 && item.dist > bestScore {
			break
		}
		seenSource[item.id] = struct{}{}
		meta, err := LoadSnapshotMetaAny(targetSnapshotsDir, sourceSnapshotsDir, item.id)
		if err != nil {
			return "", fmt.Errorf("missing snapshot metadata for %s", item.id)
		}
		if tdist, ok := targetDist[item.id]; ok {
			score := item.dist + tdist
			if bestScore == -1 || score < bestScore {
				bestScore = score
				bestID = item.id
				if ts, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
					bestTime = ts
				} else {
					bestTime = time.Time{}
				}
			} else if score == bestScore {
				if ts, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
					if bestTime.IsZero() || ts.After(bestTime) {
						bestID = item.id
						bestTime = ts
					}
				}
			}
		}

		for _, parent := range meta.ParentIDs {
			if parent == "" {
				continue
			}
			if _, ok := seenSource[parent]; ok {
				continue
			}
			queue = append(queue, node{id: parent, dist: item.dist + 1})
		}
	}

	if bestID == "" {
		return "", fmt.Errorf("no common ancestor found between workspaces")
	}
	return bestID, nil
}
