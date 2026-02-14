package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newBackendCmd()) })
}

func newBackendCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "backend",
		Short: "Manage storage backend",
		Long:  "Configure and manage the storage backend for this project.",
	}

	cmd.AddCommand(newBackendSetCmd())
	cmd.AddCommand(newBackendOffCmd())
	cmd.AddCommand(newBackendStatusCmd())
	cmd.AddCommand(newBackendPushCmd())

	return cmd
}

func newBackendSetCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set",
		Short: "Set the storage backend",
	}

	cmd.AddCommand(newBackendSetGitHubCmd())
	cmd.AddCommand(newBackendSetGitCmd())

	return cmd
}

func newBackendSetGitHubCmd() *cobra.Command {
	var createRepo bool
	var privateRepo bool
	var remoteName string
	var forceRemote bool

	cmd := &cobra.Command{
		Use:   "github <owner/repo>",
		Short: "Set GitHub as the storage backend",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runBackendSetGitHub(args[0], createRepo, privateRepo, remoteName, forceRemote)
		},
	}

	cmd.Flags().BoolVar(&createRepo, "create", false, "Create the GitHub repo if it doesn't exist (requires gh)")
	cmd.Flags().BoolVar(&privateRepo, "private", false, "Create repo as private (requires --create)")
	cmd.Flags().StringVar(&remoteName, "remote", "origin", "Remote name to use")
	cmd.Flags().BoolVar(&forceRemote, "force-remote", false, "Overwrite remote URL if it already exists")

	return cmd
}

func newBackendSetGitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "git",
		Short: "Set local git as the storage backend",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runBackendSetGit()
		},
	}

	return cmd
}

func newBackendOffCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "off",
		Short: "Disable the storage backend",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runBackendOff()
		},
	}
}

func newBackendStatusCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "Show current backend configuration",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runBackendStatus()
		},
	}
}

func newBackendPushCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "push",
		Short: "Push local snapshots to the backend",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runBackendPush()
		},
	}
	return cmd
}


// findProjectRootAndParent finds the project root and parent config from cwd.
func findProjectRootAndParent() (string, *config.ParentConfig, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", nil, fmt.Errorf("failed to get current directory: %w", err)
	}
	projectRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err != nil {
		if wsRoot, findErr := config.FindProjectRoot(); findErr == nil {
			projectRoot, parentCfg, err = config.FindParentRootFrom(wsRoot)
		}
		if err != nil {
			return "", nil, fmt.Errorf("not in a project (no fst.json found): %w", err)
		}
	}
	return projectRoot, parentCfg, nil
}

// BackendFromConfig creates a Backend from a BackendConfig.
func BackendFromConfig(cfg *config.BackendConfig) backend.Backend {
	if cfg == nil {
		return nil
	}
	switch cfg.Type {
	case "github":
		remote := cfg.Remote
		if remote == "" {
			remote = "origin"
		}
		return &GitHubBackend{Repo: cfg.Repo, Remote: remote}
	case "git":
		return &GitBackend{}
	default:
		return nil
	}
}

// GitBackend exports snapshots to a local git repository.
type GitBackend struct{}

func (b *GitBackend) Type() string { return "git" }

func (b *GitBackend) Push(projectRoot string) error {
	return RunExportGitAt(projectRoot, false, false)
}

func (b *GitBackend) Pull(projectRoot string) error {
	return backend.ErrNoRemote
}

func (b *GitBackend) Sync(projectRoot string) error {
	return backend.ErrNoRemote
}

// GitHubBackend exports snapshots to git and syncs with a GitHub remote.
type GitHubBackend struct {
	Repo   string // "owner/repo"
	Remote string // git remote name
}

func (b *GitHubBackend) Type() string { return "github" }

func (b *GitHubBackend) Push(projectRoot string) error {
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		return err
	}
	return PushExportToRemote(projectRoot, b.Remote)
}

func (b *GitHubBackend) Sync(projectRoot string) error {
	// Export any new local snapshots
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		return err
	}

	// Optimistic push — try pushing first
	pushErr := PushExportToRemote(projectRoot, b.Remote)
	if pushErr == nil {
		return nil
	}

	// Push was rejected — fetch, import, re-export, push
	fmt.Println("Push rejected, fetching remote changes...")
	if err := fetchFromRemote(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fetch from remote: %w", err)
	}

	if err := fastForwardBranches(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fast-forward branches: %w", err)
	}

	if err := IncrementalImportFromGit(projectRoot); err != nil {
		return fmt.Errorf("failed to import remote changes: %w", err)
	}

	// Re-export with the new imported snapshots as parents
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		return err
	}

	return PushExportToRemote(projectRoot, b.Remote)
}

func (b *GitHubBackend) Pull(projectRoot string) error {
	if err := fetchFromRemote(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fetch from remote: %w", err)
	}

	if err := fastForwardBranches(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fast-forward branches: %w", err)
	}

	return IncrementalImportFromGit(projectRoot)
}

// fetchFromRemote fetches all branches and fst metadata from the remote.
func fetchFromRemote(projectRoot, remoteName string) error {
	if err := runGitCommand(projectRoot, "fetch", remoteName); err != nil {
		return err
	}
	return runGitCommand(projectRoot, "fetch", remoteName, "refs/fst/*:refs/fst/*")
}

// fastForwardBranches updates local branch refs to match remote tracking branches.
func fastForwardBranches(projectRoot, remoteName string) error {
	tempDir, err := os.MkdirTemp("", "fst-ff-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := newGitEnv(projectRoot, tempDir, indexPath)

	meta, err := loadExportMetadata(git)
	if err != nil {
		return fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return nil
	}

	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}
		remoteRef := remoteName + "/" + ws.Branch
		remoteSHA, err := git.output("rev-parse", "--verify", remoteRef)
		if err != nil {
			continue // remote branch doesn't exist
		}
		remoteSHA = strings.TrimSpace(remoteSHA)
		if remoteSHA == "" {
			continue
		}
		// Update local branch ref to remote
		_ = updateGitBranchRef(git, ws.Branch, remoteSHA)
	}
	return nil
}

// IncrementalImportFromGit imports new git commits that aren't yet mapped to snapshots.
func IncrementalImportFromGit(projectRoot string) error {
	configDir := filepath.Join(projectRoot, ".fst")
	mapping, err := LoadGitMapping(configDir)
	if err != nil {
		return fmt.Errorf("failed to load git mapping: %w", err)
	}

	// Build reverse map: commit SHA → snapshot ID
	commitToSnapshot := make(map[string]string, len(mapping.Snapshots))
	for snapID, commitSHA := range mapping.Snapshots {
		commitToSnapshot[commitSHA] = snapID
	}

	tempDir, err := os.MkdirTemp("", "fst-incr-import-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := newGitEnv(projectRoot, tempDir, indexPath)

	meta, err := loadExportMetadata(git)
	if err != nil {
		return fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return fmt.Errorf("no export metadata found")
	}

	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to load project config: %w", err)
	}

	s := store.OpenAt(projectRoot)

	workTempDir, err := os.MkdirTemp("", "fst-incr-worktree-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(workTempDir)

	importIndex := filepath.Join(workTempDir, "index")
	importGit := newGitEnv(projectRoot, workTempDir, importIndex)

	totalNew := 0

	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}

		commits, err := gitRevList(importGit, ws.Branch)
		if err != nil {
			return fmt.Errorf("failed to list commits for branch %s: %w", ws.Branch, err)
		}

		// Filter to only new commits
		var newCommits []string
		for _, commit := range commits {
			if _, known := commitToSnapshot[commit]; !known {
				newCommits = append(newCommits, commit)
			}
		}

		if len(newCommits) == 0 {
			continue
		}

		fmt.Printf("Importing %d new commits from branch %s\n", len(newCommits), ws.Branch)

		wsName := ws.WorkspaceName
		if wsName == "" {
			wsName = ws.Branch
		}

		// Find or create workspace config
		wsRoot := filepath.Join(projectRoot, wsName)
		wsCfg, err := ensureWorkspaceForImport(wsRoot, parentCfg.ProjectID, ws.WorkspaceID, wsName, s)
		if err != nil {
			return err
		}

		for _, commit := range newCommits {
			info, err := readGitCommitInfo(importGit, commit)
			if err != nil {
				return err
			}
			if err := gitCheckoutTree(importGit, commit); err != nil {
				return err
			}

			// Resolve parent snapshots from commit parents
			parentSnapshots := make([]string, 0, len(info.Parents))
			for _, parent := range info.Parents {
				if snapID, ok := commitToSnapshot[parent]; ok {
					parentSnapshots = append(parentSnapshots, snapID)
				}
			}

			agentName := ""
			if strings.HasSuffix(strings.ToLower(info.AuthorEmail), "@fastest.local") {
				agentName = info.AuthorName
			}

			snapshotID, err := createImportedSnapshot(s, workTempDir, wsCfg, parentSnapshots, info.Subject, info.AuthorDate, info.AuthorName, info.AuthorEmail, agentName)
			if err != nil {
				return err
			}

			// Update both maps
			commitToSnapshot[commit] = snapshotID
			mapping.Snapshots[snapshotID] = commit
			totalNew++
		}

		// Update workspace head to branch tip
		tipCommit := commits[len(commits)-1]
		if tipSnapID, ok := commitToSnapshot[tipCommit]; ok {
			wsCfg.CurrentSnapshotID = tipSnapID
			if err := config.SaveAt(wsRoot, wsCfg); err != nil {
				return fmt.Errorf("failed to save workspace config: %w", err)
			}
			// Update registry
			_ = s.RegisterWorkspace(store.WorkspaceInfo{
				WorkspaceID:       wsCfg.WorkspaceID,
				WorkspaceName:     wsCfg.WorkspaceName,
				Path:              wsRoot,
				CurrentSnapshotID: tipSnapID,
				BaseSnapshotID:    wsCfg.BaseSnapshotID,
				CreatedAt:         time.Now().UTC().Format(time.RFC3339),
			})
		}
	}

	// Save updated mapping
	if err := SaveGitMapping(configDir, mapping); err != nil {
		return fmt.Errorf("failed to save git mapping: %w", err)
	}

	if totalNew > 0 {
		fmt.Printf("Imported %d new snapshots\n", totalNew)
	} else {
		fmt.Println("Already up to date")
	}

	return nil
}

// ensureWorkspaceForImport finds or creates a workspace directory and config.
func ensureWorkspaceForImport(wsRoot, projectID, workspaceID, wsName string, s *store.Store) (*config.ProjectConfig, error) {
	if _, err := os.Stat(filepath.Join(wsRoot, ".fst", "config.json")); err == nil {
		// Workspace exists
		return config.LoadAt(wsRoot)
	}

	// Create workspace
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		return nil, fmt.Errorf("failed to create workspace directory: %w", err)
	}
	if workspaceID == "" {
		workspaceID = generateWorkspaceID()
	}
	if err := config.InitAt(wsRoot, projectID, workspaceID, wsName, ""); err != nil {
		return nil, fmt.Errorf("failed to initialize workspace: %w", err)
	}
	return config.LoadAt(wsRoot)
}

// backendAutoExport spawns a background subprocess to push to the backend.
func backendAutoExport(projectRoot string) {
	fstBin, err := os.Executable()
	if err != nil {
		return
	}

	cmd := exec.Command(fstBin, "sync")
	cmd.Dir = projectRoot
	logPath := filepath.Join(projectRoot, ".fst", "backend-export.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err == nil {
		cmd.Stdout = logFile
		cmd.Stderr = logFile
	}
	_ = cmd.Start()
	if logFile != nil {
		logFile.Close()
	}
}

func runBackendSetGitHub(repo string, createRepo, privateRepo bool, remoteName string, forceRemote bool) error {
	projectRoot, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	slug, remoteURL, err := parseGitHubRepo(repo)
	if err != nil {
		return err
	}

	if createRepo {
		if !hasGH() {
			return fmt.Errorf("gh CLI required to create repos (install gh)")
		}
		args := []string{"repo", "create", slug, "--confirm"}
		if privateRepo {
			args = append(args, "--private")
		} else {
			args = append(args, "--public")
		}
		if err := runGHCommand(projectRoot, args...); err != nil {
			return fmt.Errorf("failed to create repo: %w", err)
		}
	}

	// Export to git
	if err := RunExportGitAt(projectRoot, true, false); err != nil {
		return err
	}

	// Set up remote
	existingURL, exists, err := getGitRemoteURL(projectRoot, remoteName)
	if err != nil {
		return err
	}
	if exists {
		if existingURL != remoteURL {
			if !forceRemote {
				return fmt.Errorf("remote '%s' already set to %s (use --force-remote to override)", remoteName, existingURL)
			}
			if err := runGitCommand(projectRoot, "remote", "set-url", remoteName, remoteURL); err != nil {
				return fmt.Errorf("failed to update remote '%s': %w", remoteName, err)
			}
		}
	} else {
		if err := runGitCommand(projectRoot, "remote", "add", remoteName, remoteURL); err != nil {
			return fmt.Errorf("failed to add remote '%s': %w", remoteName, err)
		}
	}

	// Push
	if err := PushExportToRemote(projectRoot, remoteName); err != nil {
		return err
	}

	// Save backend config
	parentCfg.Backend = &config.BackendConfig{
		Type:   "github",
		Repo:   slug,
		Remote: remoteName,
	}
	if err := config.SaveParentConfigAt(projectRoot, parentCfg); err != nil {
		return fmt.Errorf("failed to save backend config: %w", err)
	}

	fmt.Printf("Backend set to github (%s)\n", slug)
	fmt.Println("Snapshots will auto-export to this repository.")
	return nil
}

func runBackendSetGit() error {
	projectRoot, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	// Export to git
	if err := RunExportGitAt(projectRoot, true, false); err != nil {
		return err
	}

	// Save backend config
	parentCfg.Backend = &config.BackendConfig{
		Type: "git",
	}
	if err := config.SaveParentConfigAt(projectRoot, parentCfg); err != nil {
		return fmt.Errorf("failed to save backend config: %w", err)
	}

	fmt.Println("Backend set to git (local only)")
	fmt.Println("Snapshots will auto-export to the local git repository.")
	return nil
}

func runBackendOff() error {
	projectRoot, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	parentCfg.Backend = nil
	if err := config.SaveParentConfigAt(projectRoot, parentCfg); err != nil {
		return fmt.Errorf("failed to save config: %w", err)
	}

	fmt.Println("Backend disabled")
	return nil
}

func runBackendStatus() error {
	_, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	if parentCfg.Backend == nil {
		fmt.Println("Backend: none")
		return nil
	}

	fmt.Printf("Backend: %s\n", parentCfg.Backend.Type)
	if parentCfg.Backend.Repo != "" {
		fmt.Printf("Repo:    %s\n", parentCfg.Backend.Repo)
	}
	if parentCfg.Backend.Remote != "" {
		fmt.Printf("Remote:  %s\n", parentCfg.Backend.Remote)
	}
	return nil
}

func runBackendPush() error {
	projectRoot, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	b := BackendFromConfig(parentCfg.Backend)
	if b == nil {
		return fmt.Errorf("no backend configured")
	}

	return b.Push(projectRoot)
}

