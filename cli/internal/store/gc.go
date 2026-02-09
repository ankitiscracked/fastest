package store

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// GCOpts configures a garbage collection operation.
type GCOpts struct {
	DryRun bool
}

// GCResult contains the outcome of garbage collection.
type GCResult struct {
	UnreachableSnapshots []string
	OrphanedManifests    []string
	OrphanedBlobs        []string
	DeletedSnapshots     int
	DeletedManifests     int
	DeletedBlobs         int
}

// GC performs garbage collection on the store, removing unreachable snapshots,
// orphaned manifests, and orphaned blobs. A snapshot is reachable if it is
// an ancestor of any registered workspace's current or base snapshot.
func (s *Store) GC(opts GCOpts) (*GCResult, error) {
	roots, err := s.collectGCRoots()
	if err != nil {
		return nil, fmt.Errorf("failed to collect workspace roots: %w", err)
	}

	allMetas, err := s.LoadAllSnapshotMetas()
	if err != nil {
		return nil, fmt.Errorf("failed to load snapshots: %w", err)
	}

	if len(allMetas) == 0 {
		return &GCResult{}, nil
	}

	reachable := s.BuildReachableSet(roots)

	// Classify snapshots and collect manifest hashes
	result := &GCResult{}
	reachableManifests := make(map[string]struct{})
	unreachableManifests := make(map[string]struct{})

	for id, meta := range allMetas {
		if _, ok := reachable[id]; ok {
			if meta.ManifestHash != "" {
				reachableManifests[meta.ManifestHash] = struct{}{}
			}
		} else {
			result.UnreachableSnapshots = append(result.UnreachableSnapshots, id)
			if meta.ManifestHash != "" {
				unreachableManifests[meta.ManifestHash] = struct{}{}
			}
		}
	}

	// Orphaned manifests: referenced only by unreachable snapshots
	for hash := range unreachableManifests {
		if _, ok := reachableManifests[hash]; !ok {
			result.OrphanedManifests = append(result.OrphanedManifests, hash)
		}
	}

	// Collect blob hashes referenced by reachable manifests
	referencedBlobs := make(map[string]struct{})
	for hash := range reachableManifests {
		m, err := s.LoadManifest(hash)
		if err != nil {
			continue
		}
		for _, f := range m.FileEntries() {
			referencedBlobs[f.Hash] = struct{}{}
		}
	}

	// Find orphaned blobs
	if entries, err := os.ReadDir(s.blobsDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			if _, ok := referencedBlobs[entry.Name()]; !ok {
				result.OrphanedBlobs = append(result.OrphanedBlobs, entry.Name())
			}
		}
	}

	if opts.DryRun {
		return result, nil
	}

	// Delete unreachable snapshots
	for _, id := range result.UnreachableSnapshots {
		if err := s.DeleteSnapshot(id); err != nil && !os.IsNotExist(err) {
			continue
		}
		result.DeletedSnapshots++
	}

	// Delete orphaned manifests
	for _, hash := range result.OrphanedManifests {
		path := filepath.Join(s.manifestsDir, hash+".json")
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			continue
		}
		result.DeletedManifests++
	}

	// Delete orphaned blobs
	for _, hash := range result.OrphanedBlobs {
		path := filepath.Join(s.blobsDir, hash)
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			continue
		}
		result.DeletedBlobs++
	}

	return result, nil
}

// LoadAllSnapshotMetas loads all snapshot metadata from the store.
func (s *Store) LoadAllSnapshotMetas() (map[string]*SnapshotMeta, error) {
	entries, err := os.ReadDir(s.snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]*SnapshotMeta{}, nil
		}
		return nil, err
	}

	metas := make(map[string]*SnapshotMeta)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		id := strings.TrimSuffix(name, ".meta.json")
		meta, err := s.LoadSnapshotMeta(id)
		if err != nil {
			continue
		}
		metas[meta.ID] = meta
	}

	return metas, nil
}

// BuildReachableSet performs BFS from the given root IDs through parent links
// to find all reachable snapshot IDs.
func (s *Store) BuildReachableSet(roots []string) map[string]struct{} {
	reachable := make(map[string]struct{})
	queue := make([]string, 0, len(roots))

	for _, id := range roots {
		if id == "" {
			continue
		}
		if _, ok := reachable[id]; !ok {
			reachable[id] = struct{}{}
			queue = append(queue, id)
		}
	}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		meta, err := s.LoadSnapshotMeta(current)
		if err != nil {
			continue
		}

		for _, parentID := range meta.ParentSnapshotIDs {
			if parentID == "" {
				continue
			}
			if _, ok := reachable[parentID]; !ok {
				reachable[parentID] = struct{}{}
				queue = append(queue, parentID)
			}
		}
	}

	return reachable
}

// collectGCRoots returns all snapshot IDs that serve as GC roots from
// the workspace registry.
func (s *Store) collectGCRoots() ([]string, error) {
	seen := make(map[string]struct{})
	var roots []string

	addRoot := func(id string) {
		if id == "" {
			return
		}
		if _, ok := seen[id]; ok {
			return
		}
		seen[id] = struct{}{}
		roots = append(roots, id)
	}

	// From workspace registry
	workspaces, err := s.ListWorkspaces()
	if err != nil {
		return nil, err
	}
	for _, ws := range workspaces {
		addRoot(ws.CurrentSnapshotID)
		addRoot(ws.BaseSnapshotID)
	}

	return roots, nil
}
