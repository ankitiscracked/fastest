package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newPullCmd())
}

func newPullCmd() *cobra.Command {
	var snapshotID string
	var force bool

	cmd := &cobra.Command{
		Use:   "pull",
		Short: "Pull latest snapshot from cloud",
		Long: `Pull the latest snapshot for this workspace from the cloud.

By default, pull refuses to overwrite local changes. Use --force to overwrite.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPull(snapshotID, force)
		},
	}

	cmd.Flags().StringVar(&snapshotID, "snapshot", "", "Pull a specific snapshot ID")
	cmd.Flags().BoolVar(&force, "force", false, "Overwrite local changes")

	return cmd
}

func runPull(snapshotID string, force bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	client := newAPIClient(token, cfg)

	if snapshotID == "" {
		ws, err := client.GetWorkspace(cfg.WorkspaceID)
		if err != nil {
			return fmt.Errorf("failed to fetch workspace: %w", err)
		}
		if ws.CurrentSnapshotID == nil || *ws.CurrentSnapshotID == "" {
			return fmt.Errorf("workspace has no remote snapshot")
		}
		snapshotID = *ws.CurrentSnapshotID
	}

	latestLocalID := cfg.CurrentSnapshotID
	if latestLocalID == "" {
		var err error
		latestLocalID, err = config.GetLatestSnapshotID()
		if err != nil {
			return fmt.Errorf("failed to read local snapshots: %w", err)
		}
	}
	if !force {
		dirty, err := isWorkingTreeDirty(root, latestLocalID)
		if err != nil {
			return err
		}
		if dirty {
			return fmt.Errorf("working tree has un-snapshotted changes; run 'fst snapshot' or use --force")
		}
	}

	snapshot, err := client.GetSnapshot(snapshotID)
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

	if err := removeFilesNotInManifest(root, m); err != nil {
		return err
	}

	if err := materializeSnapshot(client, root, m); err != nil {
		return err
	}

	if err := writeSnapshotFiles(root, snapshot, manifestJSON, m, cfg.WorkspaceName); err != nil {
		return err
	}

	cfg.Mode = "cloud"
	cfg.CurrentSnapshotID = snapshotID
	_ = config.SaveAt(root, cfg)

	fmt.Println("✓ Pull complete!")
	fmt.Printf("  Snapshot:  %s\n", snapshotID)

	return nil
}

func isWorkingTreeDirty(root, latestSnapshotID string) (bool, error) {
	current, err := manifest.Generate(root, false)
	if err != nil {
		return false, fmt.Errorf("failed to scan files: %w", err)
	}

	if latestSnapshotID == "" {
		return current.FileCount() > 0, nil
	}

	manifestHash, err := config.ManifestHashFromSnapshotID(latestSnapshotID)
	if err != nil {
		return true, err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return true, nil
	}

	previous, err := manifest.FromJSON(data)
	if err != nil {
		return true, nil
	}

	currentHash, err := current.Hash()
	if err != nil {
		return false, fmt.Errorf("failed to hash current manifest: %w", err)
	}
	previousHash, err := previous.Hash()
	if err != nil {
		return false, fmt.Errorf("failed to hash snapshot manifest: %w", err)
	}

	return currentHash != previousHash, nil
}

func removeFilesNotInManifest(root string, target *manifest.Manifest) error {
	current, err := manifest.Generate(root, false)
	if err != nil {
		return fmt.Errorf("failed to scan current files: %w", err)
	}

	targetSet := make(map[string]struct{}, len(target.Files))
	for _, f := range target.Files {
		targetSet[f.Path] = struct{}{}
	}

	for _, f := range current.Files {
		if _, ok := targetSet[f.Path]; ok {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(f.Path))
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	return nil
}
