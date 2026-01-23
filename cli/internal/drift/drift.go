package drift

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

// Report represents the drift from a base snapshot
type Report struct {
	BaseSnapshotID string   `json:"base_snapshot_id,omitempty"`
	FilesAdded     []string `json:"files_added"`
	FilesModified  []string `json:"files_modified"`
	FilesDeleted   []string `json:"files_deleted"`
	BytesChanged   int64    `json:"bytes_changed"`
	Summary        string   `json:"summary,omitempty"`
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
// Compares current working directory against the workspace's base_snapshot_id
func ComputeFromCache(root string) (*Report, error) {
	// Load config to get base snapshot ID
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("not in a project directory: %w", err)
	}

	if cfg.BaseSnapshotID == "" {
		// No base snapshot, everything is new
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

	// Load base manifest from local snapshots directory
	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return nil, err
	}

	manifestPath := filepath.Join(snapshotsDir, cfg.BaseSnapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("base manifest not found in snapshots: %w", err)
	}

	baseManifest, err := manifest.FromJSON(data)
	if err != nil {
		return nil, fmt.Errorf("failed to parse base manifest: %w", err)
	}

	report, err := Compute(root, baseManifest)
	if err != nil {
		return nil, err
	}

	report.BaseSnapshotID = cfg.BaseSnapshotID
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
		// Load other workspace's last snapshot manifest
		otherCfg, err := config.LoadAt(otherRoot)
		if err != nil {
			return nil, fmt.Errorf("failed to load other workspace config: %w", err)
		}

		// Use other's last snapshot, fall back to base
		snapshotID := otherCfg.LastSnapshotID
		if snapshotID == "" {
			snapshotID = otherCfg.BaseSnapshotID
		}

		if snapshotID == "" {
			return nil, fmt.Errorf("other workspace has no snapshots")
		}

		otherSnapshotsDir := config.GetSnapshotsDirAt(otherRoot)
		manifestPath := filepath.Join(otherSnapshotsDir, snapshotID+".json")
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
		BaseSnapshotID: referenceID,
		FilesAdded:     added,
		FilesModified:  modified,
		FilesDeleted:   deleted,
		BytesChanged:   bytesChanged,
	}, nil
}

// LoadManifestFromSnapshots loads a manifest from a workspace's snapshots directory
func LoadManifestFromSnapshots(root, snapshotID string) (*manifest.Manifest, error) {
	snapshotsDir := config.GetSnapshotsDirAt(root)
	manifestPath := filepath.Join(snapshotsDir, snapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("manifest not found in snapshots: %w", err)
	}
	return manifest.FromJSON(data)
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
