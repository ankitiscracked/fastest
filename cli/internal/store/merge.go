package store

import (
	"bytes"
	"fmt"
	"io"

	"github.com/ankitiscracked/fastest/cli/internal/manifest"
	"github.com/epiclabs-io/diff3"
)

// MergeAction represents what to do with a single file during a merge.
type MergeAction struct {
	Path          string
	Type          string // "apply", "conflict", or "auto-merge"
	CurrentHash   string
	SourceHash    string
	BaseHash      string
	SourceMode    uint32
	MergedContent []byte // populated for "auto-merge" actions
}

// MergePlan is the result of planning a merge between two snapshots.
// It contains the computed three-way diff without applying any changes.
type MergePlan struct {
	ToApply           []MergeAction // files to apply from source (no conflict)
	AutoMerged        []MergeAction // files auto-merged at line level (non-overlapping changes)
	Conflicts         []MergeAction // files with conflicting changes
	InSync            int           // count of files already in sync
	MergeBaseID       string
	CurrentSnapshotID string
	SourceSnapshotID  string
}

// BlobReader provides read access to file content by hash.
type BlobReader interface {
	ReadBlob(hash string) ([]byte, error)
}

// PlanMerge computes a three-way merge plan between two snapshots.
// It finds the merge base via DAG traversal, loads all three manifests,
// and classifies each file as apply, conflict, or in-sync.
// If force is true, proceeds without a common ancestor (two-way merge).
func (s *Store) PlanMerge(currentSnapshotID, sourceSnapshotID string, force bool) (*MergePlan, error) {
	if currentSnapshotID == "" {
		return nil, fmt.Errorf("current snapshot ID is empty")
	}
	if sourceSnapshotID == "" {
		return nil, fmt.Errorf("source snapshot ID is empty")
	}

	// Load current manifest
	currentManifest, err := s.loadManifestForSnapshot(currentSnapshotID)
	if err != nil {
		return nil, fmt.Errorf("failed to load current manifest: %w", err)
	}

	// Load source manifest
	sourceManifest, err := s.loadManifestForSnapshot(sourceSnapshotID)
	if err != nil {
		return nil, fmt.Errorf("failed to load source manifest: %w", err)
	}

	// Find merge base
	var baseManifest *manifest.Manifest
	var mergeBaseID string

	mergeBaseID, err = s.GetMergeBase(currentSnapshotID, sourceSnapshotID)
	if err != nil {
		if !force {
			return nil, fmt.Errorf("could not determine merge base: %w", err)
		}
		// Force mode: empty base (treat as two-way merge)
		baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
	} else {
		baseManifest, err = s.loadManifestForSnapshot(mergeBaseID)
		if err != nil {
			// If base manifest can't be loaded, fall back to empty
			baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
			mergeBaseID = ""
		}
	}

	// Compute three-way diff with line-level merge for both-changed files
	toApply, autoMerged, conflicts, inSyncCount := computeMergeActions(baseManifest, currentManifest, sourceManifest, s)

	return &MergePlan{
		ToApply:           toApply,
		AutoMerged:        autoMerged,
		Conflicts:         conflicts,
		InSync:            inSyncCount,
		MergeBaseID:       mergeBaseID,
		CurrentSnapshotID: currentSnapshotID,
		SourceSnapshotID:  sourceSnapshotID,
	}, nil
}

// loadManifestForSnapshot resolves a snapshot ID to its manifest.
func (s *Store) loadManifestForSnapshot(snapshotID string) (*manifest.Manifest, error) {
	hash, err := s.ManifestHashFromSnapshotID(snapshotID)
	if err != nil {
		return nil, err
	}
	return s.LoadManifest(hash)
}

// computeMergeActions performs a three-way diff of base, current, and source manifests.
// For each file path, it determines whether to apply from source, auto-merge (if both
// sides changed non-overlapping lines), flag as conflict, or skip (already in sync).
// When both sides modify the same file, it attempts a line-level three-way merge using
// the diff3 algorithm. Non-overlapping changes are auto-merged; overlapping changes
// remain as conflicts.
func computeMergeActions(base, current, source *manifest.Manifest, blobs BlobReader) (toApply, autoMerged, conflicts []MergeAction, inSync int) {
	// Build lookup maps
	baseFiles := make(map[string]manifest.FileEntry)
	for _, f := range base.FileEntries() {
		baseFiles[f.Path] = f
	}

	currentFiles := make(map[string]manifest.FileEntry)
	for _, f := range current.FileEntries() {
		currentFiles[f.Path] = f
	}

	sourceFiles := make(map[string]manifest.FileEntry)
	for _, f := range source.FileEntries() {
		sourceFiles[f.Path] = f
	}

	// Collect all unique paths
	allPaths := make(map[string]bool)
	for path := range baseFiles {
		allPaths[path] = true
	}
	for path := range currentFiles {
		allPaths[path] = true
	}
	for path := range sourceFiles {
		allPaths[path] = true
	}

	for path := range allPaths {
		baseFile, inBase := baseFiles[path]
		currentFile, inCurrent := currentFiles[path]
		sourceFile, inSource := sourceFiles[path]

		action := MergeAction{Path: path}

		if inBase {
			action.BaseHash = baseFile.Hash
		}
		if inCurrent {
			action.CurrentHash = currentFile.Hash
		}
		if inSource {
			action.SourceHash = sourceFile.Hash
			action.SourceMode = sourceFile.Mode
		}

		currentChanged := !inBase && inCurrent || (inBase && inCurrent && baseFile.Hash != currentFile.Hash)
		sourceChanged := !inBase && inSource || (inBase && inSource && baseFile.Hash != sourceFile.Hash)
		currentDeleted := inBase && !inCurrent
		sourceDeleted := inBase && !inSource

		switch {
		case !inSource && !sourceDeleted:
			// File only in current/base — nothing from source
			continue

		case !inCurrent && inSource:
			// Added in source — apply
			action.Type = "apply"
			toApply = append(toApply, action)

		case currentDeleted && inSource:
			// We deleted, source has it — conflict
			action.Type = "conflict"
			conflicts = append(conflicts, action)

		case sourceDeleted && inCurrent:
			// Source deleted, we have it — keep ours
			inSync++

		case inCurrent && inSource && currentFile.Hash == sourceFile.Hash:
			// Same content
			inSync++

		case !currentChanged && sourceChanged:
			// Only source changed — apply
			action.Type = "apply"
			toApply = append(toApply, action)

		case currentChanged && !sourceChanged:
			// Only current changed — keep ours
			inSync++

		case currentChanged && sourceChanged:
			// Both changed — attempt line-level three-way merge
			if merged, ok := tryLinemerge(blobs, action.BaseHash, action.CurrentHash, action.SourceHash); ok {
				action.Type = "auto-merge"
				action.MergedContent = merged
				autoMerged = append(autoMerged, action)
			} else {
				action.Type = "conflict"
				conflicts = append(conflicts, action)
			}

		default:
			inSync++
		}
	}

	return toApply, autoMerged, conflicts, inSync
}

// tryLinemerge attempts a three-way line-level merge using the diff3 algorithm.
// Returns the merged content and true if the merge succeeds without conflicts.
// Returns nil and false if the merge cannot be performed or has conflicts.
func tryLinemerge(blobs BlobReader, baseHash, currentHash, sourceHash string) ([]byte, bool) {
	if blobs == nil || baseHash == "" {
		return nil, false
	}

	baseContent, err := blobs.ReadBlob(baseHash)
	if err != nil {
		return nil, false
	}
	currentContent, err := blobs.ReadBlob(currentHash)
	if err != nil {
		return nil, false
	}
	sourceContent, err := blobs.ReadBlob(sourceHash)
	if err != nil {
		return nil, false
	}

	// Skip binary files (contain null bytes)
	if bytes.ContainsRune(baseContent, 0) || bytes.ContainsRune(currentContent, 0) || bytes.ContainsRune(sourceContent, 0) {
		return nil, false
	}

	// diff3.Merge(a=current, o=base, b=source)
	result, err := diff3.Merge(
		bytes.NewReader(currentContent),
		bytes.NewReader(baseContent),
		bytes.NewReader(sourceContent),
		true, "", "",
	)
	if err != nil {
		return nil, false
	}

	if result.Conflicts {
		return nil, false
	}

	merged, err := io.ReadAll(result.Result)
	if err != nil {
		return nil, false
	}

	return merged, true
}
