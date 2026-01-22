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
	var bytesChanged int64
	currentMap := make(map[string]manifest.FileEntry)
	for _, f := range current.Files {
		currentMap[f.Path] = f
	}
	baseMap := make(map[string]manifest.FileEntry)
	for _, f := range baseManifest.Files {
		baseMap[f.Path] = f
	}

	// Added files contribute their full size
	for _, path := range added {
		if f, ok := currentMap[path]; ok {
			bytesChanged += f.Size
		}
	}

	// Modified files contribute the delta (or full size if we can't compare)
	for _, path := range modified {
		current, currentOk := currentMap[path]
		base, baseOk := baseMap[path]
		if currentOk && baseOk {
			// Use the larger of the two as an approximation
			if current.Size > base.Size {
				bytesChanged += current.Size - base.Size
			} else {
				bytesChanged += base.Size - current.Size
			}
		} else if currentOk {
			bytesChanged += current.Size
		}
	}

	// Deleted files contribute their original size
	for _, path := range deleted {
		if f, ok := baseMap[path]; ok {
			bytesChanged += f.Size
		}
	}

	return &Report{
		FilesAdded:    added,
		FilesModified: modified,
		FilesDeleted:  deleted,
		BytesChanged:  bytesChanged,
	}, nil
}

// ComputeFromCache computes drift using the cached base manifest
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

	// Load base manifest from cache
	configDir, err := config.GetConfigDir()
	if err != nil {
		return nil, err
	}

	manifestPath := filepath.Join(configDir, "cache", "manifests", cfg.BaseSnapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("base manifest not found in cache: %w", err)
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

// ComputeAgainstMain compares current workspace against main workspace
// For main workspaces, falls back to base comparison (no main to compare against)
// For linked workspaces, compares against main's last snapshot
// If includeDirty is true, compares against main's current file state instead
func ComputeAgainstMain(root string, includeDirty bool) (*Report, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("not in a project directory: %w", err)
	}

	// Main workspace: compare against base (like current behavior)
	if cfg.IsMain {
		return ComputeFromCache(root)
	}

	// Get main workspace path
	mainPath, err := config.GetMainWorkspacePath()
	if err != nil {
		return nil, fmt.Errorf("cannot find main workspace: %w", err)
	}

	// Get main workspace's manifest
	var mainManifest *manifest.Manifest
	var referenceID string

	if includeDirty {
		// Generate manifest from main's current files
		mainManifest, err = manifest.Generate(mainPath, false)
		if err != nil {
			return nil, fmt.Errorf("failed to generate main workspace manifest: %w", err)
		}
		referenceID = "main:dirty"
	} else {
		// Load main's last snapshot manifest
		mainCfg, err := loadMainConfig(mainPath)
		if err != nil {
			return nil, fmt.Errorf("failed to load main workspace config: %w", err)
		}

		// Use main's last snapshot, fall back to base
		snapshotID := mainCfg.LastSnapshotID
		if snapshotID == "" {
			snapshotID = mainCfg.BaseSnapshotID
		}

		if snapshotID == "" {
			return nil, fmt.Errorf("main workspace has no snapshots")
		}

		mainManifest, err = loadManifestFromCache(snapshotID)
		if err != nil {
			return nil, fmt.Errorf("failed to load main's snapshot: %w", err)
		}
		referenceID = snapshotID
	}

	// Generate current workspace manifest
	currentManifest, err := manifest.Generate(root, false)
	if err != nil {
		return nil, fmt.Errorf("failed to generate current manifest: %w", err)
	}

	// Compute diff: main → current (what's different in current vs main)
	added, modified, deleted := manifest.Diff(mainManifest, currentManifest)

	// Calculate bytes changed
	bytesChanged := calculateBytesChanged(mainManifest, currentManifest, added, modified, deleted)

	return &Report{
		BaseSnapshotID: referenceID,
		FilesAdded:     added,
		FilesModified:  modified,
		FilesDeleted:   deleted,
		BytesChanged:   bytesChanged,
	}, nil
}

// loadMainConfig loads the config from the main workspace
func loadMainConfig(mainPath string) (*config.ProjectConfig, error) {
	configPath := filepath.Join(mainPath, config.ConfigDirName, config.ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read main config: %w", err)
	}

	var cfg config.ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse main config: %w", err)
	}

	return &cfg, nil
}

// loadManifestFromCache loads a manifest from the cache by snapshot ID
func loadManifestFromCache(snapshotID string) (*manifest.Manifest, error) {
	configDir, err := config.GetConfigDir()
	if err != nil {
		return nil, err
	}

	manifestPath := filepath.Join(configDir, "cache", "manifests", snapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("manifest not found in cache: %w", err)
	}

	return manifest.FromJSON(data)
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
