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
)

func newExportGitCmd() *cobra.Command {
	var branchName string
	var includeDirty bool
	var message string
	var initRepo bool
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export to Git repository",
		Long: `Export workspace snapshots to Git commits.

	This will:
1. Map each snapshot in the chain to a Git commit
2. Create/update a branch for the current workspace
3. Optionally include uncommitted changes

The mapping is stored in .fst/export/git-map.json to enable incremental exports.
Subsequent exports only create commits for new snapshots.

Examples:
  fst git export                     # Export to current branch
  fst git export --branch feature    # Export to specific branch
  fst git export --include-dirty     # Include uncommitted changes
  fst git export --init              # Initialize git repo if needed`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runExportGit(branchName, includeDirty, message, initRepo, rebuild)
		},
	}

	cmd.Flags().StringVarP(&branchName, "branch", "b", "", "Branch name (default: workspace name)")
	cmd.Flags().BoolVar(&includeDirty, "include-dirty", false, "Include uncommitted changes as a commit")
	cmd.Flags().StringVarP(&message, "message", "m", "", "Commit message for dirty export (requires --include-dirty)")
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

func runExportGit(branchName string, includeDrift bool, message string, initRepo bool, rebuild bool) error {
	// Load config
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory: %w", err)
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	configDir, err := config.GetConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config dir: %w", err)
	}

	// Default branch name to workspace name
	if branchName == "" {
		branchName = cfg.WorkspaceName
	}

	// Check if git repo exists
	gitDir := filepath.Join(root, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if initRepo {
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(root, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		} else {
			fmt.Println("No git repository found.")
			fmt.Print("Initialize one? [Y/n] ")
			var response string
			fmt.Scanln(&response)
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "" && response != "y" && response != "yes" {
				return fmt.Errorf("git repository required for export")
			}
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(root, "init"); err != nil {
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
	git := newGitEnv(root, tempDir, indexPath)
	metaDir := filepath.Join(tempDir, "meta")
	metaIndexPath := filepath.Join(tempDir, "meta-index")
	metaGit := newGitEnv(root, metaDir, metaIndexPath)

	// Load or create mapping
	var mapping *GitMapping
	if rebuild {
		mapping = &GitMapping{RepoPath: root, Snapshots: make(map[string]string)}
	} else {
		mapping, err = LoadGitMapping(configDir)
		if err != nil {
			return fmt.Errorf("failed to load git mapping: %w", err)
		}
		mapping.RepoPath = root
	}

	if rebuild {
		branchExists, err := gitBranchExists(git, branchName)
		if err != nil {
			return fmt.Errorf("failed to check branch: %w", err)
		}
		if branchExists {
			if err := deleteGitBranchRef(git, branchName); err != nil {
				return fmt.Errorf("failed to reset branch '%s': %w", branchName, err)
			}
		}
	}

	// Check if we have a current snapshot
	if cfg.CurrentSnapshotID == "" {
		return fmt.Errorf("no snapshots to export - create one with 'fst snapshot'")
	}

	// Build snapshot chain (walk back through parents)
	chain, err := buildSnapshotDAG(configDir, cfg.CurrentSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to build snapshot chain: %w", err)
	}

	if len(chain) == 0 {
		return fmt.Errorf("no snapshots found")
	}

	fmt.Printf("Found %d snapshots to export\n", len(chain))

	currentBranch, err := getGitCurrentBranch(git)
	if err == nil && currentBranch == branchName {
		fmt.Printf("Note: branch '%s' is currently checked out; export will not update your working tree.\n", branchName)
	}

	// Export each snapshot in chain (oldest first)
	newCommits := 0
	var lastCommitSHA string

	for _, snap := range chain {
		// Check if already exported
		if existingSHA, ok := mapping.Snapshots[snap.ID]; ok && !rebuild {
			// Verify commit still exists
			if gitCommitExists(git, existingSHA) {
				fmt.Printf("  %s: already exported (commit %s)\n", snap.ID, existingSHA[:8])
				lastCommitSHA = existingSHA
				continue
			}
			fmt.Printf("  %s: mapped commit missing, re-exporting\n", snap.ID)
		}

		// Load snapshot data
		manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, snap.ID)
		if err != nil {
			return fmt.Errorf("invalid snapshot id %s: %w", snap.ID, err)
		}
		manifestPath := filepath.Join(configDir, config.ManifestsDirName, manifestHash+".json")
		manifestData, err := os.ReadFile(manifestPath)
		if err != nil {
			return fmt.Errorf("failed to load snapshot %s: %w", snap.ID, err)
		}

		m, err := manifest.FromJSON(manifestData)
		if err != nil {
			return fmt.Errorf("failed to parse snapshot %s: %w", snap.ID, err)
		}

		// Restore files from blobs to working directory
		if err := restoreFilesFromManifest(tempDir, configDir, m); err != nil {
			return fmt.Errorf("failed to restore files for %s: %w", snap.ID, err)
		}

		// Stage all files
		if err := git.run("add", "-A"); err != nil {
			return fmt.Errorf("failed to stage files: %w", err)
		}

		// Create commit
		commitMsg := snap.Message
		if commitMsg == "" {
			commitMsg = fmt.Sprintf("Snapshot %s", snap.ID)
		}

		parentSHAs, err := resolveGitParentSHAs(git, mapping, snap.ParentIDs)
		if err != nil {
			return fmt.Errorf("failed to resolve parents for %s: %w", snap.ID, err)
		}
		if len(parentSHAs) == 0 && len(snap.ParentIDs) == 1 && lastCommitSHA != "" {
			parentSHAs = []string{lastCommitSHA}
		}

		treeSHA, err := getGitTreeSHA(git)
		if err != nil {
			return fmt.Errorf("failed to write tree for %s: %w", snap.ID, err)
		}

		meta := commitMetaFromSnapshot(snap)
		sha, err := createGitCommitWithParents(git, treeSHA, commitMsg, parentSHAs, meta)
		if err != nil {
			return fmt.Errorf("failed to create commit for %s: %w", snap.ID, err)
		}
		if err := updateGitBranchRef(git, branchName, sha); err != nil {
			return fmt.Errorf("failed to update branch ref for %s: %w", snap.ID, err)
		}

		mapping.Snapshots[snap.ID] = sha
		lastCommitSHA = sha
		newCommits++
		fmt.Printf("  %s: exported → %s\n", snap.ID, sha[:8])
	}

	// Handle drift if requested
	if includeDrift {
		if err := syncWorkingTree(root, tempDir); err != nil {
			return fmt.Errorf("failed to prepare drift export: %w", err)
		}

		// Stage current changes
		if err := git.run("add", "-A"); err != nil {
			return fmt.Errorf("failed to stage drift: %w", err)
		}

		treeSHA, err := getGitTreeSHA(git)
		if err != nil {
			return fmt.Errorf("failed to write drift tree: %w", err)
		}

		driftChanged := true
		if lastCommitSHA != "" {
			parentTree, err := getGitCommitTreeSHA(git, lastCommitSHA)
			if err == nil && parentTree == treeSHA {
				driftChanged = false
			}
		}

		if driftChanged {
			driftMsg := message
			if driftMsg == "" {
				driftMsg = "WIP: uncommitted changes"
			}

			parents := []string{}
			if lastCommitSHA != "" {
				parents = []string{lastCommitSHA}
			}
			sha, err := createGitCommitWithParents(git, treeSHA, driftMsg, parents, nil)
			if err != nil {
				return fmt.Errorf("failed to commit drift: %w", err)
			}
			if err := updateGitBranchRef(git, branchName, sha); err != nil {
				return fmt.Errorf("failed to update branch ref for drift: %w", err)
			}
			fmt.Printf("  drift: exported → %s\n", sha[:8])
			newCommits++
			lastCommitSHA = sha
		} else {
			fmt.Println("  No uncommitted changes to export")
		}
	}

	// Save mapping
	if err := SaveGitMapping(configDir, mapping); err != nil {
		return fmt.Errorf("failed to save mapping: %w", err)
	}

	if err := updateExportMetadata(metaGit, cfg, branchName); err != nil {
		fmt.Printf("Warning: failed to update export metadata: %v\n", err)
	}

	fmt.Println()
	if newCommits > 0 {
		fmt.Printf("✓ Exported %d new commits to branch '%s'\n", newCommits, branchName)
	} else {
		fmt.Printf("✓ Branch '%s' is up to date\n", branchName)
	}

	// Show current state
	if !includeDrift {
		// Check for drift
		currentManifest, err := manifest.Generate(root, false)
		if err == nil {
			baseManifestHash, err := config.ManifestHashFromSnapshotIDAt(root, cfg.BaseSnapshotID)
			if err == nil {
				baseManifestPath := filepath.Join(configDir, config.ManifestsDirName, baseManifestHash+".json")
				if baseData, err := os.ReadFile(baseManifestPath); err == nil {
					if baseManifest, err := manifest.FromJSON(baseData); err == nil {
						added, modified, deleted := manifest.Diff(baseManifest, currentManifest)
						if len(added)+len(modified)+len(deleted) > 0 {
							fmt.Printf("\nNote: %d uncommitted changes not exported.\n", len(added)+len(modified)+len(deleted))
							fmt.Println("Use --include-dirty to include them.")
						}
					}
				}
			}
		}
	}

	return nil
}

// SnapshotInfo contains basic snapshot metadata
type SnapshotInfo struct {
	ID        string
	ParentIDs []string
	Message   string
	CreatedAt string
	Agent     string
}

// buildSnapshotDAG walks all reachable parents and returns snapshots in parent-before-child order.
func buildSnapshotDAG(configDir, startID string) ([]SnapshotInfo, error) {
	if startID == "" {
		return nil, fmt.Errorf("empty snapshot id")
	}

	loadMeta := func(snapshotID string) (*SnapshotInfo, error) {
		metaPath := filepath.Join(configDir, config.SnapshotsDirName, snapshotID+".meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			return nil, err
		}

		var meta struct {
			ID                string   `json:"id"`
			ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
			Message           string   `json:"message"`
			CreatedAt         string   `json:"created_at"`
			Agent             string   `json:"agent"`
		}
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil, err
		}

		return &SnapshotInfo{
			ID:        meta.ID,
			ParentIDs: meta.ParentSnapshotIDs,
			Message:   meta.Message,
			CreatedAt: meta.CreatedAt,
			Agent:     meta.Agent,
		}, nil
	}

	if _, err := loadMeta(startID); err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("snapshot metadata not found for %s", startID)
		}
		return nil, err
	}

	state := make(map[string]uint8)
	infoByID := make(map[string]*SnapshotInfo)
	var ordered []SnapshotInfo

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
			meta, err := loadMeta(id)
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

		for _, parent := range info.ParentIDs {
			if err := visit(parent); err != nil {
				return err
			}
		}

		state[id] = 2
		ordered = append(ordered, *info)
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

func commitMetaFromSnapshot(s SnapshotInfo) *commitMeta {
	if s.CreatedAt == "" && s.Agent == "" {
		return nil
	}
	meta := &commitMeta{
		AuthorDate:    s.CreatedAt,
		CommitterDate: s.CreatedAt,
	}
	if s.Agent != "" {
		email := agentEmail(s.Agent)
		meta.AuthorName = s.Agent
		meta.AuthorEmail = email
		meta.CommitterName = s.Agent
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

// restoreFilesFromManifest restores all files from a manifest using cached blobs
func restoreFilesFromManifest(root, configDir string, m *manifest.Manifest) error {
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return err
	}

	// First, remove files that shouldn't exist (except .git and .fst)
	// We'll do this by tracking what should exist
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
		blobPath := filepath.Join(blobDir, f.Hash)
		targetPath := filepath.Join(root, f.Path)

		content, err := os.ReadFile(blobPath)
		if err != nil {
			return fmt.Errorf("blob not found for %s: %w", f.Path, err)
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}

		if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}

	return nil
}

// syncWorkingTree mirrors the current workspace files into the export directory.
func syncWorkingTree(srcRoot, destRoot string) error {
	shouldExist := make(map[string]bool)
	err := filepath.Walk(srcRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		relPath, _ := filepath.Rel(srcRoot, path)
		relPath = filepath.ToSlash(relPath)

		if relPath == "." {
			return nil
		}

		if strings.HasPrefix(relPath, ".git") || strings.HasPrefix(relPath, ".fst") || relPath == ".fst" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.IsDir() {
			return nil
		}

		shouldExist[relPath] = true
		targetPath := filepath.Join(destRoot, relPath)
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, content, info.Mode().Perm()); err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}

	return filepath.Walk(destRoot, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		relPath, _ := filepath.Rel(destRoot, path)
		relPath = filepath.ToSlash(relPath)

		if relPath == "." {
			return nil
		}

		if strings.HasPrefix(relPath, ".git") || strings.HasPrefix(relPath, ".fst") || relPath == ".fst" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.IsDir() {
			return nil
		}

		if !shouldExist[relPath] {
			_ = os.Remove(path)
		}

		return nil
	})
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
