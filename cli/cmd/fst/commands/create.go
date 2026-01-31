package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
}

func newCreateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create [workspace-name]",
		Short: "Create a new workspace",
		Long: `Create a new workspace with its own .fst metadata.

When run inside a project folder (fst.json), the workspace is created under
that folder and linked to the project's ID.

By default, the workspace name matches the directory name. If no workspace
name is provided under a parent, one is generated from the project name.`,
		Args: cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCreate(args)
		},
	}

	return cmd
}

func runCreate(args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	if _, err := config.FindProjectRoot(); err == nil {
		return fmt.Errorf("already inside a workspace - use 'fst workspace copy' instead")
	}

	parentRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err != nil && !errors.Is(err, config.ErrParentNotFound) {
		return err
	}
	if errors.Is(err, config.ErrParentNotFound) {
		return fmt.Errorf("no project folder found - run 'fst project init' first")
	}
	if err == nil {
		if cwd != parentRoot {
			return fmt.Errorf("run 'fst workspace create' from the project folder (%s)", parentRoot)
		}
		if len(args) > 1 {
			return fmt.Errorf("workspace name only when using a project folder")
		}

		workspaceName := ""
		if len(args) == 1 {
			workspaceName = args[0]
		} else {
			workspaceName = defaultWorkspaceName(parentCfg.ProjectName)
		}

		workspaceDir := filepath.Join(parentRoot, workspaceName)
		if _, err := os.Stat(workspaceDir); err == nil {
			return fmt.Errorf("target directory already exists: %s", workspaceDir)
		}
		if err := os.MkdirAll(workspaceDir, 0755); err != nil {
			return fmt.Errorf("failed to create workspace directory: %w", err)
		}

		workspaceID := generateWorkspaceID()
		if err := config.InitAt(workspaceDir, parentCfg.ProjectID, workspaceID, workspaceName, ""); err != nil {
			return fmt.Errorf("failed to initialize workspace: %w", err)
		}

		snapshotID, err := createInitialSnapshot(workspaceDir, workspaceID, workspaceName, false)
		if err != nil {
			return err
		}

		if err := RegisterWorkspace(RegisteredWorkspace{
			ID:             workspaceID,
			ProjectID:      parentCfg.ProjectID,
			Name:           workspaceName,
			Path:           workspaceDir,
			ForkSnapshotID: snapshotID,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			fmt.Printf("Warning: Could not register workspace: %v\n", err)
		}

		printCreateSuccess(parentCfg.ProjectName, workspaceName, workspaceDir, snapshotID)
		return nil
	}

	return nil
}

func defaultWorkspaceName(projectName string) string {
	return fmt.Sprintf("%s-%s", projectName, randomSuffix(4))
}

func printCreateSuccess(projectName, workspaceName, workspaceDir, snapshotID string) {
	fmt.Println()
	fmt.Println("✓ Workspace created!")
	fmt.Println()
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Directory: %s\n", workspaceDir)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  cd %s\n", workspaceDir)
	fmt.Println("  fst drift        # Check for changes")
}
