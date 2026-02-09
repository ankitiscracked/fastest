package workspace

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

// DriftOpts configures a drift comparison.
type DriftOpts struct {
	TargetName string // workspace name; empty = main workspace
	NoDirty    bool   // compare committed snapshots only
}

// DriftResult contains the full drift analysis between two workspaces.
type DriftResult struct {
	OurName          string
	TheirName        string
	CommonAncestorID string
	OurHead          string
	TheirHead        string
	OurChanges       *drift.Report
	TheirChanges     *drift.Report
	SnapshotConflicts *conflicts.Report
	DirtyConflicts    *conflicts.Report // nil if NoDirty
	OverlappingPaths []string
}

// Drift computes drift between this workspace and a target workspace.
func (ws *Workspace) Drift(opts DriftOpts) (*DriftResult, error) {
	otherRoot, otherName, err := ws.resolveTargetWorkspace(opts.TargetName)
	if err != nil {
		return nil, err
	}

	// Verify target workspace still exists on disk
	if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
		return nil, fmt.Errorf("workspace no longer exists at: %s", otherRoot)
	}

	ourHead := ws.cfg.CurrentSnapshotID
	if ourHead == "" {
		ourHead, _ = config.GetLatestSnapshotIDAt(ws.root)
	}

	theirCfg, err := config.LoadAt(otherRoot)
	if err != nil {
		return nil, fmt.Errorf("failed to load target workspace config: %w", err)
	}
	theirHead := theirCfg.CurrentSnapshotID
	if theirHead == "" {
		theirHead, _ = config.GetLatestSnapshotIDAt(otherRoot)
	}

	if ourHead == "" || theirHead == "" {
		return nil, fmt.Errorf("both workspaces must have at least one snapshot for drift analysis")
	}

	mergeBaseID, err := ws.store.GetMergeBase(ourHead, theirHead)
	if err != nil {
		return nil, fmt.Errorf("could not find common ancestor: %w\nBoth workspaces need shared snapshot history.", err)
	}

	ancestorManifest, err := drift.LoadManifestFromSnapshots(ws.root, mergeBaseID)
	if err != nil {
		ancestorManifest, err = drift.LoadManifestFromSnapshots(otherRoot, mergeBaseID)
		if err != nil {
			return nil, fmt.Errorf("failed to load common ancestor manifest: %w", err)
		}
	}

	includeDirty := !opts.NoDirty
	ourManifest, err := loadManifestForDrift(ws.root, ourHead, includeDirty)
	if err != nil {
		return nil, fmt.Errorf("failed to load current workspace state: %w", err)
	}
	theirManifest, err := loadManifestForDrift(otherRoot, theirHead, includeDirty)
	if err != nil {
		return nil, fmt.Errorf("failed to load target workspace state: %w", err)
	}

	ourChanges := drift.CompareManifests(ancestorManifest, ourManifest)
	theirChanges := drift.CompareManifests(ancestorManifest, theirManifest)

	snapshotConflictReport, err := conflicts.DetectFromAncestor(ws.root, otherRoot, mergeBaseID, false)
	if err != nil {
		return nil, fmt.Errorf("failed to detect snapshot conflicts: %w", err)
	}

	var dirtyConflictReport *conflicts.Report
	if includeDirty {
		dirtyConflictReport, err = conflicts.DetectFromAncestor(ws.root, otherRoot, mergeBaseID, true)
		if err != nil {
			return nil, fmt.Errorf("failed to detect dirty conflicts: %w", err)
		}
	}

	overlapping := findOverlappingPaths(ourChanges, theirChanges)

	return &DriftResult{
		OurName:           ws.cfg.WorkspaceName,
		TheirName:         otherName,
		CommonAncestorID:  mergeBaseID,
		OurHead:           ourHead,
		TheirHead:         theirHead,
		OurChanges:        ourChanges,
		TheirChanges:      theirChanges,
		SnapshotConflicts: snapshotConflictReport,
		DirtyConflicts:    dirtyConflictReport,
		OverlappingPaths:  overlapping,
	}, nil
}

func (ws *Workspace) resolveTargetWorkspace(target string) (root, name string, err error) {
	if target != "" {
		wsInfo, err := ws.store.FindWorkspaceByName(target)
		if err != nil {
			return "", "", fmt.Errorf("workspace '%s' not found in project\nRun 'fst workspaces' to see available workspaces.", target)
		}
		return wsInfo.Path, wsInfo.WorkspaceName, nil
	}

	// Find main workspace from store registry
	workspaces, err := ws.store.ListWorkspaces()
	if err != nil {
		return "", "", fmt.Errorf("failed to list workspaces: %w", err)
	}

	for _, wsInfo := range workspaces {
		if wsInfo.WorkspaceName == "main" && wsInfo.WorkspaceID != ws.cfg.WorkspaceID {
			return wsInfo.Path, wsInfo.WorkspaceName, nil
		}
	}

	return "", "", fmt.Errorf("no main workspace found in project\nSpecify a workspace: fst drift <workspace-name>")
}

func loadManifestForDrift(root, snapshotID string, includeDirty bool) (*manifest.Manifest, error) {
	if includeDirty {
		return manifest.GenerateWithCache(root, config.GetStatCachePath(root))
	}
	return drift.LoadManifestFromSnapshots(root, snapshotID)
}

func findOverlappingPaths(ours, theirs *drift.Report) []string {
	ourSet := make(map[string]bool)
	for _, f := range ours.FilesAdded {
		ourSet[f] = true
	}
	for _, f := range ours.FilesModified {
		ourSet[f] = true
	}

	var overlapping []string
	for _, f := range theirs.FilesAdded {
		if ourSet[f] {
			overlapping = append(overlapping, f)
		}
	}
	for _, f := range theirs.FilesModified {
		if ourSet[f] {
			overlapping = append(overlapping, f)
		}
	}
	return overlapping
}
