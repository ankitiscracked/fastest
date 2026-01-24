package drift

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

// Report represents the drift from a fork snapshot
type Report struct {
	ForkSnapshotID string   `json:"fork_snapshot_id,omitempty"`
	FilesAdded     []string `json:"files_added"`
	FilesModified  []string `json:"files_modified"`
	FilesDeleted   []string `json:"files_deleted"`
	BytesChanged   int64    `json:"bytes_changed"`
	Summary        string   `json:"summary,omitempty"`
}

// DivergenceReport represents how two workspaces have diverged from a common ancestor
type DivergenceReport struct {
	CommonAncestorID string `json:"common_ancestor_id,omitempty"`
	HasCommonAncestor bool  `json:"has_common_ancestor"`

	// Changes in "our" workspace (current) since common ancestor
	OurChanges *Report `json:"our_changes"`

	// Changes in "their" workspace since common ancestor
	TheirChanges *Report `json:"their_changes"`

	// Files modified in both workspaces (potential conflicts)
	OverlappingFiles []string `json:"overlapping_files"`

	// Summary for display
	Summary string `json:"summary,omitempty"`
}

// SnapshotMeta represents snapshot metadata
type SnapshotMeta struct {
	ID               string `json:"id"`
	WorkspaceID      string `json:"workspace_id"`
	WorkspaceName    string `json:"workspace_name"`
	ManifestHash     string `json:"manifest_hash"`
	ParentSnapshotID string `json:"parent_snapshot_id"`
	Message          string `json:"message"`
	CreatedAt        string `json:"created_at"`
	Files            int    `json:"files"`
	Size             int64  `json:"size"`
}

// LoadSnapshotMeta loads snapshot metadata from a workspace's snapshots directory
func LoadSnapshotMeta(root, snapshotID string) (*SnapshotMeta, error) {
	snapshotsDir := config.GetSnapshotsDirAt(root)
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

// GetUpstreamWorkspace finds the workspace that created the fork snapshot
// Returns the workspace path and name, or empty strings if not found
func GetUpstreamWorkspace(root string) (path string, name string, err error) {
	cfg, err := config.LoadAt(root)
	if err != nil {
		return "", "", err
	}

	if cfg.ForkSnapshotID == "" {
		return "", "", fmt.Errorf("no fork snapshot set")
	}

	// Load the fork snapshot metadata to find its source workspace
	meta, err := LoadSnapshotMeta(root, cfg.ForkSnapshotID)
	if err != nil {
		return "", "", err
	}

	// If the snapshot was created by this workspace, there's no upstream
	if meta.WorkspaceID == cfg.WorkspaceID {
		return "", "", fmt.Errorf("fork snapshot was created by this workspace")
	}

	// The snapshot metadata tells us which workspace created it
	// Now we need to find that workspace's path from the registry
	return meta.WorkspaceID, meta.WorkspaceName, nil
}

// Compute calculates drift between the base manifest and current state
func Compute(root string, baseManifest *manifest.Manifest) (*Report, error) {
	// Generate current manifest
	current, err := manifest.Generate(root, false)
	if err != nil {
		return nil, fmt.Errorf("failed to generate current manifest: %w", err)
	}

	// Compute diff
	added, modified, deleted := manifest.Diff(baseManifest, current)

	// Calculate bytes changed
	bytesChanged := calculateBytesChanged(baseManifest, current, added, modified, deleted)

	return &Report{
		FilesAdded:    added,
		FilesModified: modified,
		FilesDeleted:  deleted,
		BytesChanged:  bytesChanged,
	}, nil
}

// ComputeFromCache computes drift using the cached base manifest
// Compares current working directory against the workspace's fork_snapshot_id
func ComputeFromCache(root string) (*Report, error) {
	// Load config to get fork snapshot ID
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("not in a project directory: %w", err)
	}

	if cfg.ForkSnapshotID == "" {
		// No fork snapshot, everything is new
		current, err := manifest.Generate(root, false)
		if err != nil {
			return nil, fmt.Errorf("failed to generate manifest: %w", err)
		}

		var added []string
		var bytesChanged int64
		for _, f := range current.Files {
			added = append(added, f.Path)
			bytesChanged += f.Size
		}

		return &Report{
			FilesAdded:    added,
			FilesModified: nil,
			FilesDeleted:  nil,
			BytesChanged:  bytesChanged,
		}, nil
	}

	// Load base manifest from local manifests directory
	manifestHash, err := config.ManifestHashFromSnapshotID(cfg.ForkSnapshotID)
	if err != nil {
		return nil, err
	}

	manifestsDir, err := config.GetManifestsDir()
	if err != nil {
		return nil, err
	}

	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("base manifest not found in manifests: %w", err)
	}

	baseManifest, err := manifest.FromJSON(data)
	if err != nil {
		return nil, fmt.Errorf("failed to parse base manifest: %w", err)
	}

	report, err := Compute(root, baseManifest)
	if err != nil {
		return nil, err
	}

	report.ForkSnapshotID = cfg.ForkSnapshotID
	return report, nil
}

// ComputeAgainstWorkspace compares current workspace against another workspace
// otherRoot is the path to the other workspace
// If includeDirty is true, compares against the other workspace's current files
// Otherwise, compares against the other workspace's last snapshot
func ComputeAgainstWorkspace(root, otherRoot string, includeDirty bool) (*Report, error) {
	// Get other workspace's manifest
	var otherManifest *manifest.Manifest
	var referenceID string

	if includeDirty {
		// Generate manifest from other workspace's current files
		var err error
		otherManifest, err = manifest.Generate(otherRoot, false)
		if err != nil {
			return nil, fmt.Errorf("failed to generate other workspace manifest: %w", err)
		}
		referenceID = "workspace:dirty"
	} else {
		// Load other workspace's most recent snapshot manifest
		otherCfg, err := config.LoadAt(otherRoot)
		if err != nil {
			return nil, fmt.Errorf("failed to load other workspace config: %w", err)
		}

		// Use other's most recent snapshot, fall back to base
		snapshotID, _ := config.GetLatestSnapshotIDAt(otherRoot)
		if snapshotID == "" {
			snapshotID = otherCfg.ForkSnapshotID
		}

		if snapshotID == "" {
			return nil, fmt.Errorf("other workspace has no snapshots")
		}

		manifestHash, err := config.ManifestHashFromSnapshotID(snapshotID)
		if err != nil {
			return nil, fmt.Errorf("invalid snapshot id: %w", err)
		}

		otherManifestsDir := config.GetManifestsDirAt(otherRoot)
		manifestPath := filepath.Join(otherManifestsDir, manifestHash+".json")
		data, err := os.ReadFile(manifestPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load other workspace's snapshot: %w", err)
		}

		otherManifest, err = manifest.FromJSON(data)
		if err != nil {
			return nil, fmt.Errorf("failed to parse other workspace's snapshot: %w", err)
		}
		referenceID = snapshotID
	}

	// Generate current workspace manifest
	currentManifest, err := manifest.Generate(root, false)
	if err != nil {
		return nil, fmt.Errorf("failed to generate current manifest: %w", err)
	}

	// Compute diff: other → current (what's different in current vs other)
	added, modified, deleted := manifest.Diff(otherManifest, currentManifest)

	// Calculate bytes changed
	bytesChanged := calculateBytesChanged(otherManifest, currentManifest, added, modified, deleted)

	return &Report{
		ForkSnapshotID: referenceID,
		FilesAdded:     added,
		FilesModified:  modified,
		FilesDeleted:   deleted,
		BytesChanged:   bytesChanged,
	}, nil
}

// ComputeDivergence computes how two workspaces have diverged from their common ancestor
// This is useful for understanding potential merge conflicts before they happen
func ComputeDivergence(ourRoot, theirRoot string, includeDirty bool) (*DivergenceReport, error) {
	ourCfg, err := config.LoadAt(ourRoot)
	if err != nil {
		return nil, fmt.Errorf("failed to load our config: %w", err)
	}

	theirCfg, err := config.LoadAt(theirRoot)
	if err != nil {
		return nil, fmt.Errorf("failed to load their config: %w", err)
	}

	// Find common ancestor
	// For now, use our fork_snapshot_id as the common ancestor
	// This works when "their" workspace is upstream (created our fork snapshot)
	// or when both forked from the same point
	commonAncestorID := ourCfg.ForkSnapshotID
	hasCommonAncestor := commonAncestorID != ""

	// If their base is the same as ours, we definitely share an ancestor
	if theirCfg.ForkSnapshotID == ourCfg.ForkSnapshotID && commonAncestorID != "" {
		hasCommonAncestor = true
	}

	report := &DivergenceReport{
		CommonAncestorID:  commonAncestorID,
		HasCommonAncestor: hasCommonAncestor,
	}

	if hasCommonAncestor {
		// Load common ancestor manifest
		ancestorManifest, err := LoadManifestFromSnapshots(ourRoot, commonAncestorID)
		if err != nil {
			// Try loading from their workspace
			ancestorManifest, err = LoadManifestFromSnapshots(theirRoot, commonAncestorID)
			if err != nil {
				// Fall back to 2-way comparison
				hasCommonAncestor = false
				report.HasCommonAncestor = false
			}
		}

		if hasCommonAncestor && ancestorManifest != nil {
			// Compute our changes from ancestor
			ourReport, err := Compute(ourRoot, ancestorManifest)
			if err != nil {
				return nil, fmt.Errorf("failed to compute our changes: %w", err)
			}
			ourReport.ForkSnapshotID = commonAncestorID
			report.OurChanges = ourReport

			// Compute their changes from ancestor
			var theirManifest *manifest.Manifest
			if includeDirty {
				theirManifest, err = manifest.Generate(theirRoot, false)
				if err != nil {
					return nil, fmt.Errorf("failed to generate their manifest: %w", err)
				}
			} else {
				theirSnapshotID, _ := config.GetLatestSnapshotIDAt(theirRoot)
				if theirSnapshotID == "" {
					theirSnapshotID = theirCfg.ForkSnapshotID
				}
				if theirSnapshotID != "" {
					theirManifest, err = LoadManifestFromSnapshots(theirRoot, theirSnapshotID)
					if err != nil {
						// Fall back to generating
						theirManifest, err = manifest.Generate(theirRoot, false)
						if err != nil {
							return nil, fmt.Errorf("failed to get their manifest: %w", err)
						}
					}
				} else {
					theirManifest, err = manifest.Generate(theirRoot, false)
					if err != nil {
						return nil, fmt.Errorf("failed to generate their manifest: %w", err)
					}
				}
			}

			theirAdded, theirModified, theirDeleted := manifest.Diff(ancestorManifest, theirManifest)
			theirBytesChanged := calculateBytesChanged(ancestorManifest, theirManifest, theirAdded, theirModified, theirDeleted)
			report.TheirChanges = &Report{
				ForkSnapshotID: commonAncestorID,
				FilesAdded:     theirAdded,
				FilesModified:  theirModified,
				FilesDeleted:   theirDeleted,
				BytesChanged:   theirBytesChanged,
			}

			// Find overlapping files (modified in both)
			ourModifiedSet := make(map[string]bool)
			for _, f := range ourReport.FilesModified {
				ourModifiedSet[f] = true
			}
			for _, f := range ourReport.FilesAdded {
				ourModifiedSet[f] = true
			}

			for _, f := range theirModified {
				if ourModifiedSet[f] {
					report.OverlappingFiles = append(report.OverlappingFiles, f)
				}
			}
			for _, f := range theirAdded {
				if ourModifiedSet[f] {
					report.OverlappingFiles = append(report.OverlappingFiles, f)
				}
			}

			return report, nil
		}
	}

	// No common ancestor - fall back to simple 2-way comparison
	simpleReport, err := ComputeAgainstWorkspace(ourRoot, theirRoot, includeDirty)
	if err != nil {
		return nil, err
	}

	report.OurChanges = simpleReport
	report.TheirChanges = &Report{} // Empty - we don't know their changes without ancestor
	return report, nil
}

// HasOverlap returns true if there are overlapping changes
func (r *DivergenceReport) HasOverlap() bool {
	return len(r.OverlappingFiles) > 0
}

// FormatSummary returns a human-readable summary of divergence
func (r *DivergenceReport) FormatSummary() string {
	if r.OurChanges == nil || !r.OurChanges.HasChanges() {
		if r.TheirChanges == nil || !r.TheirChanges.HasChanges() {
			return "Workspaces are in sync"
		}
		return fmt.Sprintf("They changed: %s", r.TheirChanges.FormatSummary())
	}

	if r.TheirChanges == nil || !r.TheirChanges.HasChanges() {
		return fmt.Sprintf("We changed: %s", r.OurChanges.FormatSummary())
	}

	overlap := ""
	if len(r.OverlappingFiles) > 0 {
		overlap = fmt.Sprintf(", %d overlapping", len(r.OverlappingFiles))
	}

	return fmt.Sprintf("We: %s | They: %s%s",
		r.OurChanges.FormatSummary(),
		r.TheirChanges.FormatSummary(),
		overlap)
}

// ToJSON converts the divergence report to JSON
func (r *DivergenceReport) ToJSON() ([]byte, error) {
	return json.MarshalIndent(r, "", "  ")
}

// LoadManifestFromSnapshots loads a manifest from a workspace's manifests directory
func LoadManifestFromSnapshots(root, snapshotID string) (*manifest.Manifest, error) {
	manifestHash, err := config.ManifestHashFromSnapshotID(snapshotID)
	if err != nil {
		return nil, err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("manifest not found in manifests: %w", err)
	}
	return manifest.FromJSON(data)
}

// CompareManifests compares two manifests and returns a drift report.
// The comparison treats "current" as the upstream/source and "base" as the local workspace.
// Added files are present in current but not in base (source_only).
func CompareManifests(base, current *manifest.Manifest) *Report {
	added, modified, deleted := manifest.Diff(base, current)
	bytesChanged := calculateBytesChanged(base, current, added, modified, deleted)
	return &Report{
		FilesAdded:    added,
		FilesModified: modified,
		FilesDeleted:  deleted,
		BytesChanged:  bytesChanged,
	}
}

// HasChanges returns true if there are any changes
func (r *Report) HasChanges() bool {
	return len(r.FilesAdded) > 0 || len(r.FilesModified) > 0 || len(r.FilesDeleted) > 0
}

// TotalChanges returns the total number of changed files
func (r *Report) TotalChanges() int {
	return len(r.FilesAdded) + len(r.FilesModified) + len(r.FilesDeleted)
}

// ToJSON converts the report to JSON
func (r *Report) ToJSON() ([]byte, error) {
	return json.MarshalIndent(r, "", "  ")
}

// FormatSummary returns a human-readable summary
func (r *Report) FormatSummary() string {
	if !r.HasChanges() {
		return "No changes"
	}

	return fmt.Sprintf("+%d ~%d -%d (%s)",
		len(r.FilesAdded),
		len(r.FilesModified),
		len(r.FilesDeleted),
		formatBytes(r.BytesChanged))
}

func formatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB"}
	i := 0
	fb := float64(bytes)
	for fb >= k && i < len(sizes)-1 {
		fb /= k
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", bytes, sizes[i])
	}
	return fmt.Sprintf("%.1f %s", fb, sizes[i])
}

// calculateBytesChanged calculates the total bytes changed between manifests
func calculateBytesChanged(base, current *manifest.Manifest, added, modified, deleted []string) int64 {
	var bytesChanged int64

	currentMap := make(map[string]manifest.FileEntry)
	for _, f := range current.Files {
		currentMap[f.Path] = f
	}
	baseMap := make(map[string]manifest.FileEntry)
	for _, f := range base.Files {
		baseMap[f.Path] = f
	}

	// Added files contribute their full size
	for _, path := range added {
		if f, ok := currentMap[path]; ok {
			bytesChanged += f.Size
		}
	}

	// Modified files contribute the delta
	for _, path := range modified {
		curr, currOk := currentMap[path]
		baseF, baseOk := baseMap[path]
		if currOk && baseOk {
			if curr.Size > baseF.Size {
				bytesChanged += curr.Size - baseF.Size
			} else {
				bytesChanged += baseF.Size - curr.Size
			}
		} else if currOk {
			bytesChanged += curr.Size
		}
	}

	// Deleted files contribute their original size
	for _, path := range deleted {
		if f, ok := baseMap[path]; ok {
			bytesChanged += f.Size
		}
	}

	return bytesChanged
}
