package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ankitiscracked/fastest/cli/internal/manifest"
)

// RestoreOpts configures a restore operation.
type RestoreOpts struct {
	SnapshotID string   // target; empty = latest snapshot
	ToBase     bool     // use base snapshot
	Files      []string // specific files/dirs; empty = all
	DryRun     bool
}

// RestoreAction describes a single file-level action.
type RestoreAction struct {
	Path   string
	Action string // "restore", "delete", "skip"
	Status string // "missing", "modified", "unchanged"
}

// RestoreResult contains the outcome of a restore operation.
type RestoreResult struct {
	TargetSnapshotID string
	Actions          []RestoreAction
	Restored         int
	Deleted          int
	Skipped          int
	MissingBlobs     []string
}

// Restore restores files from a target snapshot.
func (ws *Workspace) Restore(opts RestoreOpts) (*RestoreResult, error) {
	targetID, err := ws.resolveRestoreTarget(opts)
	if err != nil {
		return nil, err
	}

	// Load target manifest
	manifestHash, err := ws.store.ManifestHashFromSnapshotID(targetID)
	if err != nil {
		return nil, err
	}
	targetManifest, err := ws.store.LoadManifest(manifestHash)
	if err != nil {
		return nil, fmt.Errorf("snapshot not found: %s", targetID)
	}

	targetEntries := make(map[string]manifest.FileEntry, len(targetManifest.Files))
	for _, f := range targetManifest.Files {
		targetEntries[f.Path] = f
	}

	all := len(opts.Files) == 0
	var toRestore []manifest.FileEntry
	var toDelete []string

	if all {
		toRestore = targetManifest.Files

		currentManifest, err := manifest.GenerateWithCache(ws.root, ws.StatCachePath())
		if err != nil {
			return nil, fmt.Errorf("failed to scan current files: %w", err)
		}

		for _, f := range append(currentManifest.FileEntries(), currentManifest.SymlinkEntries()...) {
			if _, exists := targetEntries[f.Path]; !exists {
				toDelete = append(toDelete, f.Path)
			}
		}
	} else {
		for _, pattern := range opts.Files {
			pattern = filepath.ToSlash(pattern)
			pattern = strings.TrimSuffix(pattern, "/")

			for _, f := range targetManifest.Files {
				if f.Path == pattern || strings.HasPrefix(f.Path, pattern+"/") {
					toRestore = append(toRestore, f)
				}
			}
		}
	}

	sort.Slice(toRestore, func(i, j int) bool {
		return toRestore[i].Path < toRestore[j].Path
	})
	sort.Strings(toDelete)

	// Check blob availability
	var missingBlobs []string
	for _, f := range toRestore {
		if f.Type != manifest.EntryTypeFile {
			continue
		}
		if !ws.store.BlobExists(f.Hash) {
			missingBlobs = append(missingBlobs, f.Path)
		}
	}
	if len(missingBlobs) > 0 {
		return &RestoreResult{
			TargetSnapshotID: targetID,
			MissingBlobs:     missingBlobs,
		}, fmt.Errorf("missing blobs for %d files", len(missingBlobs))
	}

	// Build actions with status info
	var actions []RestoreAction

	for _, f := range toRestore {
		action := RestoreAction{Path: f.Path, Action: "restore"}
		currentPath := filepath.Join(ws.root, f.Path)
		if _, err := os.Lstat(currentPath); os.IsNotExist(err) {
			action.Status = "missing"
		} else {
			switch f.Type {
			case manifest.EntryTypeFile:
				currentHash, _ := manifest.HashFile(currentPath)
				if currentHash != f.Hash {
					action.Status = "modified"
				} else {
					action.Status = "unchanged"
				}
			case manifest.EntryTypeSymlink:
				if target, err := os.Readlink(currentPath); err != nil || target != f.Target {
					action.Status = "modified"
				} else {
					action.Status = "unchanged"
				}
			}
		}
		actions = append(actions, action)
	}

	for _, f := range toDelete {
		actions = append(actions, RestoreAction{Path: f, Action: "delete"})
	}

	result := &RestoreResult{
		TargetSnapshotID: targetID,
		Actions:          actions,
	}

	if opts.DryRun {
		return result, nil
	}

	// Perform restore
	for _, f := range toRestore {
		targetPath := filepath.Join(ws.root, f.Path)
		switch f.Type {
		case manifest.EntryTypeDir:
			if err := os.MkdirAll(targetPath, 0755); err != nil {
				result.Skipped++
				continue
			}
			if f.Mode != 0 {
				_ = os.Chmod(targetPath, os.FileMode(f.Mode))
			}
			result.Restored++
		case manifest.EntryTypeSymlink:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				result.Skipped++
				continue
			}
			_ = os.RemoveAll(targetPath)
			if err := os.Symlink(f.Target, targetPath); err != nil {
				result.Skipped++
				continue
			}
			result.Restored++
		case manifest.EntryTypeFile:
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				result.Skipped++
				continue
			}
			content, err := ws.store.ReadBlob(f.Hash)
			if err != nil {
				result.Skipped++
				continue
			}
			if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
				result.Skipped++
				continue
			}
			result.Restored++
		}
	}

	for _, f := range toDelete {
		targetPath := filepath.Join(ws.root, f)
		if err := os.Remove(targetPath); err != nil {
			continue
		}
		result.Deleted++

		// Try to remove empty parent directories
		dir := filepath.Dir(targetPath)
		for dir != ws.root {
			if err := os.Remove(dir); err != nil {
				break
			}
			dir = filepath.Dir(dir)
		}
	}

	return result, nil
}

func (ws *Workspace) resolveRestoreTarget(opts RestoreOpts) (string, error) {
	if opts.SnapshotID != "" {
		return opts.SnapshotID, nil
	}
	if opts.ToBase {
		base := ws.cfg.BaseSnapshotID
		if base == "" {
			return "", fmt.Errorf("no base snapshot set")
		}
		return base, nil
	}

	// Default: current workspace head
	current := ws.cfg.CurrentSnapshotID
	if current == "" {
		return "", fmt.Errorf("no snapshots found - create one with 'fst snapshot'")
	}
	return current, nil
}
