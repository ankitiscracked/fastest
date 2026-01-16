package commands

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
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
		Short: "Create a local copy of the current workspace",
		Long: `Create a new workspace by copying the current project to a new directory.

This will:
1. Copy all project files to the target directory (respecting .fstignore)
2. Initialize .fst/ in the new directory
3. Register the new workspace with the cloud
4. Set the current snapshot as the base for the new workspace

Use this to create multiple parallel working copies for different agents.`,
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

	// Get auth token (optional - we can work locally without it)
	token, _ := auth.GetToken()
	hasAuth := token != ""

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

	fmt.Printf("Copying project to %s...\n", targetDir)

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

	// Copy files
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

	// Try to register workspace with cloud (optional)
	var workspaceID string
	if hasAuth {
		fmt.Println("Registering workspace with cloud...")
		client := api.NewClient(token)
		machineID := config.GetMachineID()

		workspace, err := client.CreateWorkspace(cfg.ProjectID, api.CreateWorkspaceRequest{
			Name:           name,
			MachineID:      &machineID,
			LocalPath:      &targetDir,
			BaseSnapshotID: &cfg.BaseSnapshotID,
		})
		if err != nil {
			fmt.Printf("Warning: Failed to register with cloud: %v\n", err)
			workspaceID = generateLocalID()
		} else {
			workspaceID = workspace.ID
		}
	} else {
		// Generate local workspace ID
		workspaceID = generateLocalID()
	}

	// Initialize .fst/ in target directory
	fstDir := filepath.Join(targetDir, ".fst")
	if err := os.MkdirAll(fstDir, 0755); err != nil {
		return fmt.Errorf("failed to create .fst directory: %w", err)
	}

	// Create subdirectories
	for _, subdir := range []string{"cache", "cache/blobs", "cache/manifests"} {
		if err := os.MkdirAll(filepath.Join(fstDir, subdir), 0755); err != nil {
			return fmt.Errorf("failed to create %s: %w", subdir, err)
		}
	}

	// Copy the base manifest from source workspace
	srcManifestPath := filepath.Join(root, ".fst", "cache", "manifests", cfg.BaseSnapshotID+".json")
	dstManifestPath := filepath.Join(fstDir, "cache", "manifests", cfg.BaseSnapshotID+".json")
	if manifestData, err := os.ReadFile(srcManifestPath); err == nil {
		os.WriteFile(dstManifestPath, manifestData, 0644)
	}

	// Write config
	configData := fmt.Sprintf(`{
  "project_id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "base_snapshot_id": "%s",
  "mode": "%s",
  "local_path": "%s"
}`, cfg.ProjectID, workspaceID, name, cfg.BaseSnapshotID, cfg.Mode, targetDir)

	configPath := filepath.Join(fstDir, "config.json")
	if err := os.WriteFile(configPath, []byte(configData), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Create .gitignore
	gitignore := `# Fastest local cache
cache/
*.log
`
	if err := os.WriteFile(filepath.Join(fstDir, ".gitignore"), []byte(gitignore), 0644); err != nil {
		return fmt.Errorf("failed to write .gitignore: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Workspace copied successfully!")
	fmt.Println()
	fmt.Printf("  Name:      %s\n", name)
	fmt.Printf("  Directory: %s\n", targetDir)
	fmt.Printf("  Base:      %s\n", cfg.BaseSnapshotID)
	fmt.Printf("  ID:        %s\n", workspaceID)
	if !hasAuth {
		fmt.Println("  (local only - not synced to cloud)")
	}
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
