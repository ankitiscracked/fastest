package dag

import (
	"fmt"
	"time"

	"github.com/anthropics/fastest/cli/internal/store"
)

// GetMergeBase finds the most recent common ancestor between two snapshot heads
// using BFS traversal of the snapshot DAG. It minimizes combined distance from
// both heads, with ties broken by preferring more recently created snapshots.
func GetMergeBase(targetRoot, sourceRoot, targetHead, sourceHead string) (string, error) {
	if targetHead == "" || sourceHead == "" {
		return "", fmt.Errorf("missing snapshots in one or both workspaces")
	}

	targetStore := store.OpenFromWorkspace(targetRoot)
	sourceStore := store.OpenFromWorkspace(sourceRoot)

	type node struct {
		id   string
		dist int
	}

	loadMeta := func(id string) (*store.SnapshotMeta, error) {
		meta, err := targetStore.LoadSnapshotMeta(id)
		if err == nil {
			return meta, nil
		}
		return sourceStore.LoadSnapshotMeta(id)
	}

	// BFS from target head to build distance map
	targetDist := make(map[string]int)
	queue := []node{{id: targetHead, dist: 0}}
	for i := 0; i < len(queue); i++ {
		item := queue[i]
		if _, ok := targetDist[item.id]; ok {
			continue
		}
		meta, err := loadMeta(item.id)
		if err != nil {
			return "", fmt.Errorf("missing snapshot metadata for %s", item.id)
		}
		targetDist[item.id] = item.dist
		for _, parent := range meta.ParentSnapshotIDs {
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
		meta, err := loadMeta(item.id)
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

		for _, parent := range meta.ParentSnapshotIDs {
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
