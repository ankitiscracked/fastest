package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/index"
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
	cmd.AddCommand(newProjectCreateCmd())
	return cmd
}

func newParentInitCmd() *cobra.Command {
	var projectID string
	var keepWorkspaceName bool
	var force bool

	cmd := &cobra.Command{
		Use:   "init [project-name]",
		Short: "Initialize a project folder (fst.json)",
		Args:  cobra.RangeArgs(0, 1),
		RunE: func(cmd *cobra.Command, args []string) error {
			projectName := ""
			if len(args) > 0 {
				projectName = args[0]
			}
			return runParentInit(projectName, projectID, keepWorkspaceName, force)
		},
	}

	cmd.Flags().StringVar(&projectID, "project-id", "", "Use an existing project ID")
	cmd.Flags().BoolVar(&keepWorkspaceName, "keep-name", false, "Keep current workspace folder name instead of renaming to main")
	cmd.Flags().BoolVar(&force, "force", false, "Skip safety checks (use with caution)")

	return cmd
}

func newProjectCreateCmd() *cobra.Command {
	var force bool
	var noSnapshot bool
	var targetPath string

	cmd := &cobra.Command{
		Use:   "create <project-name>",
		Short: "Create a new project with a main workspace",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runProjectCreate(args[0], targetPath, noSnapshot, force)
		},
	}

	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Don't create initial snapshot")
	cmd.Flags().BoolVar(&force, "force", false, "Skip safety checks (use with caution)")
	cmd.Flags().StringVar(&targetPath, "path", "", "Parent directory to create the project under")

	return cmd
}

func runParentInit(projectName, projectID string, keepWorkspaceName bool, force bool) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	if parentRoot, _, err := config.FindParentRootFrom(cwd); err == nil {
		if parentRoot == cwd {
			return fmt.Errorf("already in a project folder at %s\nUse 'fst workspace create' to add workspaces", parentRoot)
		}
		return fmt.Errorf("already inside a project folder at %s\nUse 'fst workspace create' to add workspaces", parentRoot)
	} else if err != nil && !errors.Is(err, config.ErrParentNotFound) {
		return err
	}

	var workspaceRoot string
	var workspaceCfg *config.ProjectConfig
	var defaultWorkspaceName string
	if root, err := config.FindProjectRoot(); err == nil {
		workspaceRoot = root
		defaultWorkspaceName = filepath.Base(root)
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
		defaultWorkspaceName = filepath.Base(cwd)
		if projectName == "" {
			projectName = filepath.Base(cwd)
		}
		if projectID == "" {
			projectID = generateProjectID()
		}
	}

	if !force {
		homeDir, _ := os.UserHomeDir()
		if samePath(workspaceRoot, homeDir) {
			return fmt.Errorf("refusing to initialize in home directory\nUse --force to override (not recommended)")
		}
		if workspaceRoot == "/" {
			return fmt.Errorf("refusing to initialize in root directory\nUse --force to override (not recommended)")
		}
	}

	workspaceName := "main"
	if keepWorkspaceName {
		if workspaceCfg != nil && workspaceCfg.WorkspaceName != "" {
			workspaceName = workspaceCfg.WorkspaceName
		} else {
			workspaceName = defaultWorkspaceName
		}
	}

	parentDir := filepath.Dir(workspaceRoot)
	parentPath := filepath.Join(parentDir, projectName)

	originalWorkspaceRoot := workspaceRoot
	if err := createParentContainer(parentPath, workspaceRoot, workspaceName); err != nil {
		return err
	}

	workspaceRoot = filepath.Join(parentPath, workspaceName)

	var workspaceID string
	var baseSnapshotID string
	if workspaceCfg == nil {
		workspaceID = generateWorkspaceID()
		if err := config.InitAt(workspaceRoot, projectID, workspaceID, workspaceName, ""); err != nil {
			return fmt.Errorf("failed to initialize workspace: %w", err)
		}
		snapshotID, err := createInitialSnapshot(workspaceRoot, workspaceID, workspaceName, false)
		if err != nil {
			return err
		}
		baseSnapshotID = snapshotID
	} else {
		workspaceCfg.WorkspaceName = workspaceName
		if err := config.SaveAt(workspaceRoot, workspaceCfg); err != nil {
			return fmt.Errorf("failed to update workspace config: %w", err)
		}
		workspaceID = workspaceCfg.WorkspaceID
		baseSnapshotID = workspaceCfg.BaseSnapshotID
	}

	if err := UpdateWorkspaceRegistry(originalWorkspaceRoot, RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      projectID,
		Name:           workspaceName,
		Path:           workspaceRoot,
		BaseSnapshotID: baseSnapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not update workspace registry: %v\n", err)
	}

	parentCfg := &config.ParentConfig{
		ProjectID:       projectID,
		ProjectName:     projectName,
		CreatedAt:       time.Now().UTC().Format(time.RFC3339),
		BaseSnapshotID:  baseSnapshotID,
		BaseWorkspaceID: workspaceID,
	}
	if err := config.SaveParentConfigAt(parentPath, parentCfg); err != nil {
		return err
	}
	_ = index.UpsertProject(index.ProjectEntry{
		ProjectID:   projectID,
		ProjectName: projectName,
		ProjectPath: parentPath,
		CreatedAt:   parentCfg.CreatedAt,
		LocalOnly:   true,
	})
	_ = index.SetProjectMainWorkspace(projectID, workspaceID)

	fmt.Println("✓ Project folder initialized")
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  ProjectID: %s\n", projectID)
	fmt.Printf("  Directory: %s\n", parentPath)

	return nil
}

func runProjectCreate(projectName, targetPath string, noSnapshot, force bool) error {
	if projectName == "" {
		return fmt.Errorf("project name is required")
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	parentDir := cwd
	if targetPath != "" {
		parentDir = targetPath
	}

	if !force {
		homeDir, _ := os.UserHomeDir()
		if samePath(parentDir, homeDir) {
			return fmt.Errorf("refusing to create in home directory\nUse --force to override (not recommended)")
		}
		if parentDir == "/" {
			return fmt.Errorf("refusing to create in root directory\nUse --force to override (not recommended)")
		}
	}

	projectPath := filepath.Join(parentDir, projectName)
	workspaceName := "main"
	workspacePath := filepath.Join(projectPath, workspaceName)

	if _, err := os.Stat(projectPath); err == nil {
		return fmt.Errorf("project directory already exists: %s", projectPath)
	}

	projectID := generateProjectID()
	workspaceID := generateWorkspaceID()

	if err := os.MkdirAll(workspacePath, 0755); err != nil {
		return fmt.Errorf("failed to create workspace directory: %w", err)
	}

	if err := config.InitAt(workspacePath, projectID, workspaceID, workspaceName, ""); err != nil {
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}

	var snapshotID string
	if !noSnapshot {
		snapshotID, err = createInitialSnapshot(workspacePath, workspaceID, workspaceName, false)
		if err != nil {
			return err
		}
	}

	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      projectID,
		Name:           workspaceName,
		Path:           workspacePath,
		BaseSnapshotID: snapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	parentCfg := &config.ParentConfig{
		ProjectID:   projectID,
		ProjectName: projectName,
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveParentConfigAt(projectPath, parentCfg); err != nil {
		return err
	}

	_ = index.UpsertProject(index.ProjectEntry{
		ProjectID:   projectID,
		ProjectName: projectName,
		ProjectPath: projectPath,
		CreatedAt:   parentCfg.CreatedAt,
		LocalOnly:   true,
	})
	_ = index.SetProjectMainWorkspace(projectID, workspaceID)

	fmt.Println("✓ Project created")
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  ProjectID: %s\n", projectID)
	fmt.Printf("  Directory: %s\n", projectPath)
	fmt.Printf("  Workspace: %s\n", workspaceName)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}

	return nil
}

func samePath(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if a == b {
		return true
	}
	infoA, errA := os.Stat(a)
	infoB, errB := os.Stat(b)
	if errA == nil && errB == nil {
		return os.SameFile(infoA, infoB)
	}
	return false
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
	targetDest := filepath.Join(parentPath, workspaceName)
	if _, err := os.Stat(targetDest); err == nil {
		_ = os.RemoveAll(parentPath)
		_ = os.Rename(tempPath, workspaceRoot)
		return fmt.Errorf("workspace already exists in parent: %s", targetDest)
	}
	if err := os.Rename(tempPath, targetDest); err != nil {
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
