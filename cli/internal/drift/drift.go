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

// SnapshotMeta represents snapshot metadata
type SnapshotMeta struct {
	ID                string   `json:"id"`
	WorkspaceID       string   `json:"workspace_id"`
	WorkspaceName     string   `json:"workspace_name"`
	ManifestHash      string   `json:"manifest_hash"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	Message           string   `json:"message"`
	CreatedAt         string   `json:"created_at"`
	Files             int      `json:"files"`
	Size              int64    `json:"size"`
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

// GetUpstreamWorkspace finds the workspace that created the base snapshot
// Returns the workspace path and name, or empty strings if not found
func GetUpstreamWorkspace(root string) (path string, name string, err error) {
	cfg, err := config.LoadAt(root)
	if err != nil {
		return "", "", err
	}

	if cfg.BaseSnapshotID == "" {
		return "", "", fmt.Errorf("no base snapshot set")
	}

	// Load the base snapshot metadata to find its source workspace
	meta, err := LoadSnapshotMeta(root, cfg.BaseSnapshotID)
	if err != nil {
		return "", "", err
	}

	// If the snapshot was created by this workspace, there's no upstream
	if meta.WorkspaceID == cfg.WorkspaceID {
		return "", "", fmt.Errorf("base snapshot was created by this workspace")
	}

	// The snapshot metadata tells us which workspace created it
	// Now we need to find that workspace's path from the registry
	return meta.WorkspaceID, meta.WorkspaceName, nil
}

// Compute calculates drift between the base manifest and current state
func Compute(root string, baseManifest *manifest.Manifest) (*Report, error) {
	// Generate current manifest
	current, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
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
		current, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
		if err != nil {
			return nil, fmt.Errorf("failed to generate manifest: %w", err)
		}

		var added []string
		var bytesChanged int64
		for _, f := range append(current.FileEntries(), current.SymlinkEntries()...) {
			added = append(added, f.Path)
			if f.Type == manifest.EntryTypeFile {
				bytesChanged += f.Size
			}
		}

		return &Report{
			FilesAdded:    added,
			FilesModified: nil,
			FilesDeleted:  nil,
			BytesChanged:  bytesChanged,
		}, nil
	}

	// Load base manifest from local manifests directory
	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, cfg.BaseSnapshotID)
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

	report.BaseSnapshotID = cfg.BaseSnapshotID
	return report, nil
}

// ComputeFromLatestSnapshot compares current working directory against latest snapshot.
func ComputeFromLatestSnapshot(root string) (*Report, error) {
	snapshotID, _ := config.GetLatestSnapshotIDAt(root)
	if snapshotID == "" {
		current, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
		if err != nil {
			return nil, fmt.Errorf("failed to generate manifest: %w", err)
		}

		var added []string
		var bytesChanged int64
		for _, f := range append(current.FileEntries(), current.SymlinkEntries()...) {
			added = append(added, f.Path)
			if f.Type == manifest.EntryTypeFile {
				bytesChanged += f.Size
			}
		}

		return &Report{
			FilesAdded:    added,
			FilesModified: nil,
			FilesDeleted:  nil,
			BytesChanged:  bytesChanged,
		}, nil
	}

	baseManifest, err := LoadManifestFromSnapshots(root, snapshotID)
	if err != nil {
		return nil, err
	}

	report, err := Compute(root, baseManifest)
	if err != nil {
		return nil, err
	}

	return report, nil
}

// LoadManifestFromSnapshots loads a manifest from a workspace's manifests directory
func LoadManifestFromSnapshots(root, snapshotID string) (*manifest.Manifest, error) {
	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, snapshotID)
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
	for _, f := range current.FileEntries() {
		currentMap[f.Path] = f
	}
	baseMap := make(map[string]manifest.FileEntry)
	for _, f := range base.FileEntries() {
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
