package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitstore"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func newImportGitCmd() *cobra.Command {
	var projectName string
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "import <repo-path>",
		Short: "Import from a Git repository exported by fst",
		Long: `Import all workspace branches from a Git repository into a project.

Each branch in the export metadata becomes a workspace.
If no project exists, a new one is created.

The repository must contain fst export metadata (refs/fst/meta),
which is written by 'fst git export'.

Examples:
  fst git import /path/to/repo              # Import into current or new project
  fst git import /path/to/repo --project my-project  # Create named project
  fst git import /path/to/repo --rebuild    # Overwrite existing snapshots`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runImportGit(args[0], projectName, rebuild)
		},
	}

	cmd.Flags().StringVarP(&projectName, "project", "p", "", "Project name when creating a new project")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild snapshots from scratch (overwrites existing snapshot history)")

	return cmd
}

type importTarget struct {
	WorkspaceID   string
	WorkspaceName string
	Branch        string
	Root          string
	ProjectID     string
	Existing      bool
}

func runImportGit(repoPath, projectName string, rebuild bool) error {
	repoRoot, err := filepath.Abs(repoPath)
	if err != nil {
		return fmt.Errorf("failed to resolve repo path: %w", err)
	}
	if _, err := os.Stat(filepath.Join(repoRoot, ".git")); err != nil {
		return fmt.Errorf("not a git repository: %s", repoRoot)
	}

	tempRepoDir, err := os.MkdirTemp("", "fst-import-git-")
	if err != nil {
		return fmt.Errorf("failed to create temp import directory: %w", err)
	}
	defer os.RemoveAll(tempRepoDir)

	indexPath := filepath.Join(tempRepoDir, "index")
	git := gitutil.NewEnv(repoRoot, tempRepoDir, indexPath)

	meta, err := gitstore.LoadExportMetadata(git)
	if err != nil {
		return fmt.Errorf("failed to load fst export metadata: %w", err)
	}
	if meta == nil || len(meta.Workspaces) == 0 {
		return fmt.Errorf("no fst export metadata found (missing refs/fst/meta)")
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	// Find existing project or create new one
	var parentRoot string
	var parentCfg *config.ProjectConfig

	// Try from workspace root first, then from cwd
	if wsRoot, findErr := config.FindWorkspaceRoot(); findErr == nil {
		parentRoot, parentCfg, _ = config.FindProjectRootFrom(wsRoot)
	}
	if parentCfg == nil {
		if pr, pc, findErr := config.FindProjectRootFrom(cwd); findErr == nil {
			parentRoot = pr
			parentCfg = pc
		}
	}

	if parentCfg != nil {
		// Existing project — validate project ID
		if meta.ProjectID != "" && meta.ProjectID != parentCfg.ProjectID {
			return fmt.Errorf("project ID mismatch: repo %s, current project %s", meta.ProjectID, parentCfg.ProjectID)
		}
	} else {
		// No project found — create one
		if projectName == "" {
			projectName = filepath.Base(repoRoot)
		}
		parentRoot = filepath.Join(cwd, projectName)
		if _, err := os.Stat(parentRoot); err == nil {
			return fmt.Errorf("target project directory already exists: %s", parentRoot)
		}
		projectID := generateProjectID()
		if err := config.SaveProjectConfigAt(parentRoot, &config.ProjectConfig{
			ProjectID:   projectID,
			ProjectName: projectName,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			return fmt.Errorf("failed to create project: %w", err)
		}
		parentCfg = &config.ProjectConfig{ProjectID: projectID, ProjectName: projectName}
	}

	targets, err := buildImportTargets(parentRoot, parentCfg, meta)
	if err != nil {
		return err
	}

	s := store.OpenAt(parentRoot)
	if err := s.EnsureDirs(); err != nil {
		return fmt.Errorf("failed to create store directories: %w", err)
	}

	for _, target := range targets {
		if err := importWorkspaceFromGit(git, s, target, rebuild); err != nil {
			return err
		}
	}
	return nil
}

func buildImportTargets(parentRoot string, parentCfg *config.ProjectConfig, meta *gitstore.ExportMeta) ([]importTarget, error) {
	if parentCfg == nil {
		return nil, fmt.Errorf("missing project configuration")
	}
	var targets []importTarget

	for _, entry := range meta.Workspaces {
		if entry.Branch == "" {
			return nil, fmt.Errorf("export metadata missing branch for workspace")
		}
		name := entry.WorkspaceName
		if name == "" {
			name = entry.Branch
		}
		root := filepath.Join(parentRoot, name)
		existing, cfg, err := existingWorkspaceConfig(root)
		if err != nil {
			return nil, err
		}
		targetID := entry.WorkspaceID
		if existing {
			if entry.WorkspaceID != "" && entry.WorkspaceID != cfg.WorkspaceID {
				return nil, fmt.Errorf("workspace ID mismatch for %s", root)
			}
			targetID = cfg.WorkspaceID
		}
		targets = append(targets, importTarget{
			WorkspaceID:   targetID,
			WorkspaceName: name,
			Branch:        entry.Branch,
			Root:          root,
			ProjectID:     parentCfg.ProjectID,
			Existing:      existing,
		})
	}
	if len(targets) == 0 {
		return nil, fmt.Errorf("no workspaces found in export metadata")
	}
	return targets, nil
}

func existingWorkspaceConfig(root string) (bool, *config.WorkspaceConfig, error) {
	if _, err := os.Stat(root); err != nil {
		if os.IsNotExist(err) {
			return false, nil, nil
		}
		return false, nil, err
	}
	if _, err := os.Stat(filepath.Join(root, ".fst", "config.json")); err != nil {
		return false, nil, fmt.Errorf("directory exists but is not a workspace: %s", root)
	}
	cfg, err := config.LoadAt(root)
	if err != nil {
		return false, nil, err
	}
	return true, cfg, nil
}

func importWorkspaceFromGit(git gitutil.Env, s *store.Store, target importTarget, rebuild bool) error {
	targetRoot := target.Root
	if targetRoot == "" {
		return fmt.Errorf("missing workspace path")
	}
	if target.ProjectID == "" {
		return fmt.Errorf("missing project ID for workspace import")
	}

	if target.Existing {
		if _, err := os.Stat(filepath.Join(targetRoot, ".fst", "config.json")); err != nil {
			return fmt.Errorf("workspace config missing at %s", targetRoot)
		}
	} else {
		if _, err := os.Stat(targetRoot); err == nil {
			return fmt.Errorf("target workspace directory already exists: %s", targetRoot)
		}
		if err := os.MkdirAll(targetRoot, 0755); err != nil {
			return fmt.Errorf("failed to create workspace directory: %w", err)
		}
		workspaceID := target.WorkspaceID
		if workspaceID == "" {
			workspaceID = generateWorkspaceID()
		}
		if err := config.InitAt(targetRoot, target.ProjectID, workspaceID, target.WorkspaceName, ""); err != nil {
			return fmt.Errorf("failed to initialize workspace: %w", err)
		}
		target.WorkspaceID = workspaceID
	}

	cfg, err := config.LoadAt(targetRoot)
	if err != nil {
		return fmt.Errorf("failed to load workspace config: %w", err)
	}
	if target.WorkspaceID != "" && cfg.WorkspaceID != target.WorkspaceID {
		return fmt.Errorf("workspace ID mismatch for %s", targetRoot)
	}
	if cfg.ProjectID != "" && cfg.ProjectID != target.ProjectID {
		return fmt.Errorf("project ID mismatch for %s", targetRoot)
	}
	if cfg.WorkspaceName == "" && target.WorkspaceName != "" {
		cfg.WorkspaceName = target.WorkspaceName
	}

	if cfg.CurrentSnapshotID != "" && !rebuild {
		return fmt.Errorf("workspace %s already has snapshots (use --rebuild to overwrite)", cfg.WorkspaceName)
	}

	if rebuild {
		cfg.CurrentSnapshotID = ""
		cfg.BaseSnapshotID = ""
	}

	tempWorkDir, err := os.MkdirTemp("", "fst-import-worktree-")
	if err != nil {
		return fmt.Errorf("failed to create temp worktree: %w", err)
	}
	defer os.RemoveAll(tempWorkDir)

	tempIndexDir, err := os.MkdirTemp("", "fst-import-index-")
	if err != nil {
		return fmt.Errorf("failed to create temp index dir: %w", err)
	}
	defer os.RemoveAll(tempIndexDir)

	importIndex := filepath.Join(tempIndexDir, "index")
	importGit := gitutil.NewEnv(git.RepoRoot, tempWorkDir, importIndex)

	commits, err := gitutil.RevList(importGit, target.Branch)
	if err != nil {
		return err
	}
	if len(commits) == 0 {
		return fmt.Errorf("no commits found for branch %s", target.Branch)
	}

	fmt.Printf("\n--- Workspace: %s (branch: %s) ---\n", target.WorkspaceName, target.Branch)
	fmt.Printf("Found %d commits\n", len(commits))

	commitToSnapshot := make(map[string]string, len(commits))
	var firstSnapshot string
	var lastSnapshot string

	for _, commit := range commits {
		info, err := gitutil.ReadCommitInfo(importGit, commit)
		if err != nil {
			return err
		}
		if err := gitutil.CheckoutTree(importGit, commit); err != nil {
			return err
		}

		parentSnapshots := make([]string, 0, len(info.Parents))
		for _, parent := range info.Parents {
			snapID, ok := commitToSnapshot[parent]
			if !ok {
				return fmt.Errorf("parent commit %s not imported for %s", parent, commit)
			}
			parentSnapshots = append(parentSnapshots, snapID)
		}

		agentName := ""
		if strings.HasSuffix(strings.ToLower(info.AuthorEmail), "@fastest.local") {
			agentName = info.AuthorName
		}

		snapshotID, err := gitstore.CreateImportedSnapshot(s, tempWorkDir, cfg, parentSnapshots, info.Subject, info.AuthorDate, info.AuthorName, info.AuthorEmail, agentName)
		if err != nil {
			return err
		}
		commitToSnapshot[commit] = snapshotID
		if firstSnapshot == "" {
			firstSnapshot = snapshotID
		}
		lastSnapshot = snapshotID
	}

	cfg.CurrentSnapshotID = lastSnapshot
	if cfg.BaseSnapshotID == "" || rebuild {
		cfg.BaseSnapshotID = firstSnapshot
	}
	if err := config.SaveAt(targetRoot, cfg); err != nil {
		return fmt.Errorf("failed to save workspace config: %w", err)
	}

	// Register in project-level registry
	if regErr := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       cfg.WorkspaceID,
		WorkspaceName:     cfg.WorkspaceName,
		Path:              targetRoot,
		CurrentSnapshotID: lastSnapshot,
		BaseSnapshotID:    cfg.BaseSnapshotID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}); regErr != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", regErr)
	}

	fmt.Printf("Imported %d commits into workspace '%s'\n", len(commits), cfg.WorkspaceName)
	return nil
}

