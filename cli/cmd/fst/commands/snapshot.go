package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newSnapshotCmd())
}

func newSnapshotCmd() *cobra.Command {
	var message string

	cmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Capture current state as a snapshot",
		Long: `Capture the current state of the project as an immutable snapshot.

This will:
1. Generate a manifest of all files (respecting .fstignore)
2. Upload any new blobs to cloud storage
3. Register the snapshot with the cloud

The snapshot ID can be used to restore, clone, or compare against.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSnapshot(message)
		},
	}

	cmd.Flags().StringVarP(&message, "message", "m", "", "Optional message for this snapshot")

	return cmd
}

func runSnapshot(message string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	fmt.Println("Generating manifest...")

	// Generate manifest (without mod times for reproducibility)
	m, err := manifest.Generate(root, false)
	if err != nil {
		return fmt.Errorf("failed to generate manifest: %w", err)
	}

	fmt.Printf("Found %d files (%s)\n", m.FileCount(), formatBytesLong(m.TotalSize()))

	// Compute manifest hash
	manifestHash, err := m.Hash()
	if err != nil {
		return fmt.Errorf("failed to hash manifest: %w", err)
	}

	// Save manifest to cache
	configDir, err := config.GetConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config directory: %w", err)
	}

	manifestDir := filepath.Join(configDir, "cache", "manifests")
	if err := os.MkdirAll(manifestDir, 0755); err != nil {
		return fmt.Errorf("failed to create manifest cache: %w", err)
	}

	manifestJSON, err := m.ToJSON()
	if err != nil {
		return fmt.Errorf("failed to serialize manifest: %w", err)
	}

	// Save manifest locally
	manifestPath := filepath.Join(manifestDir, manifestHash+".json")
	if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
		return fmt.Errorf("failed to save manifest: %w", err)
	}

	// TODO: Upload blobs to R2
	// For now, we skip blob upload and just register the snapshot

	fmt.Println("Registering snapshot...")

	client := api.NewClient(token)

	// Create snapshot via API
	snapshot, created, err := client.CreateSnapshot(cfg.ProjectID, manifestHash, cfg.BaseSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to create snapshot: %w", err)
	}

	// Update local config with new base snapshot
	cfg.BaseSnapshotID = snapshot.ID
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	fmt.Println()
	if created {
		fmt.Println("✓ Snapshot created!")
	} else {
		fmt.Println("✓ Snapshot already exists (no changes)")
	}
	fmt.Println()
	fmt.Printf("  ID:       %s\n", snapshot.ID)
	fmt.Printf("  Hash:     %s\n", manifestHash[:16]+"...")
	fmt.Printf("  Files:    %d\n", m.FileCount())
	fmt.Printf("  Size:     %s\n", formatBytesLong(m.TotalSize()))

	if message != "" {
		fmt.Printf("  Message:  %s\n", message)
	}

	return nil
}

func formatBytesLong(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	fb := float64(bytes)
	for fb >= k && i < len(sizes)-1 {
		fb /= k
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", bytes, sizes[i])
	}
	return fmt.Sprintf("%.2f %s", fb, sizes[i])
}
