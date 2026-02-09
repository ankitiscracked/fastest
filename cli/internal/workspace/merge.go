package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/store"
)

// ConflictMode determines how conflicts are resolved during merge.
type ConflictMode int

const (
	ConflictModeManual ConflictMode = iota // Write <<<<<<< markers
	ConflictModeTheirs                     // Take source version
	ConflictModeOurs                       // Keep current version
)

// ConflictResolver is called for each conflicting file during merge.
// It receives the file path and the current, source, and base content.
// On success it returns the merged content. On error, the workspace
// falls back to the conflict mode specified in ApplyMergeOpts.
type ConflictResolver func(path string, current, source, base []byte) ([]byte, error)

// ApplyMergeOpts configures how a merge plan is applied to the workspace.
type ApplyMergeOpts struct {
	Plan     *store.MergePlan
	Mode     ConflictMode
	Resolver ConflictResolver // optional; called before falling back to Mode
}

// MergeResult contains the outcome of applying a merge.
type MergeResult struct {
	Applied   []string // files successfully merged
	Conflicts []string // files left with conflict markers
	Failed    []string // files that failed
}

// ApplyMerge writes a merge plan to the workspace's working tree.
// It applies non-conflicting changes, resolves conflicts per the
// configured mode, and records merge parents for the next snapshot.
func (ws *Workspace) ApplyMerge(opts ApplyMergeOpts) (*MergeResult, error) {
	plan := opts.Plan
	if plan == nil {
		return nil, fmt.Errorf("merge plan is nil")
	}

	// Check for dirty working-tree conflicts
	if err := ws.checkDirtyConflicts(plan); err != nil {
		return nil, err
	}

	// Record merge parents BEFORE applying changes so that if we crash
	// mid-apply, the next 'fst snapshot' still creates a merge commit
	// with the correct parent IDs in the history DAG.
	parents := []string{plan.CurrentSnapshotID, plan.SourceSnapshotID}
	if err := config.WritePendingMergeParentsAt(ws.root, parents); err != nil {
		return nil, fmt.Errorf("failed to record merge parents: %w", err)
	}

	result := &MergeResult{}

	// Apply non-conflicting changes
	for _, action := range plan.ToApply {
		if err := ws.applyAction(action); err != nil {
			result.Failed = append(result.Failed, action.Path)
		} else {
			result.Applied = append(result.Applied, action.Path)
		}
	}

	// Handle conflicts
	for _, action := range plan.Conflicts {
		resolved := false

		// Try resolver first
		if opts.Resolver != nil {
			if err := ws.resolveWithCallback(action, opts.Resolver); err == nil {
				result.Applied = append(result.Applied, action.Path)
				resolved = true
			}
		}

		if !resolved {
			switch opts.Mode {
			case ConflictModeTheirs:
				if err := ws.applyAction(action); err != nil {
					result.Failed = append(result.Failed, action.Path)
				} else {
					result.Applied = append(result.Applied, action.Path)
				}

			case ConflictModeOurs:
				// Keep current version — no-op
				result.Applied = append(result.Applied, action.Path)

			case ConflictModeManual:
				if err := ws.writeConflictMarkers(action); err != nil {
					result.Failed = append(result.Failed, action.Path)
				} else {
					result.Conflicts = append(result.Conflicts, action.Path)
				}
			}
		}
	}

	// If everything failed, clear the merge parents
	if len(result.Failed) > 0 && len(result.Applied) == 0 && len(result.Conflicts) == 0 {
		_ = config.ClearPendingMergeParentsAt(ws.root)
	}

	return result, nil
}

// MergeAbort clears pending merge state.
func (ws *Workspace) MergeAbort() error {
	return config.ClearPendingMergeParentsAt(ws.root)
}

// checkDirtyConflicts verifies the working tree doesn't have uncommitted changes
// in files that the merge would overwrite.
func (ws *Workspace) checkDirtyConflicts(plan *store.MergePlan) error {
	if ws.cfg.CurrentSnapshotID == "" {
		return nil // no snapshot to diff against
	}

	currentHash, err := ws.store.ManifestHashFromSnapshotID(ws.cfg.CurrentSnapshotID)
	if err != nil {
		return fmt.Errorf("cannot verify working tree state (failed to read current snapshot): %w", err)
	}
	currentManifest, err := ws.store.LoadManifest(currentHash)
	if err != nil {
		return fmt.Errorf("cannot verify working tree state (failed to load manifest): %w", err)
	}

	workingManifest, err := manifest.GenerateWithCache(ws.root, ws.StatCachePath())
	if err != nil {
		return fmt.Errorf("cannot verify working tree state (failed to scan files): %w", err)
	}

	added, modified, deleted := manifest.Diff(currentManifest, workingManifest)
	dirtyPaths := make(map[string]struct{}, len(added)+len(modified)+len(deleted))
	for _, p := range added {
		dirtyPaths[p] = struct{}{}
	}
	for _, p := range modified {
		dirtyPaths[p] = struct{}{}
	}
	for _, p := range deleted {
		dirtyPaths[p] = struct{}{}
	}

	if len(dirtyPaths) == 0 {
		return nil
	}

	// Check overlap with merge-touched paths
	var overlaps []string
	for _, a := range plan.ToApply {
		if _, ok := dirtyPaths[a.Path]; ok {
			overlaps = append(overlaps, a.Path)
		}
	}
	for _, a := range plan.Conflicts {
		if _, ok := dirtyPaths[a.Path]; ok {
			overlaps = append(overlaps, a.Path)
		}
	}

	if len(overlaps) > 0 {
		preview := overlaps
		if len(preview) > 5 {
			preview = preview[:5]
		}
		return fmt.Errorf("merge would overwrite local changes in %d file(s): %s", len(overlaps), strings.Join(preview, ", "))
	}

	return nil
}

// applyAction writes source content from the blob store to the working tree.
func (ws *Workspace) applyAction(action store.MergeAction) error {
	content, err := ws.store.ReadBlob(action.SourceHash)
	if err != nil {
		return fmt.Errorf("failed to read source blob: %w", err)
	}

	targetPath := filepath.Join(ws.root, action.Path)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}

	mode := fileModeOrDefault(action.SourceMode, 0644)
	return os.WriteFile(targetPath, content, mode)
}

// resolveWithCallback calls the conflict resolver and writes the result.
func (ws *Workspace) resolveWithCallback(action store.MergeAction, resolver ConflictResolver) error {
	current := readBlobOrEmpty(ws.store, action.CurrentHash)
	source := readBlobOrEmpty(ws.store, action.SourceHash)
	base := readBlobOrEmpty(ws.store, action.BaseHash)

	merged, err := resolver(action.Path, current, source, base)
	if err != nil {
		return err
	}

	targetPath := filepath.Join(ws.root, action.Path)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}

	mode := fileModeOrDefault(action.SourceMode, 0644)
	return os.WriteFile(targetPath, merged, mode)
}

// writeConflictMarkers writes a file with <<<<<<< / ======= / >>>>>>> markers.
func (ws *Workspace) writeConflictMarkers(action store.MergeAction) error {
	current := readBlobOrEmpty(ws.store, action.CurrentHash)
	source := readBlobOrEmpty(ws.store, action.SourceHash)

	var b strings.Builder
	b.WriteString("<<<<<<< CURRENT (this workspace)\n")
	if len(current) > 0 {
		b.Write(current)
		if current[len(current)-1] != '\n' {
			b.WriteString("\n")
		}
	} else {
		b.WriteString("(file does not exist in current)\n")
	}
	b.WriteString("=======\n")
	if len(source) > 0 {
		b.Write(source)
		if source[len(source)-1] != '\n' {
			b.WriteString("\n")
		}
	} else {
		b.WriteString("(file does not exist in source)\n")
	}
	b.WriteString(">>>>>>> SOURCE (merging from)\n")

	targetPath := filepath.Join(ws.root, action.Path)
	if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
		return err
	}
	return os.WriteFile(targetPath, []byte(b.String()), 0644)
}

func readBlobOrEmpty(s *store.Store, hash string) []byte {
	if hash == "" {
		return nil
	}
	data, err := s.ReadBlob(hash)
	if err != nil {
		return nil
	}
	return data
}

func fileModeOrDefault(mode uint32, fallback os.FileMode) os.FileMode {
	if mode == 0 {
		return fallback
	}
	return os.FileMode(mode)
}
