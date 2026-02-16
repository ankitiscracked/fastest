package commands

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func newInitCmd() *cobra.Command {
	var workspaceName string
	var noSnapshot bool
	var force bool

	cmd := &cobra.Command{
		Use:   "init [name]",
		Short: "Initialize a new Fastest project",
		Long: `Initialize a new Fastest project in the current directory.

This will:
1. Create a project locally
2. Create a main workspace for this directory
3. Set up the local .fst/ directory
4. Create an initial snapshot of current files

If no name is provided, the current directory name will be used.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInit(args, workspaceName, noSnapshot, force)
		},
	}

	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Name for this workspace (must match directory name)")
	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Don't create initial snapshot")
	cmd.Flags().BoolVar(&force, "force", false, "Skip safety checks (use with caution)")

	return cmd
}

func runInit(args []string, workspaceName string, noSnapshot bool, force bool) error {
	// Get current directory
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	// Check for project folder
	parentRoot, parentCfg, err := config.FindProjectRootFrom(cwd)
	if err != nil && !errors.Is(err, config.ErrProjectNotFound) {
		return err
	}
	if errors.Is(err, config.ErrProjectNotFound) {
		return fmt.Errorf("no project folder found - run 'fst project init' first")
	}
	if err == nil {
		if cwd == parentRoot {
			return fmt.Errorf("cannot initialize in project folder - create a workspace directory instead")
		}
		if filepath.Dir(cwd) != parentRoot {
			return fmt.Errorf("workspace must be a direct child of the project folder (%s)", parentRoot)
		}
	}

	// Check if current directory has .fst
	if _, err := os.Stat(filepath.Join(cwd, ".fst")); err == nil {
		return fmt.Errorf("already initialized - .fst exists in this directory")
	}

	// Safety checks (can be bypassed with --force)
	if !force {
		// Check for dangerous directories
		homeDir, _ := os.UserHomeDir()
		if cwd == homeDir {
			return fmt.Errorf("refusing to initialize in home directory - this would track all your files\nUse --force to override (not recommended)")
		}
		if cwd == "/" {
			return fmt.Errorf("refusing to initialize in root directory\nUse --force to override (not recommended)")
		}

		// Check if inside an existing fst project
		parentDir := filepath.Dir(cwd)
		for parentDir != "/" && parentDir != "." {
			if _, err := os.Stat(filepath.Join(parentDir, ".fst")); err == nil {
				return fmt.Errorf("already inside an fst project at %s\nUse --force to create a nested project", parentDir)
			}
			parentDir = filepath.Dir(parentDir)
		}

		// Quick file count to warn about large directories
		fileCount := 0
		filepath.Walk(cwd, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if !info.IsDir() {
				fileCount++
				if fileCount > 10000 {
					return fmt.Errorf("stopped counting") // Early exit
				}
			}
			return nil
		})

		if fileCount > 5000 {
			fmt.Printf("Warning: This directory contains %d+ files.\n", fileCount)
			fmt.Print("Are you sure you want to initialize here? [y/N] ")
			reader := bufio.NewReader(os.Stdin)
			response, _ := reader.ReadString('\n')
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "y" && response != "yes" {
				return fmt.Errorf("initialization cancelled")
			}
		}
	}

	// Determine project name
	var projectName string
	if parentCfg != nil {
		projectName = parentCfg.ProjectName
		if len(args) > 0 && args[0] != projectName {
			return fmt.Errorf("project name must match project folder name (%s)", projectName)
		}
	} else if len(args) > 0 {
		projectName = args[0]
	} else {
		projectName = filepath.Base(cwd)
	}

	// Determine workspace name
	defaultWorkspaceName := filepath.Base(cwd)
	if workspaceName == "" {
		workspaceName = defaultWorkspaceName
	} else if workspaceName != defaultWorkspaceName {
		return fmt.Errorf("workspace name must match directory name (%s)", defaultWorkspaceName)
	}

	// Local-only mode
	fmt.Printf("Creating project \"%s\"...\n", projectName)
	projectID := generateProjectID()
	workspaceID := generateWorkspaceID()

	// Create .fst directory structure using config.InitAt
	if err := config.InitAt(cwd, projectID, workspaceID, workspaceName, ""); err != nil {
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}

	// Create initial snapshot if not disabled
	var snapshotID string
	if !noSnapshot {
		snapshotID, err = createInitialSnapshot(cwd, workspaceID, workspaceName, false)
		if err != nil {
			return err
		}
	}

	// Register workspace in project-level registry
	if parentRoot, _, findErr := config.FindProjectRootFrom(cwd); findErr == nil {
		projectStore := store.OpenAt(parentRoot)
		if regErr := projectStore.RegisterWorkspace(store.WorkspaceInfo{
			WorkspaceID:    workspaceID,
			WorkspaceName:  workspaceName,
			Path:           cwd,
			BaseSnapshotID: snapshotID,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		}); regErr != nil {
			fmt.Printf("Warning: Could not register workspace: %v\n", regErr)
		}
	}

	fmt.Println()
	fmt.Println("✓ Project initialized!")
	fmt.Println()
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Directory: %s\n", cwd)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  fst drift                       # Check for changes")
	fmt.Println("  fst workspace create feature     # Create a new workspace")

	return nil
}

func generateProjectID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "proj-" + hex.EncodeToString(bytes)
}

func generateWorkspaceID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "ws-" + hex.EncodeToString(bytes)
}
