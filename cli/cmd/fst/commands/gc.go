package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newGCCmd()) })
}

func newGCCmd() *cobra.Command {
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "gc",
		Short: "Prune unreachable snapshots from the shared store",
		Long: `Garbage-collect unreachable snapshots and manifests from the project's
shared snapshot store.

A snapshot is reachable if it is an ancestor of any workspace's current or
base snapshot. Unreachable snapshots are leftovers from history rewriting
(drop, squash, rebase) and can be safely removed.

Must be run from within a project folder (directory containing fst.json).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGC(dryRun)
		},
	}

	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be deleted without deleting")

	return cmd
}

func runGC(dryRun bool) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	// Must be run from a project folder
	projectRoot, _, err := config.FindParentRootFrom(cwd)
	if err != nil {
		if errors.Is(err, config.ErrParentNotFound) {
			return fmt.Errorf("not in a project folder - run from a directory containing fst.json")
		}
		return err
	}

	snapshotsDir := config.GetSnapshotsDirAt(projectRoot)
	manifestsDir := config.GetManifestsDirAt(projectRoot)
	blobsDir := config.GetBlobsDirAt(projectRoot)

	// Collect all workspace HEAD and base snapshot IDs as GC roots
	roots, err := collectGCRoots(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to collect workspace roots: %w", err)
	}

	if len(roots) == 0 {
		fmt.Println("No workspace roots found - nothing to collect.")
		return nil
	}

	// Load all snapshot metadata from the shared store
	allMetas, err := loadGCSnapshots(snapshotsDir)
	if err != nil {
		return fmt.Errorf("failed to load snapshots: %w", err)
	}

	if len(allMetas) == 0 {
		fmt.Println("No snapshots in store.")
		return nil
	}

	// BFS from all roots to build reachable set
	reachable := buildReachableSet(roots, allMetas)

	// Find unreachable snapshots
	var unreachableIDs []string
	unreachableManifests := make(map[string]struct{})
	reachableManifests := make(map[string]struct{})

	for id, meta := range allMetas {
		if _, ok := reachable[id]; ok {
			if meta.ManifestHash != "" {
				reachableManifests[meta.ManifestHash] = struct{}{}
			}
		} else {
			unreachableIDs = append(unreachableIDs, id)
			if meta.ManifestHash != "" {
				unreachableManifests[meta.ManifestHash] = struct{}{}
			}
		}
	}

	// Manifests to delete: unreachable and not referenced by any reachable snapshot
	var manifestsToDelete []string
	for hash := range unreachableManifests {
		if _, ok := reachableManifests[hash]; !ok {
			manifestsToDelete = append(manifestsToDelete, hash)
		}
	}

	// Collect all blob hashes referenced by reachable manifests
	referencedBlobs := make(map[string]struct{})
	for hash := range reachableManifests {
		manifestPath := filepath.Join(manifestsDir, hash+".json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			continue
		}
		m, err := manifest.FromJSON(data)
		if err != nil {
			continue
		}
		for _, f := range m.FileEntries() {
			referencedBlobs[f.Hash] = struct{}{}
		}
	}

	// Find orphaned blobs
	var blobsToDelete []string
	if entries, err := os.ReadDir(blobsDir); err == nil {
		for _, entry := range entries {
			if entry.IsDir() {
				continue
			}
			if _, ok := referencedBlobs[entry.Name()]; !ok {
				blobsToDelete = append(blobsToDelete, entry.Name())
			}
		}
	}

	if len(unreachableIDs) == 0 && len(blobsToDelete) == 0 {
		fmt.Println("No unreachable snapshots or orphaned blobs found - nothing to collect.")
		return nil
	}

	if dryRun {
		if len(unreachableIDs) > 0 {
			fmt.Printf("Would delete %d unreachable snapshot(s):\n", len(unreachableIDs))
			for _, id := range unreachableIDs {
				fmt.Printf("  %s\n", id)
			}
		}
		if len(manifestsToDelete) > 0 {
			fmt.Printf("Would delete %d orphaned manifest(s):\n", len(manifestsToDelete))
			for _, hash := range manifestsToDelete {
				fmt.Printf("  %s\n", hash)
			}
		}
		if len(blobsToDelete) > 0 {
			fmt.Printf("Would delete %d orphaned blob(s).\n", len(blobsToDelete))
		}
		return nil
	}

	// Delete unreachable snapshots
	deletedSnaps := 0
	for _, id := range unreachableIDs {
		metaPath := filepath.Join(snapshotsDir, id+".meta.json")
		if err := os.Remove(metaPath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Warning: Could not delete snapshot %s: %v\n", id, err)
		} else {
			deletedSnaps++
		}
	}

	// Delete orphaned manifests
	deletedManifests := 0
	for _, hash := range manifestsToDelete {
		manifestPath := filepath.Join(manifestsDir, hash+".json")
		if err := os.Remove(manifestPath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Warning: Could not delete manifest %s: %v\n", hash, err)
		} else {
			deletedManifests++
		}
	}

	// Delete orphaned blobs
	deletedBlobs := 0
	for _, hash := range blobsToDelete {
		blobPath := filepath.Join(blobsDir, hash)
		if err := os.Remove(blobPath); err != nil && !os.IsNotExist(err) {
			fmt.Printf("Warning: Could not delete blob %s: %v\n", hash, err)
		} else {
			deletedBlobs++
		}
	}

	fmt.Printf("Deleted %d unreachable snapshot(s)", deletedSnaps)
	if deletedManifests > 0 {
		fmt.Printf(", %d orphaned manifest(s)", deletedManifests)
	}
	if deletedBlobs > 0 {
		fmt.Printf(", %d orphaned blob(s)", deletedBlobs)
	}
	fmt.Println(".")

	return nil
}

// collectGCRoots scans the project directory for workspace configs and
// returns all CurrentSnapshotID and BaseSnapshotID values as GC roots.
func collectGCRoots(projectRoot string) ([]string, error) {
	var roots []string
	seen := make(map[string]struct{})

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

	// Scan immediate children of the project root for workspace configs
	entries, err := os.ReadDir(projectRoot)
	if err != nil {
		return nil, err
	}

	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		wsDir := filepath.Join(projectRoot, entry.Name())
		configPath := filepath.Join(wsDir, config.ConfigDirName, config.ConfigFileName)
		data, err := os.ReadFile(configPath)
		if err != nil {
			continue // Not a workspace
		}
		var cfg config.ProjectConfig
		if err := json.Unmarshal(data, &cfg); err != nil {
			continue
		}
		addRoot(cfg.CurrentSnapshotID)
		addRoot(cfg.BaseSnapshotID)
	}

	// Also check the parent config's base snapshot
	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err == nil {
		addRoot(parentCfg.BaseSnapshotID)
	}

	return roots, nil
}

type gcSnapshotMeta struct {
	ID                string   `json:"id"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	ManifestHash      string   `json:"manifest_hash"`
}

func loadGCSnapshots(snapshotsDir string) (map[string]*gcSnapshotMeta, error) {
	entries, err := os.ReadDir(snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]*gcSnapshotMeta{}, nil
		}
		return nil, err
	}

	metas := make(map[string]*gcSnapshotMeta)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		path := filepath.Join(snapshotsDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var meta gcSnapshotMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}
		if meta.ID == "" {
			meta.ID = strings.TrimSuffix(name, ".meta.json")
		}
		metas[meta.ID] = &meta
	}

	return metas, nil
}

// buildReachableSet does a BFS from all root IDs following parent_snapshot_ids
// to find all reachable snapshots.
func buildReachableSet(roots []string, metas map[string]*gcSnapshotMeta) map[string]struct{} {
	reachable := make(map[string]struct{})
	queue := make([]string, 0, len(roots))

	for _, id := range roots {
		if _, ok := reachable[id]; !ok {
			reachable[id] = struct{}{}
			queue = append(queue, id)
		}
	}

	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]

		meta := metas[current]
		if meta == nil {
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
