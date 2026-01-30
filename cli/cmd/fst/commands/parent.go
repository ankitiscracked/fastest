package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newParentCmd()) })
}

func newParentCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "project",
		Short: "Manage project folder metadata",
	}
	cmd.AddCommand(newParentInitCmd())
	return cmd
}

func newParentInitCmd() *cobra.Command {
	var projectID string

	cmd := &cobra.Command{
		Use:   "init [project-name]",
		Short: "Initialize a project folder (fst.json)",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			projectName := ""
			if len(args) > 0 {
				projectName = args[0]
			}
			return runParentInit(projectName, projectID)
		},
	}

	cmd.Flags().StringVar(&projectID, "project-id", "", "Use an existing project ID")

	return cmd
}

func runParentInit(projectName, projectID string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	var workspaceRoot string
	var workspaceCfg *config.ProjectConfig
	if root, err := config.FindProjectRoot(); err == nil {
		workspaceRoot = root
		cfg, err := config.LoadAt(root)
		if err != nil {
			return err
		}
		workspaceCfg = cfg
		if projectID == "" {
			projectID = cfg.ProjectID
		} else if projectID != cfg.ProjectID {
			return fmt.Errorf("project ID mismatch: provided %s, detected %s", projectID, cfg.ProjectID)
		}
		if projectName == "" {
			projectName = filepath.Base(root)
		}
	} else {
		workspaceRoot = cwd
		if projectName == "" {
			return fmt.Errorf("project name is required when not in a workspace")
		}
		if projectID == "" {
			projectID = generateProjectID()
		}
	}

	if _, err := os.Stat(filepath.Join(workspaceRoot, config.ParentConfigFileName)); err == nil {
		return fmt.Errorf("project folder already initialized (%s exists)", config.ParentConfigFileName)
	}

	parentDir := filepath.Dir(workspaceRoot)
	parentPath := filepath.Join(parentDir, projectName)
	workspaceName := filepath.Base(workspaceRoot)

	if err := createParentContainer(parentPath, workspaceRoot, workspaceName); err != nil {
		return err
	}

	workspaceRoot = filepath.Join(parentPath, workspaceName)

	if workspaceCfg == nil {
		workspaceID := generateWorkspaceID()
		if err := config.InitAt(workspaceRoot, projectID, workspaceID, workspaceName, ""); err != nil {
			return fmt.Errorf("failed to initialize workspace: %w", err)
		}
		snapshotID, err := createInitialSnapshot(workspaceRoot, workspaceID, workspaceName, false)
		if err != nil {
			return err
		}
		if err := RegisterWorkspace(RegisteredWorkspace{
			ID:             workspaceID,
			ProjectID:      projectID,
			Name:           workspaceName,
			Path:           workspaceRoot,
			ForkSnapshotID: snapshotID,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			fmt.Printf("Warning: Could not register workspace: %v\n", err)
		}
	} else {
		if err := RegisterWorkspace(RegisteredWorkspace{
			ID:             workspaceCfg.WorkspaceID,
			ProjectID:      projectID,
			Name:           workspaceName,
			Path:           workspaceRoot,
			ForkSnapshotID: workspaceCfg.ForkSnapshotID,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			fmt.Printf("Warning: Could not register workspace: %v\n", err)
		}
	}

	parentCfg := &config.ParentConfig{
		ProjectID:   projectID,
		ProjectName: projectName,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveParentConfigAt(parentPath, parentCfg); err != nil {
		return err
	}

	fmt.Println("✓ Project folder initialized")
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  ProjectID: %s\n", projectID)
	fmt.Printf("  Directory: %s\n", parentPath)

	return nil
}

func createParentContainer(parentPath, workspaceRoot, workspaceName string) error {
	if parentPath == workspaceRoot {
		return wrapWithSameNameParent(parentPath, workspaceRoot, workspaceName)
	}
	if _, err := os.Stat(parentPath); err == nil {
		return fmt.Errorf("parent directory already exists: %s", parentPath)
	}
	if err := os.MkdirAll(parentPath, 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}
	return moveWorkspaceIntoParent(parentPath, workspaceRoot, workspaceName)
}

func wrapWithSameNameParent(parentPath, workspaceRoot, workspaceName string) error {
	tempPath := workspaceRoot + ".fsttmp-" + randomSuffix(6)
	if err := os.Rename(workspaceRoot, tempPath); err != nil {
		return fmt.Errorf("failed to move workspace to temp location: %w", err)
	}
	if err := os.MkdirAll(parentPath, 0755); err != nil {
		_ = os.Rename(tempPath, workspaceRoot)
		return fmt.Errorf("failed to create parent directory: %w", err)
	}
	if err := os.Rename(tempPath, filepath.Join(parentPath, workspaceName)); err != nil {
		_ = os.RemoveAll(parentPath)
		_ = os.Rename(tempPath, workspaceRoot)
		return fmt.Errorf("failed to move workspace into parent: %w", err)
	}
	return nil
}

func moveWorkspaceIntoParent(parentPath, workspaceRoot, workspaceName string) error {
	targetDest := filepath.Join(parentPath, workspaceName)
	if _, err := os.Stat(targetDest); err == nil {
		return fmt.Errorf("workspace already exists in parent: %s", targetDest)
	}
	if err := os.Rename(workspaceRoot, targetDest); err != nil {
		return fmt.Errorf("failed to move %s to %s: %w", workspaceRoot, targetDest, err)
	}
	return nil
}
