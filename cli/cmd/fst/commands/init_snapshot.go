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

	// Resolve author identity
	author, err := resolveAuthor()
	if err != nil {
		return "", err
	}

	m, err := manifest.Generate(root, false)
	if err != nil {
		return "", fmt.Errorf("failed to scan files: %w", err)
	}

	// Populate stat cache so subsequent status/drift checks are fast.
	manifest.BuildStatCacheFromManifest(root, m, config.GetStatCachePath(root))

	manifestHash, err := m.Hash()
	if err != nil {
		return "", fmt.Errorf("failed to create snapshot: %w", err)
	}

	createdAt := time.Now().UTC().Format(time.RFC3339)
	snapshotID := config.ComputeSnapshotID(manifestHash, nil, author.Name, author.Email, createdAt)

	// Cache blobs in project store
	blobDir := config.GetBlobsDirAt(root)
	if err := os.MkdirAll(blobDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create blob directory: %w", err)
	}
	for _, f := range m.FileEntries() {
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

	manifestsDir := config.GetManifestsDirAt(root)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create manifests directory: %w", err)
	}

	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
		return "", fmt.Errorf("failed to save snapshot: %w", err)
	}

	// Save metadata
	snapshotsDir := config.GetSnapshotsDirAt(root)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create snapshots directory: %w", err)
	}
	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	metadata := fmt.Sprintf(`{
  "id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_ids": [],
  "author_name": "%s",
  "author_email": "%s",
  "message": "Initial snapshot",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, workspaceID, escapeJSON(workspaceName), manifestHash,
		escapeJSON(author.Name), escapeJSON(author.Email),
		createdAt, m.FileCount(), m.TotalSize())

	if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
		return "", fmt.Errorf("failed to save metadata: %w", err)
	}

	fmt.Printf("Captured %d files.\n", m.FileCount())

	// Update config with base snapshot ID (base point)
	cfg, _ := config.LoadAt(root)
	cfg.BaseSnapshotID = snapshotID
	cfg.CurrentSnapshotID = snapshotID
	cfg.Mode = modeString(cloudSynced)
	if err := config.SaveAt(root, cfg); err != nil {
		return "", fmt.Errorf("failed to update config: %w", err)
	}

	return snapshotID, nil
}
