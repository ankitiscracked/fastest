package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newSnapshotCmd())
}

func newSnapshotCmd() *cobra.Command {
	var message string
	var autoSummary bool
	var setBase bool

	cmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Capture current state as a snapshot",
		Long: `Capture the current state of the project as an immutable snapshot.

This will:
1. Scan all files (respecting .fstignore)
2. Save the snapshot locally for rollback support
3. Optionally sync to cloud if authenticated

Use --summary to auto-generate a description using your coding agent.
Use --set-base to update this workspace's base snapshot to the new one.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSnapshot(message, autoSummary, setBase)
		},
	}

	cmd.Flags().StringVarP(&message, "message", "m", "", "Description for this snapshot")
	cmd.Flags().BoolVar(&autoSummary, "summary", false, "Auto-generate description using coding agent")
	cmd.Flags().BoolVar(&setBase, "set-base", false, "Update workspace base to this snapshot")

	return cmd
}

func runSnapshot(message string, autoSummary bool, setBase bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	fmt.Println("Scanning files...")

	// Generate manifest (without mod times for reproducibility)
	m, err := manifest.Generate(root, false)
	if err != nil {
		return fmt.Errorf("failed to scan files: %w", err)
	}

	fmt.Printf("Found %d files (%s)\n", m.FileCount(), formatBytesLong(m.TotalSize()))

	// Compute content hash - this becomes the snapshot ID
	manifestHash, err := m.Hash()
	if err != nil {
		return fmt.Errorf("failed to create snapshot: %w", err)
	}

	// Create snapshot ID from hash (use first 16 chars for readability)
	snapshotID := "snap-" + manifestHash[:16]

	// Check if this exact snapshot already exists in local snapshots dir
	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return fmt.Errorf("failed to get snapshots directory: %w", err)
	}

	manifestPath := filepath.Join(snapshotsDir, snapshotID+".json")
	alreadyExists := false
	if _, err := os.Stat(manifestPath); err == nil {
		alreadyExists = true
	}

	// Generate summary if requested
	if autoSummary && message == "" {
		fmt.Println("Generating summary...")
		summary, err := generateSnapshotSummary(root, cfg)
		if err != nil {
			fmt.Printf("Warning: Could not generate summary: %v\n", err)
		} else {
			message = summary
		}
	}

	// Cache blobs (file contents) in global cache for rollback support
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return fmt.Errorf("failed to get global blob directory: %w", err)
	}

	blobsCached := 0
	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		// Skip if blob already cached
		if _, err := os.Stat(blobPath); err == nil {
			continue
		}

		// Read file content and cache it
		srcPath := filepath.Join(root, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			fmt.Printf("Warning: Could not cache %s: %v\n", f.Path, err)
			continue
		}

		if err := os.WriteFile(blobPath, content, 0644); err != nil {
			fmt.Printf("Warning: Could not cache %s: %v\n", f.Path, err)
			continue
		}
		blobsCached++
	}

	if blobsCached > 0 {
		fmt.Printf("Cached %d new blobs.\n", blobsCached)
	}

	// Save snapshot locally
	if !alreadyExists {
		manifestJSON, err := m.ToJSON()
		if err != nil {
			return fmt.Errorf("failed to save snapshot: %w", err)
		}

		if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
			return fmt.Errorf("failed to save snapshot: %w", err)
		}
	}

	// Save snapshot metadata
	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	if !alreadyExists || message != "" {
		metadata := fmt.Sprintf(`{
  "id": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_id": "%s",
  "message": "%s",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, manifestHash, cfg.BaseSnapshotID, escapeJSON(message),
			time.Now().UTC().Format(time.RFC3339), m.FileCount(), m.TotalSize())

		if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
			return fmt.Errorf("failed to save metadata: %w", err)
		}
	}

	// Try to sync to cloud if authenticated
	token, _ := auth.GetToken()
	cloudSynced := false
	if token != "" {
		client := api.NewClient(token)
		_, created, err := client.CreateSnapshot(cfg.ProjectID, manifestHash, cfg.BaseSnapshotID)
		if err == nil {
			cloudSynced = true
			if created {
				fmt.Println("Synced to cloud.")
			}
		}
	}

	// Always update last snapshot ID, optionally update base
	cfg.LastSnapshotID = snapshotID
	if setBase {
		cfg.BaseSnapshotID = snapshotID
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	// Output result
	fmt.Println()
	if alreadyExists {
		fmt.Println("✓ Snapshot already exists (no changes since last snapshot)")
	} else {
		fmt.Println("✓ Snapshot created!")
	}
	fmt.Println()
	fmt.Printf("  ID:       %s\n", snapshotID)
	fmt.Printf("  Hash:     %s\n", manifestHash[:16]+"...")
	fmt.Printf("  Files:    %d\n", m.FileCount())
	fmt.Printf("  Size:     %s\n", formatBytesLong(m.TotalSize()))
	if message != "" {
		fmt.Printf("  Message:  %s\n", message)
	}
	if cfg.BaseSnapshotID != "" && cfg.BaseSnapshotID != snapshotID {
		fmt.Printf("  Parent:   %s\n", cfg.BaseSnapshotID)
	}
	if setBase {
		fmt.Printf("  (base updated to this snapshot)\n")
	}
	if !cloudSynced && token == "" {
		fmt.Println("  (local only - not synced to cloud)")
	}

	return nil
}

// generateSnapshotSummary uses the coding agent to describe changes
func generateSnapshotSummary(root string, cfg *config.ProjectConfig) (string, error) {
	// Get preferred agent
	preferredAgent, err := agent.GetPreferredAgent()
	if err != nil {
		return "", err
	}

	// Compute drift from base
	report, err := drift.ComputeFromCache(root)
	if err != nil {
		return "", fmt.Errorf("failed to compute drift: %w", err)
	}

	// If no changes, return simple message
	if !report.HasChanges() {
		return "No changes from previous snapshot", nil
	}

	fmt.Printf("Using %s to generate summary...\n", preferredAgent.Name)

	// Build context with file contents
	fileContents := make(map[string]string)
	for _, f := range report.FilesAdded {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}
	for _, f := range report.FilesModified {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}

	diffContext := agent.BuildDiffContext(
		report.FilesAdded,
		report.FilesModified,
		report.FilesDeleted,
		fileContents,
	)

	// Invoke agent for summary
	summary, err := agent.InvokeSummary(preferredAgent, diffContext)
	if err != nil {
		return "", err
	}

	return summary, nil
}

// escapeJSON escapes a string for JSON
func escapeJSON(s string) string {
	result := ""
	for _, c := range s {
		switch c {
		case '"':
			result += `\"`
		case '\\':
			result += `\\`
		case '\n':
			result += `\n`
		case '\r':
			result += `\r`
		case '\t':
			result += `\t`
		default:
			result += string(c)
		}
	}
	return result
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
