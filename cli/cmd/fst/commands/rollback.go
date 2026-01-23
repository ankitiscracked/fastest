package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newRollbackCmd())
}

func newRollbackCmd() *cobra.Command {
	var toSnapshot string
	var toBase bool
	var all bool
	var dryRun bool
	var force bool

	cmd := &cobra.Command{
		Use:   "rollback [files...]",
		Short: "Restore files from a snapshot",
		Long: `Restore files from a previous snapshot.

By default, restores files from the last snapshot (most recent save point).
Use --to to specify a different snapshot.
Use --to-base to restore to the base/fork point snapshot.

Examples:
  fst rollback src/main.py           # Restore single file from last snapshot
  fst rollback src/                  # Restore all files in directory
  fst rollback --all                 # Restore entire workspace to last snapshot
  fst rollback --all --to snap-abc   # Restore to specific snapshot
  fst rollback --all --to-base       # Restore to fork point
  fst rollback --dry-run --all       # Show what would be restored`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if !all && len(args) == 0 {
				return fmt.Errorf("specify files to rollback, or use --all")
			}
			if toSnapshot != "" && toBase {
				return fmt.Errorf("cannot use both --to and --to-base")
			}
			return runRollback(args, toSnapshot, toBase, all, dryRun, force)
		},
	}

	cmd.Flags().StringVar(&toSnapshot, "to", "", "Target snapshot ID (default: last snapshot)")
	cmd.Flags().BoolVar(&toBase, "to-base", false, "Restore to base/fork point snapshot")
	cmd.Flags().BoolVar(&all, "all", false, "Rollback entire workspace")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be restored without making changes")
	cmd.Flags().BoolVar(&force, "force", false, "Force rollback even if files have local changes")

	return cmd
}

func runRollback(files []string, toSnapshot string, toBase bool, all bool, dryRun bool, force bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return fmt.Errorf("failed to get snapshots directory: %w", err)
	}

	// Determine target snapshot (default to last snapshot, not base)
	targetSnapshotID := toSnapshot
	if targetSnapshotID == "" {
		if toBase {
			// Explicit --to-base: use fork point
			targetSnapshotID = cfg.BaseSnapshotID
			if targetSnapshotID == "" {
				return fmt.Errorf("no base snapshot set")
			}
		} else {
			// Default: prefer last snapshot (most recent save point) over base (fork point)
			if cfg.LastSnapshotID != "" {
				targetSnapshotID = cfg.LastSnapshotID
			} else {
				targetSnapshotID = cfg.BaseSnapshotID
			}
		}
	}
	if targetSnapshotID == "" {
		return fmt.Errorf("no snapshots found - create one with 'fst snapshot'")
	}

	// Load target manifest from local snapshots directory
	manifestPath := filepath.Join(snapshotsDir, targetSnapshotID+".json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("snapshot not found: %s", targetSnapshotID)
	}

	targetManifest, err := manifest.FromJSON(manifestData)
	if err != nil {
		return fmt.Errorf("failed to load snapshot: %w", err)
	}

	// Build lookup map of target files
	targetFiles := make(map[string]manifest.FileEntry)
	for _, f := range targetManifest.Files {
		targetFiles[f.Path] = f
	}

	// Determine which files to restore
	var toRestore []manifest.FileEntry
	var toDelete []string

	if all {
		// Restore all files from snapshot
		toRestore = targetManifest.Files

		// Find files to delete (exist now but not in snapshot)
		currentManifest, err := manifest.Generate(root, false)
		if err != nil {
			return fmt.Errorf("failed to scan current files: %w", err)
		}

		for _, f := range currentManifest.Files {
			if _, exists := targetFiles[f.Path]; !exists {
				toDelete = append(toDelete, f.Path)
			}
		}
	} else {
		// Restore specific files/directories
		for _, pattern := range files {
			// Normalize path
			pattern = filepath.ToSlash(pattern)
			pattern = strings.TrimSuffix(pattern, "/")

			matched := false
			for _, f := range targetManifest.Files {
				// Match exact file or directory prefix
				if f.Path == pattern || strings.HasPrefix(f.Path, pattern+"/") {
					toRestore = append(toRestore, f)
					matched = true
				}
			}

			if !matched {
				fmt.Printf("Warning: %s not found in snapshot\n", pattern)
			}
		}
	}

	if len(toRestore) == 0 && len(toDelete) == 0 {
		fmt.Println("Nothing to rollback.")
		return nil
	}

	// Sort for consistent output
	sort.Slice(toRestore, func(i, j int) bool {
		return toRestore[i].Path < toRestore[j].Path
	})
	sort.Strings(toDelete)

	// Check blob availability in global cache
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return fmt.Errorf("failed to get global blob directory: %w", err)
	}
	missingBlobs := []string{}
	for _, f := range toRestore {
		blobPath := filepath.Join(blobDir, f.Hash)
		if _, err := os.Stat(blobPath); os.IsNotExist(err) {
			missingBlobs = append(missingBlobs, f.Path)
		}
	}

	if len(missingBlobs) > 0 {
		fmt.Printf("Error: Missing cached blobs for %d files:\n", len(missingBlobs))
		for _, f := range missingBlobs {
			fmt.Printf("  %s\n", f)
		}
		fmt.Println()
		fmt.Println("These files cannot be restored. The snapshot may have been")
		fmt.Println("created before blob caching was enabled.")
		return fmt.Errorf("missing blobs")
	}

	// Show plan
	fmt.Printf("Rollback to: %s\n", targetSnapshotID)
	fmt.Println()

	if len(toRestore) > 0 {
		fmt.Printf("Files to restore (%d):\n", len(toRestore))
		for _, f := range toRestore {
			// Check if file differs from current
			currentPath := filepath.Join(root, f.Path)
			status := ""
			if _, err := os.Stat(currentPath); os.IsNotExist(err) {
				status = " (missing)"
			} else {
				currentHash, _ := manifest.HashFile(currentPath)
				if currentHash != f.Hash {
					status = " (modified)"
				} else {
					status = " (unchanged)"
				}
			}
			fmt.Printf("  \033[32m↩ %s\033[0m%s\n", f.Path, status)
		}
		fmt.Println()
	}

	if len(toDelete) > 0 {
		fmt.Printf("Files to delete (%d):\n", len(toDelete))
		for _, f := range toDelete {
			fmt.Printf("  \033[31m✗ %s\033[0m\n", f)
		}
		fmt.Println()
	}

	if dryRun {
		fmt.Println("(dry run - no changes made)")
		return nil
	}

	// Check for uncommitted changes if not forced
	if !force {
		hasChanges := false
		for _, f := range toRestore {
			currentPath := filepath.Join(root, f.Path)
			if _, err := os.Stat(currentPath); err == nil {
				currentHash, _ := manifest.HashFile(currentPath)
				if currentHash != f.Hash {
					// Check if it also differs from current base
					// (meaning there are local uncommitted changes)
					hasChanges = true
					break
				}
			}
		}
		if hasChanges {
			fmt.Println("Warning: Some files have local changes that will be lost.")
			fmt.Println("Use --force to proceed, or create a snapshot first.")
			return fmt.Errorf("local changes would be lost")
		}
	}

	// Perform rollback
	restored := 0
	deleted := 0

	for _, f := range toRestore {
		targetPath := filepath.Join(root, f.Path)
		blobPath := filepath.Join(blobDir, f.Hash)

		// Ensure parent directory exists
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			fmt.Printf("  ✗ %s: %v\n", f.Path, err)
			continue
		}

		// Read blob
		content, err := os.ReadFile(blobPath)
		if err != nil {
			fmt.Printf("  ✗ %s: %v\n", f.Path, err)
			continue
		}

		// Write file with original mode
		if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
			fmt.Printf("  ✗ %s: %v\n", f.Path, err)
			continue
		}

		restored++
	}

	for _, f := range toDelete {
		targetPath := filepath.Join(root, f)
		if err := os.Remove(targetPath); err != nil {
			fmt.Printf("  ✗ %s: %v\n", f, err)
			continue
		}
		deleted++

		// Try to remove empty parent directories
		dir := filepath.Dir(targetPath)
		for dir != root {
			if err := os.Remove(dir); err != nil {
				break // Directory not empty or other error
			}
			dir = filepath.Dir(dir)
		}
	}

	fmt.Printf("✓ Restored %d files", restored)
	if deleted > 0 {
		fmt.Printf(", deleted %d files", deleted)
	}
	fmt.Println()

	return nil
}
