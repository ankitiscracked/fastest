package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func createInitialSnapshot(root, workspaceID, workspaceName string, cloudSynced bool) (string, error) {
	fmt.Println("Creating initial snapshot...")

	m, err := manifest.Generate(root, false)
	if err != nil {
		return "", fmt.Errorf("failed to scan files: %w", err)
	}

	manifestHash, err := m.Hash()
	if err != nil {
		return "", fmt.Errorf("failed to create snapshot: %w", err)
	}

	snapshotID := generateSnapshotID()

	// Cache blobs in global cache
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return "", fmt.Errorf("failed to get global blob directory: %w", err)
	}
	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		if _, err := os.Stat(blobPath); err == nil {
			continue
		}
		srcPath := filepath.Join(root, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			continue
		}
		_ = os.WriteFile(blobPath, content, 0644)
	}

	// Save snapshot to local snapshots directory
	manifestJSON, err := m.ToJSON()
	if err != nil {
		return "", fmt.Errorf("failed to save snapshot: %w", err)
	}

	manifestsDir := filepath.Join(root, ".fst", config.ManifestsDirName)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create manifests directory: %w", err)
	}

	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
		return "", fmt.Errorf("failed to save snapshot: %w", err)
	}

	// Save metadata
	snapshotsDir := filepath.Join(root, ".fst", config.SnapshotsDirName)
	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	metadata := fmt.Sprintf(`{
  "id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_id": "",
  "message": "Initial snapshot",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, workspaceID, workspaceName, manifestHash, time.Now().UTC().Format(time.RFC3339), m.FileCount(), m.TotalSize())

	if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
		return "", fmt.Errorf("failed to save metadata: %w", err)
	}

	fmt.Printf("Captured %d files.\n", m.FileCount())

	// Update config with fork snapshot ID (fork point)
	cfg, _ := config.LoadAt(root)
	cfg.ForkSnapshotID = snapshotID
	cfg.CurrentSnapshotID = snapshotID
	cfg.Mode = modeString(cloudSynced)
	if err := config.SaveAt(root, cfg); err != nil {
		return "", fmt.Errorf("failed to update config: %w", err)
	}

	return snapshotID, nil
}
