package commands

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/store"
)

func newExportGitCmd() *cobra.Command {
	var initRepo bool
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export project to Git repository",
		Long: `Export all workspace snapshots to Git commits.

Each workspace becomes a Git branch (named after the workspace).
The Git repository is created at the project root.

This will:
1. Walk the snapshot DAG for each workspace
2. Create Git commits preserving the snapshot history
3. Create one branch per workspace

The mapping is stored in .fst/export/git-map.json to enable incremental exports.
Subsequent exports only create commits for new snapshots.

Examples:
  fst git export                     # Export all workspaces
  fst git export --init              # Initialize git repo if needed
  fst git export --rebuild           # Rebuild all commits from scratch`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runExportGit(initRepo, rebuild)
		},
	}

	cmd.Flags().BoolVar(&initRepo, "init", false, "Initialize git repo if it doesn't exist")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild all commits from scratch (ignores existing mapping)")

	return cmd
}

// GitMapping tracks which snapshots have been exported to which commits
type GitMapping struct {
	RepoPath  string            `json:"repo_path"`
	Snapshots map[string]string `json:"snapshots"` // snapshot_id -> git_commit_sha
}

// LoadGitMapping loads the git export mapping
func LoadGitMapping(configDir string) (*GitMapping, error) {
	path := filepath.Join(configDir, "export", "git-map.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &GitMapping{Snapshots: make(map[string]string)}, nil
		}
		return nil, err
	}

	var mapping GitMapping
	if err := json.Unmarshal(data, &mapping); err != nil {
		return nil, fmt.Errorf("failed to parse git mapping: %w", err)
	}

	if mapping.Snapshots == nil {
		mapping.Snapshots = make(map[string]string)
	}

	return &mapping, nil
}

// SaveGitMapping saves the git export mapping
func SaveGitMapping(configDir string, mapping *GitMapping) error {
	exportDir := filepath.Join(configDir, "export")
	if err := os.MkdirAll(exportDir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(mapping, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(exportDir, "git-map.json"), data, 0644)
}

func runExportGit(initRepo bool, rebuild bool) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	projectRoot, _, err := config.FindParentRootFrom(cwd)
	if err != nil {
		if wsRoot, findErr := config.FindProjectRoot(); findErr == nil {
			projectRoot, _, err = config.FindParentRootFrom(wsRoot)
		}
		if err != nil {
			return fmt.Errorf("not in a project (no fst.json found): %w", err)
		}
	}

	return RunExportGitAt(projectRoot, initRepo, rebuild)
}

// RunExportGitAt exports all workspace snapshots to Git commits at the given project root.
func RunExportGitAt(projectRoot string, initRepo bool, rebuild bool) error {
	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to load project config: %w", err)
	}

	s := store.OpenAt(projectRoot)
	configDir := filepath.Join(projectRoot, ".fst")

	// Check if git repo exists
	gitDir := filepath.Join(projectRoot, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if initRepo {
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(projectRoot, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		} else {
			fmt.Println("No git repository found at project root.")
			fmt.Print("Initialize one? [Y/n] ")
			var response string
			fmt.Scanln(&response)
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "" && response != "y" && response != "yes" {
				return fmt.Errorf("git repository required for export")
			}
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(projectRoot, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		}
	}

	tempDir, err := os.MkdirTemp("", "fst-export-git-")
	if err != nil {
		return fmt.Errorf("failed to create temp export directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := newGitEnv(projectRoot, tempDir, indexPath)
	metaDir := filepath.Join(tempDir, "meta")
	if err := os.MkdirAll(metaDir, 0755); err != nil {
		return fmt.Errorf("failed to create metadata work directory: %w", err)
	}
	metaIndexPath := filepath.Join(tempDir, "meta-index")
	metaGit := newGitEnv(projectRoot, metaDir, metaIndexPath)

	// Load or create mapping
	var mapping *GitMapping
	if rebuild {
		mapping = &GitMapping{RepoPath: projectRoot, Snapshots: make(map[string]string)}
	} else {
		mapping, err = LoadGitMapping(configDir)
		if err != nil {
			return fmt.Errorf("failed to load git mapping: %w", err)
		}
		mapping.RepoPath = projectRoot
	}

	// List all workspaces
	workspaces, err := s.ListWorkspaces()
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}
	if len(workspaces) == 0 {
		return fmt.Errorf("no workspaces found in project")
	}

	totalNewCommits := 0
	exportedWorkspaces := 0

	for _, ws := range workspaces {
		if ws.CurrentSnapshotID == "" {
			fmt.Printf("Skipping workspace '%s' (no snapshots)\n", ws.WorkspaceName)
			continue
		}

		branchName := ws.WorkspaceName
		fmt.Printf("\n--- Workspace: %s (branch: %s) ---\n", ws.WorkspaceName, branchName)

		newCommits, err := exportWorkspaceSnapshots(exportWorkspaceParams{
			store:      s,
			git:        git,
			mapping:    mapping,
			branchName: branchName,
			snapshotID: ws.CurrentSnapshotID,
			wsName:     ws.WorkspaceName,
			rebuild:    rebuild,
		})
		if err != nil {
			// Save mapping so progress from previous workspaces isn't lost
			_ = SaveGitMapping(configDir, mapping)
			return fmt.Errorf("failed to export workspace '%s': %w", ws.WorkspaceName, err)
		}
		totalNewCommits += newCommits
		exportedWorkspaces++

		// Update export metadata for this workspace
		wsCfg := &config.ProjectConfig{
			ProjectID:     parentCfg.ProjectID,
			WorkspaceID:   ws.WorkspaceID,
			WorkspaceName: ws.WorkspaceName,
		}
		if err := updateExportMetadata(metaGit, wsCfg, branchName); err != nil {
			fmt.Printf("Warning: failed to update export metadata for %s: %v\n", ws.WorkspaceName, err)
		}
	}

	// Save mapping
	if err := SaveGitMapping(configDir, mapping); err != nil {
		return fmt.Errorf("failed to save mapping: %w", err)
	}

	fmt.Println()
	if totalNewCommits > 0 {
		fmt.Printf("Exported %d new commits across %d workspaces\n", totalNewCommits, exportedWorkspaces)
	} else {
		fmt.Printf("All %d workspaces up to date\n", exportedWorkspaces)
	}

	return nil
}

type exportWorkspaceParams struct {
	store      *store.Store
	git        gitEnv
	mapping    *GitMapping
	branchName string
	snapshotID string // workspace head
	wsName     string // for display
	rebuild    bool
}

func exportWorkspaceSnapshots(p exportWorkspaceParams) (int, error) {
	if p.rebuild {
		branchExists, err := gitBranchExists(p.git, p.branchName)
		if err != nil {
			return 0, fmt.Errorf("failed to check branch: %w", err)
		}
		if branchExists {
			if err := deleteGitBranchRef(p.git, p.branchName); err != nil {
				return 0, fmt.Errorf("failed to reset branch '%s': %w", p.branchName, err)
			}
		}
	}

	// Build snapshot DAG
	chain, err := buildSnapshotDAG(p.store, p.snapshotID)
	if err != nil {
		return 0, fmt.Errorf("failed to build snapshot chain: %w", err)
	}

	if len(chain) == 0 {
		return 0, fmt.Errorf("no snapshots found")
	}

	fmt.Printf("Found %d snapshots\n", len(chain))

	newCommits := 0
	var lastCommitSHA string

	for _, snap := range chain {
		// Check if already exported
		if existingSHA, ok := p.mapping.Snapshots[snap.ID]; ok && !p.rebuild {
			if gitCommitExists(p.git, existingSHA) {
				fmt.Printf("  %s: already exported (commit %s)\n", snap.ID[:12], existingSHA[:8])
				lastCommitSHA = existingSHA
				continue
			}
			fmt.Printf("  %s: mapped commit missing, re-exporting\n", snap.ID[:12])
		}

		// Load manifest
		m, err := p.store.LoadManifest(snap.ManifestHash)
		if err != nil {
			return 0, fmt.Errorf("failed to load manifest for %s: %w", snap.ID[:12], err)
		}

		// Restore files from blobs to temp working directory
		if err := restoreFilesFromManifest(p.git.workTree, p.store, m); err != nil {
			return 0, fmt.Errorf("failed to restore files for %s: %w", snap.ID[:12], err)
		}

		// Stage all files
		if err := p.git.run("add", "-A"); err != nil {
			return 0, fmt.Errorf("failed to stage files: %w", err)
		}

		// Create commit
		commitMsg := snap.Message
		if commitMsg == "" {
			commitMsg = fmt.Sprintf("Snapshot %s", snap.ID[:12])
		}

		parentSHAs, err := resolveGitParentSHAs(p.git, p.mapping, snap.ParentSnapshotIDs)
		if err != nil {
			return 0, fmt.Errorf("failed to resolve parents for %s: %w", snap.ID[:12], err)
		}
		if len(parentSHAs) == 0 && len(snap.ParentSnapshotIDs) == 1 && lastCommitSHA != "" {
			parentSHAs = []string{lastCommitSHA}
		}

		treeSHA, err := getGitTreeSHA(p.git)
		if err != nil {
			return 0, fmt.Errorf("failed to write tree for %s: %w", snap.ID[:12], err)
		}

		meta := commitMetaFromSnapshot(snap)
		sha, err := createGitCommitWithParents(p.git, treeSHA, commitMsg, parentSHAs, meta)
		if err != nil {
			return 0, fmt.Errorf("failed to create commit for %s: %w", snap.ID[:12], err)
		}
		if err := updateGitBranchRef(p.git, p.branchName, sha); err != nil {
			return 0, fmt.Errorf("failed to update branch ref for %s: %w", snap.ID[:12], err)
		}

		p.mapping.Snapshots[snap.ID] = sha
		lastCommitSHA = sha
		newCommits++
		fmt.Printf("  %s: exported -> %s\n", snap.ID[:12], sha[:8])
	}

	return newCommits, nil
}

// buildSnapshotDAG walks all reachable parents and returns snapshots in parent-before-child order.
func buildSnapshotDAG(s *store.Store, startID string) ([]*store.SnapshotMeta, error) {
	if startID == "" {
		return nil, fmt.Errorf("empty snapshot id")
	}

	if _, err := s.LoadSnapshotMeta(startID); err != nil {
		return nil, fmt.Errorf("snapshot metadata not found for %s", startID)
	}

	state := make(map[string]uint8)
	infoByID := make(map[string]*store.SnapshotMeta)
	var ordered []*store.SnapshotMeta

	var visit func(string) error
	visit = func(id string) error {
		if id == "" {
			return nil
		}
		switch state[id] {
		case 1:
			return fmt.Errorf("cycle detected at snapshot %s", id)
		case 2:
			return nil
		}
		state[id] = 1

		info := infoByID[id]
		if info == nil {
			meta, err := s.LoadSnapshotMeta(id)
			if err != nil {
				if os.IsNotExist(err) {
					fmt.Printf("  warning: snapshot metadata missing for %s (skipping)\n", id)
					state[id] = 2
					return nil
				}
				return err
			}
			info = meta
			infoByID[id] = info
		}

		for _, parent := range info.ParentSnapshotIDs {
			if err := visit(parent); err != nil {
				return err
			}
		}

		state[id] = 2
		ordered = append(ordered, info)
		return nil
	}

	if err := visit(startID); err != nil {
		return nil, err
	}

	return ordered, nil
}

type commitMeta struct {
	AuthorName     string
	AuthorEmail    string
	AuthorDate     string
	CommitterName  string
	CommitterEmail string
	CommitterDate  string
}

type exportMeta struct {
	Version    int                            `json:"version"`
	UpdatedAt  string                         `json:"updated_at,omitempty"`
	ProjectID  string                         `json:"project_id,omitempty"`
	Workspaces map[string]exportWorkspaceMeta `json:"workspaces,omitempty"`
}

type exportWorkspaceMeta struct {
	WorkspaceID   string `json:"workspace_id"`
	WorkspaceName string `json:"workspace_name,omitempty"`
	Branch        string `json:"branch"`
}

func (m *commitMeta) env() map[string]string {
	env := map[string]string{}
	if m.AuthorName != "" {
		env["GIT_AUTHOR_NAME"] = m.AuthorName
	}
	if m.AuthorEmail != "" {
		env["GIT_AUTHOR_EMAIL"] = m.AuthorEmail
	}
	if m.AuthorDate != "" {
		env["GIT_AUTHOR_DATE"] = m.AuthorDate
	}
	if m.CommitterName != "" {
		env["GIT_COMMITTER_NAME"] = m.CommitterName
	}
	if m.CommitterEmail != "" {
		env["GIT_COMMITTER_EMAIL"] = m.CommitterEmail
	}
	if m.CommitterDate != "" {
		env["GIT_COMMITTER_DATE"] = m.CommitterDate
	}
	return env
}

func commitMetaFromSnapshot(snap *store.SnapshotMeta) *commitMeta {
	if snap.CreatedAt == "" && snap.Agent == "" && snap.AuthorName == "" {
		return nil
	}
	meta := &commitMeta{
		AuthorDate:    snap.CreatedAt,
		CommitterDate: snap.CreatedAt,
	}
	if snap.AuthorName != "" {
		meta.AuthorName = snap.AuthorName
		meta.AuthorEmail = snap.AuthorEmail
		meta.CommitterName = snap.AuthorName
		meta.CommitterEmail = snap.AuthorEmail
	} else if snap.Agent != "" {
		email := agentEmail(snap.Agent)
		meta.AuthorName = snap.Agent
		meta.AuthorEmail = email
		meta.CommitterName = snap.Agent
		meta.CommitterEmail = email
	}
	return meta
}

const (
	fstMetaRef  = "refs/fst/meta"
	fstMetaPath = ".fst-export/meta.json"
)

func updateExportMetadata(g gitEnv, cfg *config.ProjectConfig, branchName string) error {
	if cfg == nil || cfg.WorkspaceID == "" {
		return fmt.Errorf("missing workspace id for export metadata")
	}

	meta, err := loadExportMetadata(g)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if meta == nil {
		meta = &exportMeta{Version: 1, Workspaces: make(map[string]exportWorkspaceMeta)}
	}
	if meta.Workspaces == nil {
		meta.Workspaces = make(map[string]exportWorkspaceMeta)
	}

	meta.ProjectID = cfg.ProjectID
	meta.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	meta.Workspaces[cfg.WorkspaceID] = exportWorkspaceMeta{
		WorkspaceID:   cfg.WorkspaceID,
		WorkspaceName: cfg.WorkspaceName,
		Branch:        branchName,
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Join(g.workTree, ".fst-export"), 0755); err != nil {
		return err
	}
	metaPath := filepath.Join(g.workTree, fstMetaPath)
	if err := os.WriteFile(metaPath, data, 0644); err != nil {
		return err
	}

	if err := g.run("add", "-A"); err != nil {
		return err
	}

	treeSHA, err := getGitTreeSHA(g)
	if err != nil {
		return err
	}

	parent, err := gitRefSHA(g, fstMetaRef)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	parents := []string{}
	if parent != "" {
		parents = append(parents, parent)
	}

	metaCommit := &commitMeta{
		AuthorDate:    meta.UpdatedAt,
		CommitterDate: meta.UpdatedAt,
	}
	sha, err := createGitCommitWithParents(g, treeSHA, "FST export metadata", parents, metaCommit)
	if err != nil {
		return err
	}

	return updateGitRef(g, fstMetaRef, sha)
}

func loadExportMetadata(g gitEnv) (*exportMeta, error) {
	data, err := gitShowFileAtRef(g, fstMetaRef, fstMetaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var meta exportMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

func agentEmail(agent string) string {
	if agent == "" {
		return ""
	}
	normalized := strings.ToLower(agent)
	var b strings.Builder
	lastDash := false
	for _, r := range normalized {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "agent"
	}
	return slug + "@fastest.local"
}

// restoreFilesFromManifest restores all files from a manifest using the store's blob cache
func restoreFilesFromManifest(root string, s *store.Store, m *manifest.Manifest) error {
	// First, remove files that shouldn't exist (except .git and .fst)
	shouldExist := make(map[string]bool)
	for _, f := range m.FileEntries() {
		shouldExist[f.Path] = true
	}

	// Walk current files and remove extras
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		relPath, _ := filepath.Rel(root, path)
		relPath = filepath.ToSlash(relPath)

		// Skip .git and .fst
		if strings.HasPrefix(relPath, ".git") || strings.HasPrefix(relPath, ".fst") || relPath == ".fst" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if relPath == "." {
			return nil
		}

		if !info.IsDir() && !shouldExist[relPath] {
			os.Remove(path)
		}

		return nil
	})

	// Now restore files from blobs
	for _, f := range m.FileEntries() {
		content, err := s.ReadBlob(f.Hash)
		if err != nil {
			return fmt.Errorf("blob not found for %s: %w", f.Path, err)
		}

		targetPath := filepath.Join(root, f.Path)
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}

		if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}

	return nil
}

// Git helper functions

func runGitCommand(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return nil
}

type gitEnv struct {
	repoRoot  string
	workTree  string
	indexFile string
}

func newGitEnv(repoRoot, workTree, indexFile string) gitEnv {
	return gitEnv{
		repoRoot:  repoRoot,
		workTree:  workTree,
		indexFile: indexFile,
	}
}

func (g gitEnv) gitDir() string {
	return filepath.Join(g.repoRoot, ".git")
}

func (g gitEnv) commandWithEnv(extra map[string]string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = g.workTree
	cmd.Env = append(os.Environ(),
		"GIT_DIR="+g.gitDir(),
		"GIT_WORK_TREE="+g.workTree,
		"GIT_INDEX_FILE="+g.indexFile,
	)
	for key, value := range extra {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

func (g gitEnv) command(args ...string) *exec.Cmd {
	return g.commandWithEnv(nil, args...)
}

func (g gitEnv) run(args ...string) error {
	cmd := g.command(args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return nil
}

func (g gitEnv) output(args ...string) (string, error) {
	return g.outputWithEnv(nil, args...)
}

func (g gitEnv) outputWithEnv(extra map[string]string, args ...string) (string, error) {
	cmd := g.commandWithEnv(extra, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return strings.TrimSpace(string(output)), nil
}

func gitCommitExists(g gitEnv, sha string) bool {
	err := g.run("cat-file", "-t", sha)
	return err == nil
}

func gitBranchExists(g gitEnv, branch string) (bool, error) {
	cmd := g.command("show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	if err := cmd.Run(); err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

func gitRefSHA(g gitEnv, ref string) (string, error) {
	cmd := g.command("show-ref", "--verify", "--hash", ref)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return "", os.ErrNotExist
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("git show-ref --verify --hash %s: %s", ref, message)
	}
	return strings.TrimSpace(string(output)), nil
}

func getGitCurrentBranch(g gitEnv) (string, error) {
	return g.output("rev-parse", "--abbrev-ref", "HEAD")
}

func getGitTreeSHA(g gitEnv) (string, error) {
	return g.output("write-tree")
}

func getGitCommitTreeSHA(g gitEnv, sha string) (string, error) {
	return g.output("rev-parse", sha+"^{tree}")
}

func gitShowFileAtRef(g gitEnv, ref, path string) ([]byte, error) {
	content, err := g.output("show", ref+":"+path)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "Path") || strings.Contains(msg, "not a valid object name") || strings.Contains(msg, "invalid object name") || strings.Contains(msg, "unknown revision") || strings.Contains(msg, "bad object") {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	return []byte(content), nil
}

func createGitCommitWithParents(g gitEnv, treeSHA, message string, parents []string, meta *commitMeta) (string, error) {
	args := []string{"commit-tree", treeSHA, "-m", message}
	for _, p := range parents {
		args = append(args, "-p", p)
	}
	env := map[string]string{}
	if meta != nil {
		for key, value := range meta.env() {
			if value != "" {
				env[key] = value
			}
		}
	}
	return g.outputWithEnv(env, args...)
}

func updateGitBranchRef(g gitEnv, branch, sha string) error {
	return updateGitRef(g, "refs/heads/"+branch, sha)
}

func updateGitRef(g gitEnv, ref, sha string) error {
	return g.run("update-ref", ref, sha)
}

func deleteGitBranchRef(g gitEnv, branch string) error {
	return deleteGitRef(g, "refs/heads/"+branch)
}

func deleteGitRef(g gitEnv, ref string) error {
	return g.run("update-ref", "-d", ref)
}

func resolveGitParentSHAs(g gitEnv, mapping *GitMapping, parentIDs []string) ([]string, error) {
	if len(parentIDs) == 0 {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(parentIDs))
	parents := make([]string, 0, len(parentIDs))
	for _, id := range parentIDs {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		sha, ok := mapping.Snapshots[id]
		if !ok {
			fmt.Printf("  warning: parent snapshot %s not exported (skipping)\n", id)
			continue
		}
		if !gitCommitExists(g, sha) {
			fmt.Printf("  warning: parent commit missing for snapshot %s (skipping)\n", id)
			continue
		}
		parents = append(parents, sha)
	}
	return parents, nil
}
