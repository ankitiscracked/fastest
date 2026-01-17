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
		Short: "Create a linked workspace copy",
		Long: `Create a new linked workspace by copying project files to a new directory.

This will:
1. Copy all project files to the target directory (respecting .fstignore)
2. Create a lightweight .fst link pointing to the main workspace
3. Share the blob cache with the main workspace (no duplication)

The new workspace shares storage with the main workspace, making copies fast
and storage-efficient even for large projects.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCopy(name, targetDir)
		},
	}

	cmd.Flags().StringVarP(&name, "name", "n", "", "Name for the new workspace (required)")
	cmd.Flags().StringVarP(&targetDir, "to", "t", "", "Target directory (required)")
	cmd.MarkFlagRequired("name")
	cmd.MarkFlagRequired("to")

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

	// Get main workspace path (for linking)
	mainPath, err := config.GetMainWorkspacePath()
	if err != nil {
		return fmt.Errorf("failed to find main workspace: %w", err)
	}

	// Resolve target directory
	if !filepath.IsAbs(targetDir) {
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

	fmt.Printf("Creating linked workspace at %s...\n", targetDir)

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

	// Initialize linked workspace
	// We need to cd to target dir temporarily to create the link
	origDir, err := os.Getwd()
	if err != nil {
		return err
	}
	if err := os.Chdir(targetDir); err != nil {
		return fmt.Errorf("failed to change to target directory: %w", err)
	}

	err = config.InitLinked(mainPath, workspaceID, name, cfg.BaseSnapshotID, cfg.ProjectID)
	os.Chdir(origDir) // Restore original directory

	if err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to initialize linked workspace: %w", err)
	}

	// Register workspace in global registry
	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      cfg.ProjectID,
		Name:           name,
		Path:           targetDir,
		BaseSnapshotID: cfg.BaseSnapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	fmt.Println()
	fmt.Println("✓ Linked workspace created!")
	fmt.Println()
	fmt.Printf("  Name:      %s\n", name)
	fmt.Printf("  Directory: %s\n", targetDir)
	fmt.Printf("  Main:      %s\n", mainPath)
	fmt.Printf("  Base:      %s\n", cfg.BaseSnapshotID)
	fmt.Printf("  ID:        %s\n", workspaceID)
	fmt.Println()
	fmt.Println("  (shares blob cache with main workspace - no storage duplication)")
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
	return "local-" + hex.EncodeToString(bytes)
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
