package commands

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/ignore"
)

func init() {
	rootCmd.AddCommand(newCopyCmd())
}

func newCopyCmd() *cobra.Command {
	var name string
	var targetDir string

	cmd := &cobra.Command{
		Use:   "copy",
		Short: "Create a workspace copy",
		Long: `Create a new independent workspace by copying project files to a new directory.

This will:
1. Copy all project files to the target directory (respecting .fstignore)
2. Create a full .fst/ directory with its own config and snapshots
3. Set the new workspace's fork_snapshot_id to the current workspace's last snapshot (fork point)
4. Copy the fork-point snapshot to the new workspace

The new workspace is fully independent and can be moved or deleted without
affecting other workspaces. Blobs are stored in the global cache (~/.cache/fst/blobs/)
so there is no storage duplication.

If --to is not specified, creates a sibling directory of the project root
named {project}-{workspace}. For example, if the project is at /code/myapp,
running 'fst copy -n feature' creates /code/myapp-feature.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCopy(name, targetDir)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Name for the new workspace (required)")
	cmd.Flags().StringVarP(&targetDir, "to", "t", "", "Target directory (default: sibling of project root)")
	cmd.MarkFlagRequired("name")

	return cmd
}

func runCopy(name, targetDir string) error {
	// Load current config
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Determine the fork point snapshot
	// Use the most recent snapshot if available, otherwise fork_snapshot_id
	forkSnapshotID, _ := config.GetLatestSnapshotIDAt(root)
	if forkSnapshotID == "" {
		forkSnapshotID = cfg.ForkSnapshotID
	}
	if forkSnapshotID == "" {
		return fmt.Errorf("current workspace has no snapshots - run 'fst snapshot' first to create a fork point")
	}

	// Compute default target directory if not specified
	if targetDir == "" {
		// Create sibling of project root: {parent}/{project-name}-{workspace-name}
		projectName := filepath.Base(root)
		parentDir := filepath.Dir(root)
		targetDir = filepath.Join(parentDir, projectName+"-"+name)
	} else if !filepath.IsAbs(targetDir) {
		// Relative path - resolve from current directory
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		targetDir = filepath.Join(cwd, targetDir)
	}

	// Check if target exists
	if _, err := os.Stat(targetDir); err == nil {
		return fmt.Errorf("target directory already exists: %s", targetDir)
	}

	fmt.Printf("Creating workspace at %s...\n", targetDir)

	// Load ignore patterns
	matcher, err := ignore.LoadFromDir(root)
	if err != nil {
		return fmt.Errorf("failed to load ignore patterns: %w", err)
	}

	// Count files first
	var fileCount int
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		if relPath == "." {
			return nil
		}

		relPath = filepath.ToSlash(relPath)

		if matcher.Match(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if !info.IsDir() {
			fileCount++
		}

		return nil
	})
	if err != nil {
		return fmt.Errorf("failed to scan project: %w", err)
	}

	fmt.Printf("Copying %d files...\n", fileCount)

	// Create target directory
	if err := os.MkdirAll(targetDir, 0755); err != nil {
		return fmt.Errorf("failed to create target directory: %w", err)
	}

	// Copy files (excluding .fst)
	copied := 0
	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		if relPath == "." {
			return nil
		}

		relPath = filepath.ToSlash(relPath)

		if matcher.Match(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		targetPath := filepath.Join(targetDir, relPath)

		if info.IsDir() {
			return os.MkdirAll(targetPath, info.Mode())
		}

		// Copy file
		if err := copyFile(path, targetPath, info.Mode()); err != nil {
			return fmt.Errorf("failed to copy %s: %w", relPath, err)
		}

		copied++
		if copied%100 == 0 {
			fmt.Printf("  Copied %d/%d files...\n", copied, fileCount)
		}

		return nil
	})
	if err != nil {
		// Clean up on error
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to copy files: %w", err)
	}

	fmt.Printf("Copied %d files.\n", copied)

	// Generate workspace ID
	workspaceID := generateLocalID()

	// Initialize the new workspace with its own .fst/ directory
	// Set fork_snapshot_id to the fork point (source's current/last snapshot)
	if err := config.InitAt(targetDir, cfg.ProjectID, workspaceID, name, forkSnapshotID); err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}

	// Copy the fork-point snapshot metadata and manifest to the new workspace
	sourceSnapshotsDir := config.GetSnapshotsDirAt(root)
	targetSnapshotsDir := config.GetSnapshotsDirAt(targetDir)
	sourceManifestsDir := config.GetManifestsDirAt(root)
	targetManifestsDir := config.GetManifestsDirAt(targetDir)
	_ = os.MkdirAll(targetManifestsDir, 0755)

	// Copy snapshot manifest
	if manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, forkSnapshotID); err == nil {
		snapshotManifestSrc := filepath.Join(sourceManifestsDir, manifestHash+".json")
		snapshotManifestDst := filepath.Join(targetManifestsDir, manifestHash+".json")
		if err := copyFile(snapshotManifestSrc, snapshotManifestDst, 0644); err != nil {
			fmt.Printf("Warning: Could not copy snapshot manifest: %v\n", err)
		}
	} else {
		fmt.Printf("Warning: Could not parse snapshot id %s: %v\n", forkSnapshotID, err)
	}

	// Copy snapshot metadata if it exists
	snapshotMetaSrc := filepath.Join(sourceSnapshotsDir, forkSnapshotID+".meta.json")
	snapshotMetaDst := filepath.Join(targetSnapshotsDir, forkSnapshotID+".meta.json")
	if _, err := os.Stat(snapshotMetaSrc); err == nil {
		if err := copyFile(snapshotMetaSrc, snapshotMetaDst, 0644); err != nil {
			fmt.Printf("Warning: Could not copy snapshot metadata: %v\n", err)
		}
	}

	// Update the new workspace config mode
	newCfg, err := config.LoadAt(targetDir)
	if err == nil {
		newCfg.Mode = cfg.Mode
		config.SaveAt(targetDir, newCfg)
	}

	// Register workspace in global registry
	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      cfg.ProjectID,
		Name:           name,
		Path:           targetDir,
		ForkSnapshotID: forkSnapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	fmt.Println()
	fmt.Println("✓ Workspace created!")
	fmt.Println()
	fmt.Printf("  Name:      %s\n", name)
	fmt.Printf("  Directory: %s\n", targetDir)
	fmt.Printf("  Fork from: %s\n", forkSnapshotID)
	fmt.Printf("  ID:        %s\n", workspaceID)
	fmt.Println()
	fmt.Println("  (blobs shared in global cache - no storage duplication)")
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  cd %s\n", targetDir)
	fmt.Println("  fst drift        # Check for changes")

	return nil
}

// generateLocalID creates a random local workspace ID
func generateLocalID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "ws-" + hex.EncodeToString(bytes)
}

// copyFile copies a single file
func copyFile(src, dst string, mode os.FileMode) error {
	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer destination.Close()

	_, err = io.Copy(destination, source)
	return err
}
