package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	// Remove placeholder clone command if present
	for _, cmd := range rootCmd.Commands() {
		if cmd.Use == "clone <project|snapshot>" {
			rootCmd.RemoveCommand(cmd)
			break
		}
	}
	rootCmd.AddCommand(newCloneCmd())
}

func newCloneCmd() *cobra.Command {
	var targetDir string

	cmd := &cobra.Command{
		Use:   "clone <project|snapshot>",
		Short: "Clone a project or snapshot to a new workspace",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runClone(args[0], targetDir)
		},
	}

	cmd.Flags().StringVarP(&targetDir, "to", "t", "", "Target directory (default: project or snapshot name)")

	return cmd
}

func runClone(target string, targetDir string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	client := newAPIClient(token, nil)

	var snapshot *api.Snapshot
	var projectID string
	var projectName string

	snapshot, err = client.GetSnapshot(target)
	if err != nil {
		if !strings.Contains(err.Error(), "snapshot not found") {
			return err
		}

		project, _, err := client.GetProject(target)
		if err != nil {
			return fmt.Errorf("failed to fetch project: %w", err)
		}
		if project.LastSnapshotID == nil || *project.LastSnapshotID == "" {
			return fmt.Errorf("project has no snapshots to clone")
		}
		projectID = project.ID
		projectName = project.Name
		snapshot, err = client.GetSnapshot(*project.LastSnapshotID)
		if err != nil {
			return fmt.Errorf("failed to fetch project snapshot: %w", err)
		}
	} else {
		projectID = snapshot.ProjectID
	}

	if targetDir == "" {
		if projectName != "" {
			targetDir = projectName
		} else {
			targetDir = "snapshot-" + snapshot.ID
		}
	}

	if err := ensureEmptyDir(targetDir); err != nil {
		return err
	}
	absTargetDir, err := filepath.Abs(targetDir)
	if err != nil {
		return err
	}

	manifestJSON, err := client.DownloadManifest(snapshot.ManifestHash)
	if err != nil {
		return fmt.Errorf("failed to download manifest: %w", err)
	}

	m, err := manifest.FromJSON(manifestJSON)
	if err != nil {
		return fmt.Errorf("failed to parse manifest: %w", err)
	}

	workspaceName := filepath.Base(absTargetDir)
	workspaceID := ""
	forkSnapshotID := snapshot.ID

	// Create cloud workspace for this clone
	ws, err := client.CreateWorkspace(projectID, api.CreateWorkspaceRequest{
		Name:           workspaceName,
		ForkSnapshotID: &forkSnapshotID,
		LocalPath:      &absTargetDir,
	})
	if err != nil {
		return fmt.Errorf("failed to create workspace: %w", err)
	}
	workspaceID = ws.ID

	if err := config.InitAt(absTargetDir, projectID, workspaceID, workspaceName, forkSnapshotID); err != nil {
		return err
	}

	if err := materializeSnapshot(client, absTargetDir, m); err != nil {
		return err
	}

	if err := writeSnapshotFiles(absTargetDir, snapshot, manifestJSON, m, workspaceName); err != nil {
		return err
	}

	cfg, _ := config.LoadAt(absTargetDir)
	if cfg != nil {
		cfg.Mode = "cloud"
		cfg.CurrentSnapshotID = snapshot.ID
		_ = config.SaveAt(absTargetDir, cfg)
	}

	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      projectID,
		Name:           workspaceName,
		Path:           absTargetDir,
		ForkSnapshotID: forkSnapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	fmt.Println("✓ Clone complete!")
	fmt.Printf("  Directory: %s\n", absTargetDir)
	fmt.Printf("  Project:   %s\n", projectID)
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Snapshot:  %s\n", snapshot.ID)

	return nil
}

func ensureEmptyDir(path string) error {
	info, err := os.Stat(path)
	if err == nil {
		if !info.IsDir() {
			return fmt.Errorf("target exists and is not a directory: %s", path)
		}
		entries, err := os.ReadDir(path)
		if err != nil {
			return err
		}
		if len(entries) > 0 {
			return fmt.Errorf("target directory is not empty: %s", path)
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return os.MkdirAll(path, 0755)
}

func materializeSnapshot(client *api.Client, root string, m *manifest.Manifest) error {
	hashes := make([]string, 0, len(m.Files))
	seen := make(map[string]struct{})
	for _, f := range m.Files {
		if _, ok := seen[f.Hash]; ok {
			continue
		}
		seen[f.Hash] = struct{}{}
		hashes = append(hashes, f.Hash)
	}

	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return err
	}

	for i := 0; i < len(hashes); i += 100 {
		end := i + 100
		if end > len(hashes) {
			end = len(hashes)
		}
		urls, err := client.PresignDownload(hashes[i:end])
		if err != nil {
			return err
		}
		for _, hash := range hashes[i:end] {
			url, ok := urls[hash]
			if !ok || url == "" {
				return fmt.Errorf("missing download URL for blob %s", hash)
			}
			blobPath := filepath.Join(blobDir, hash)
			if _, err := os.Stat(blobPath); err == nil {
				continue
			}
			data, err := client.DownloadBlob(url)
			if err != nil {
				return err
			}
			if err := os.WriteFile(blobPath, data, 0644); err != nil {
				return err
			}
		}
	}

	for _, f := range m.Files {
		destPath := filepath.Join(root, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(destPath), 0755); err != nil {
			return err
		}
		blobPath := filepath.Join(blobDir, f.Hash)
		content, err := os.ReadFile(blobPath)
		if err != nil {
			return err
		}
		if err := os.WriteFile(destPath, content, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}

	return nil
}

func writeSnapshotFiles(root string, snapshot *api.Snapshot, manifestJSON []byte, m *manifest.Manifest, workspaceName string) error {
	snapshotsDir := filepath.Join(root, config.ConfigDirName, config.SnapshotsDirName)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return err
	}

	manifestsDir := filepath.Join(root, config.ConfigDirName, config.ManifestsDirName)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return err
	}

	manifestPath := filepath.Join(manifestsDir, snapshot.ManifestHash+".json")
	if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
		return err
	}

	metadataPath := filepath.Join(snapshotsDir, snapshot.ID+".meta.json")
	metadata := map[string]interface{}{
		"id":                 snapshot.ID,
		"workspace_id":       snapshot.WorkspaceID,
		"workspace_name":     workspaceName,
		"manifest_hash":      snapshot.ManifestHash,
		"parent_snapshot_id": snapshot.ParentSnapshotID,
		"message":            "",
		"agent":              "",
		"created_at":         snapshot.CreatedAt,
		"files":              m.FileCount(),
		"size":               m.TotalSize(),
	}
	encoded, err := json.MarshalIndent(metadata, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(metadataPath, encoded, 0644)
}
