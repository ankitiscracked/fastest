package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func newImportGitCmd() *cobra.Command {
	var branchName string
	var workspaceName string
	var projectName string
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "import <repo-path>",
		Short: "Import from a Git repository exported by fst",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runImportGit(args[0], branchName, workspaceName, projectName, rebuild)
		},
	}

	cmd.Flags().StringVarP(&branchName, "branch", "b", "", "Branch name to import (default: from export metadata)")
	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Target workspace name (default: from export metadata)")
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

func runImportGit(repoPath, branchName, workspaceName, projectName string, rebuild bool) error {
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
	git := newGitEnv(repoRoot, tempRepoDir, indexPath)

	meta, err := loadExportMetadata(git)
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

	var mode string
	var workspaceRoot string
	var parentRoot string
	var parentCfg *config.ParentConfig

	if root, err := config.FindProjectRoot(); err == nil {
		mode = "workspace"
		workspaceRoot = root
		parentRoot, parentCfg, _ = config.FindParentRootFrom(root)
	} else if pr, pc, err := config.FindParentRootFrom(cwd); err == nil {
		mode = "project"
		parentRoot = pr
		parentCfg = pc
		if cwd != parentRoot {
			return fmt.Errorf("run import from the project root (%s) or inside a workspace", parentRoot)
		}
	} else {
		mode = "none"
	}

	if parentCfg != nil && meta.ProjectID != "" && meta.ProjectID != parentCfg.ProjectID {
		return fmt.Errorf("project ID mismatch: repo %s, current project %s", meta.ProjectID, parentCfg.ProjectID)
	}

	if mode == "workspace" {
		cfg, err := config.LoadAt(workspaceRoot)
		if err != nil {
			return fmt.Errorf("failed to load workspace config: %w", err)
		}
		if workspaceName != "" && workspaceName != cfg.WorkspaceName {
			return fmt.Errorf("workspace flag must match current workspace (%s)", cfg.WorkspaceName)
		}
		if meta.ProjectID != "" && meta.ProjectID != cfg.ProjectID {
			return fmt.Errorf("project ID mismatch: repo %s, workspace %s", meta.ProjectID, cfg.ProjectID)
		}

		if branchName != "" && !exportMetaHasBranch(meta, branchName) {
			return fmt.Errorf("branch '%s' not found in export metadata", branchName)
		}

		targetBranch := branchName
		if targetBranch == "" {
			if entry, ok := meta.Workspaces[cfg.WorkspaceID]; ok {
				targetBranch = entry.Branch
			} else if len(meta.Workspaces) == 1 {
				for _, entry := range meta.Workspaces {
					targetBranch = entry.Branch
				}
			}
		}
		if targetBranch == "" {
			return fmt.Errorf("branch is required when importing into this workspace")
		}

		target := importTarget{
			WorkspaceID:   cfg.WorkspaceID,
			WorkspaceName: cfg.WorkspaceName,
			Branch:        targetBranch,
			Root:          workspaceRoot,
			ProjectID:     cfg.ProjectID,
			Existing:      true,
		}
		return importTargets(git, []importTarget{target}, rebuild)
	}

	if mode == "none" {
		if projectName == "" {
			projectName = filepath.Base(repoRoot)
		}
		parentRoot = filepath.Join(cwd, projectName)
		if _, err := os.Stat(parentRoot); err == nil {
			return fmt.Errorf("target project directory already exists: %s", parentRoot)
		}
		projectID := generateProjectID()
		if err := config.SaveParentConfigAt(parentRoot, &config.ParentConfig{
			ProjectID:   projectID,
			ProjectName: projectName,
			CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			return fmt.Errorf("failed to create project: %w", err)
		}
		parentCfg = &config.ParentConfig{ProjectID: projectID, ProjectName: projectName}
		mode = "project"
	}

	targets, err := buildProjectTargets(parentRoot, parentCfg, meta, branchName, workspaceName)
	if err != nil {
		return err
	}
	return importTargets(git, targets, rebuild)
}

func buildProjectTargets(parentRoot string, parentCfg *config.ParentConfig, meta *exportMeta, branchName, workspaceName string) ([]importTarget, error) {
	if parentCfg == nil {
		return nil, fmt.Errorf("missing project configuration")
	}
	var targets []importTarget

	if branchName != "" || workspaceName != "" {
		entry, err := findExportWorkspace(meta, branchName, workspaceName)
		if err != nil {
			return nil, err
		}
		if entry.Branch == "" {
			return nil, fmt.Errorf("export metadata missing branch for workspace")
		}
		name := workspaceName
		if name == "" {
			if entry.WorkspaceName != "" {
				name = entry.WorkspaceName
			} else {
				name = entry.Branch
			}
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
		return targets, nil
	}

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

func findExportWorkspace(meta *exportMeta, branchName, workspaceName string) (exportWorkspaceMeta, error) {
	var match exportWorkspaceMeta
	found := false
	for _, entry := range meta.Workspaces {
		if branchName != "" && entry.Branch != branchName {
			continue
		}
		if workspaceName != "" {
			if entry.WorkspaceName != "" && entry.WorkspaceName != workspaceName {
				continue
			}
			if entry.WorkspaceName == "" && entry.WorkspaceID != workspaceName {
				continue
			}
		}
		if found {
			return exportWorkspaceMeta{}, fmt.Errorf("multiple export workspaces match; specify --branch")
		}
		match = entry
		found = true
	}
	if !found {
		if branchName != "" {
			return exportWorkspaceMeta{}, fmt.Errorf("branch '%s' not found in export metadata", branchName)
		}
		return exportWorkspaceMeta{}, fmt.Errorf("workspace not found in export metadata")
	}
	if match.Branch == "" {
		return exportWorkspaceMeta{}, fmt.Errorf("export metadata missing branch for workspace")
	}
	return match, nil
}

func importTargets(git gitEnv, targets []importTarget, rebuild bool) error {
	for _, target := range targets {
		if err := importWorkspaceFromGit(git, target, rebuild); err != nil {
			return err
		}
	}
	return nil
}

func exportMetaHasBranch(meta *exportMeta, branch string) bool {
	for _, entry := range meta.Workspaces {
		if entry.Branch == branch {
			return true
		}
	}
	return false
}

func existingWorkspaceConfig(root string) (bool, *config.ProjectConfig, error) {
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

func importWorkspaceFromGit(git gitEnv, target importTarget, rebuild bool) error {
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

	if hasSnapshots, err := workspaceHasSnapshots(targetRoot); err != nil {
		return err
	} else if hasSnapshots && !rebuild {
		return fmt.Errorf("workspace %s already has snapshots (use --rebuild to overwrite)", cfg.WorkspaceName)
	}

	if rebuild {
		if err := resetWorkspaceSnapshots(targetRoot, cfg); err != nil {
			return err
		}
	}

	tempWorkDir, err := os.MkdirTemp("", "fst-import-worktree-")
	if err != nil {
		return fmt.Errorf("failed to create temp worktree: %w", err)
	}
	defer os.RemoveAll(tempWorkDir)

	importIndex := filepath.Join(tempWorkDir, "index")
	importGit := newGitEnv(git.repoRoot, tempWorkDir, importIndex)

	commits, err := gitRevList(importGit, target.Branch)
	if err != nil {
		return err
	}
	if len(commits) == 0 {
		return fmt.Errorf("no commits found for branch %s", target.Branch)
	}

	commitToSnapshot := make(map[string]string, len(commits))
	var firstSnapshot string
	var lastSnapshot string

	for _, commit := range commits {
		info, err := readGitCommitInfo(importGit, commit)
		if err != nil {
			return err
		}
		if err := gitCheckoutTree(importGit, commit); err != nil {
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

		snapshotID, err := createImportedSnapshot(targetRoot, tempWorkDir, cfg, parentSnapshots, info.Subject, info.AuthorDate, agentName)
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
	if cfg.ForkSnapshotID == "" || rebuild {
		cfg.ForkSnapshotID = firstSnapshot
	}
	if err := config.SaveAt(targetRoot, cfg); err != nil {
		return fmt.Errorf("failed to save workspace config: %w", err)
	}

	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             cfg.WorkspaceID,
		ProjectID:      cfg.ProjectID,
		Name:           cfg.WorkspaceName,
		Path:           targetRoot,
		ForkSnapshotID: cfg.ForkSnapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	fmt.Printf("✓ Imported branch '%s' into workspace '%s'\n", target.Branch, cfg.WorkspaceName)
	return nil
}

func workspaceHasSnapshots(root string) (bool, error) {
	latest, err := config.GetLatestSnapshotIDAt(root)
	if err != nil {
		return false, err
	}
	return latest != "", nil
}

func resetWorkspaceSnapshots(root string, cfg *config.ProjectConfig) error {
	if err := os.RemoveAll(config.GetSnapshotsDirAt(root)); err != nil {
		return fmt.Errorf("failed to reset snapshots: %w", err)
	}
	if err := os.RemoveAll(config.GetManifestsDirAt(root)); err != nil {
		return fmt.Errorf("failed to reset manifests: %w", err)
	}
	if err := os.MkdirAll(config.GetSnapshotsDirAt(root), 0755); err != nil {
		return fmt.Errorf("failed to create snapshots dir: %w", err)
	}
	if err := os.MkdirAll(config.GetManifestsDirAt(root), 0755); err != nil {
		return fmt.Errorf("failed to create manifests dir: %w", err)
	}
	cfg.CurrentSnapshotID = ""
	cfg.ForkSnapshotID = ""
	return config.ClearPendingMergeParentsAt(root)
}

type gitCommitInfo struct {
	Parents     []string
	Subject     string
	AuthorName  string
	AuthorEmail string
	AuthorDate  string
}

func gitRevList(g gitEnv, ref string) ([]string, error) {
	out, err := g.output("rev-list", "--topo-order", "--reverse", ref)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	lines := strings.Split(out, "\n")
	return lines, nil
}

func readGitCommitInfo(g gitEnv, sha string) (gitCommitInfo, error) {
	format := "%H%n%P%n%an%n%ae%n%ad%n%s"
	out, err := g.output("show", "-s", "--format="+format, "--date=iso-strict", sha)
	if err != nil {
		return gitCommitInfo{}, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 6 {
		return gitCommitInfo{}, fmt.Errorf("unexpected commit info for %s", sha)
	}
	parents := []string{}
	if strings.TrimSpace(lines[1]) != "" {
		parents = strings.Split(strings.TrimSpace(lines[1]), " ")
	}
	return gitCommitInfo{
		Parents:     parents,
		AuthorName:  lines[2],
		AuthorEmail: lines[3],
		AuthorDate:  lines[4],
		Subject:     lines[5],
	}, nil
}

func gitCheckoutTree(g gitEnv, commit string) error {
	if err := g.run("clean", "-fdx"); err != nil {
		return err
	}
	return g.run("checkout", "-f", commit, "--", ".")
}

func createImportedSnapshot(targetRoot, sourceRoot string, cfg *config.ProjectConfig, parents []string, message, createdAt, agentName string) (string, error) {
	if message == "" {
		message = "Imported commit"
	}

	m, err := manifest.Generate(sourceRoot, false)
	if err != nil {
		return "", fmt.Errorf("failed to scan files: %w", err)
	}

	manifestHash, err := m.Hash()
	if err != nil {
		return "", fmt.Errorf("failed to hash manifest: %w", err)
	}

	snapshotID := generateSnapshotID()

	manifestJSON, err := m.ToJSON()
	if err != nil {
		return "", fmt.Errorf("failed to serialize manifest: %w", err)
	}

	manifestsDir := config.GetManifestsDirAt(targetRoot)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create manifests directory: %w", err)
	}
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	if _, err := os.Stat(manifestPath); os.IsNotExist(err) {
		if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
			return "", fmt.Errorf("failed to save manifest: %w", err)
		}
	}

	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return "", fmt.Errorf("failed to get blob directory: %w", err)
	}
	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		if _, err := os.Stat(blobPath); err == nil {
			continue
		}
		srcPath := filepath.Join(sourceRoot, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			continue
		}
		_ = os.WriteFile(blobPath, content, 0644)
	}

	snapshotsDir := config.GetSnapshotsDirAt(targetRoot)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return "", fmt.Errorf("failed to create snapshots directory: %w", err)
	}

	parentIDsJSON, _ := json.Marshal(parents)
	if createdAt == "" {
		createdAt = time.Now().UTC().Format(time.RFC3339)
	}
	metadata := fmt.Sprintf(`{
  "id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_ids": %s,
  "message": "%s",
  "agent": "%s",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, cfg.WorkspaceID, escapeJSON(cfg.WorkspaceName), manifestHash, parentIDsJSON,
		escapeJSON(message), escapeJSON(agentName), createdAt, m.FileCount(), m.TotalSize())

	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
		return "", fmt.Errorf("failed to save snapshot metadata: %w", err)
	}

	return snapshotID, nil
}
