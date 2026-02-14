package commands

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/store"
	"github.com/anthropics/fastest/cli/internal/workspace"
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

func (b *GitBackend) Sync(projectRoot string, opts *backend.SyncOptions) error {
	return b.Push(projectRoot)
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

func (b *GitHubBackend) Sync(projectRoot string, opts *backend.SyncOptions) error {
	// Export any new local snapshots
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		return err
	}

	// Optimistic push — try pushing first
	pushErr := PushExportToRemote(projectRoot, b.Remote)
	if pushErr == nil {
		return nil
	}

	// Only fall back to fetch+import if push was rejected (non-fast-forward).
	// Auth errors, network errors, etc. should be surfaced directly.
	if !errors.Is(pushErr, backend.ErrPushRejected) {
		return pushErr
	}

	// Push was rejected — fetch, import, merge diverged, re-export, push
	fmt.Println("Push rejected, fetching remote changes...")
	if err := fetchFromRemote(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fetch from remote: %w", err)
	}

	if err := fastForwardBranches(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fast-forward branches: %w", err)
	}

	result, err := IncrementalImportFromGit(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to import remote changes: %w", err)
	}

	// Handle diverged workspaces
	for _, div := range result.Diverged {
		if opts == nil || opts.OnDivergence == nil {
			return fmt.Errorf("workspace '%s' has diverged from remote; run 'fst sync' interactively to resolve", div.WorkspaceName)
		}
		mergedID, mergeErr := opts.OnDivergence(div)
		if mergeErr != nil {
			return fmt.Errorf("failed to merge diverged workspace '%s': %w", div.WorkspaceName, mergeErr)
		}
		// Update workspace config with merged snapshot
		wsCfg, loadErr := config.LoadAt(div.WorkspaceRoot)
		if loadErr != nil {
			return fmt.Errorf("failed to load workspace config for '%s': %w", div.WorkspaceName, loadErr)
		}
		wsCfg.CurrentSnapshotID = mergedID
		if saveErr := config.SaveAt(div.WorkspaceRoot, wsCfg); saveErr != nil {
			return fmt.Errorf("failed to save workspace config for '%s': %w", div.WorkspaceName, saveErr)
		}
		s := store.OpenAt(projectRoot)
		_ = s.RegisterWorkspace(store.WorkspaceInfo{
			WorkspaceID:       wsCfg.WorkspaceID,
			WorkspaceName:     wsCfg.WorkspaceName,
			Path:              div.WorkspaceRoot,
			CurrentSnapshotID: mergedID,
			BaseSnapshotID:    wsCfg.BaseSnapshotID,
			CreatedAt:         time.Now().UTC().Format(time.RFC3339),
		})
	}

	// Re-export with the new imported/merged snapshots as parents
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

	_, err := IncrementalImportFromGit(projectRoot)
	return err
}

// fetchFromRemote fetches all branches and fst metadata from the remote.
func fetchFromRemote(projectRoot, remoteName string) error {
	if err := runGitCommand(projectRoot, "fetch", remoteName); err != nil {
		return err
	}
	return runGitCommand(projectRoot, "fetch", remoteName, "refs/fst/*:refs/fst/*")
}

// fastForwardBranches updates local branch refs to match remote tracking branches
// only when the remote is strictly ahead (fast-forward). If branches have diverged,
// the branch is left unchanged — the subsequent import + merge will handle it.
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

		localSHA, err := gitRefSHA(git, "refs/heads/"+ws.Branch)
		if err != nil {
			// Local branch doesn't exist yet — create it at remote
			_ = updateGitBranchRef(git, ws.Branch, remoteSHA)
			continue
		}

		if localSHA == remoteSHA {
			continue // already in sync
		}

		// Check if local is ancestor of remote (remote is ahead → fast-forward)
		if isAncestor(git, localSHA, remoteSHA) {
			_ = updateGitBranchRef(git, ws.Branch, remoteSHA)
			continue
		}

		// Check if remote is ancestor of local (local is ahead → nothing to do)
		if isAncestor(git, remoteSHA, localSHA) {
			continue
		}

		// Branches have diverged — skip; import + merge will handle this
		fmt.Printf("  Branch %s has diverged from remote, will reconcile during sync\n", ws.Branch)
	}
	return nil
}

// isAncestor returns true if ancestorSHA is an ancestor of descendantSHA.
func isAncestor(git gitEnv, ancestorSHA, descendantSHA string) bool {
	cmd := git.command("merge-base", "--is-ancestor", ancestorSHA, descendantSHA)
	return cmd.Run() == nil
}

// ImportResult contains the outcome of an incremental import.
type ImportResult struct {
	NewSnapshots int
	Diverged     []backend.DivergenceInfo
}

// IncrementalImportFromGit imports new git commits that aren't yet mapped to snapshots.
// Returns divergence info for workspaces where the local head has drifted.
func IncrementalImportFromGit(projectRoot string) (*ImportResult, error) {
	result := &ImportResult{}

	configDir := filepath.Join(projectRoot, ".fst")
	mapping, err := LoadGitMapping(configDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load git mapping: %w", err)
	}

	// Build reverse map: commit SHA → snapshot ID
	commitToSnapshot := make(map[string]string, len(mapping.Snapshots))
	for snapID, commitSHA := range mapping.Snapshots {
		commitToSnapshot[commitSHA] = snapID
	}

	// Keep a snapshot of the original map to detect which commits were already known
	originalCommitToSnapshot := make(map[string]string, len(commitToSnapshot))
	for k, v := range commitToSnapshot {
		originalCommitToSnapshot[k] = v
	}

	tempDir, err := os.MkdirTemp("", "fst-incr-import-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := newGitEnv(projectRoot, tempDir, indexPath)

	meta, err := loadExportMetadata(git)
	if err != nil {
		return nil, fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return nil, fmt.Errorf("no export metadata found")
	}

	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		return nil, fmt.Errorf("failed to load project config: %w", err)
	}

	s := store.OpenAt(projectRoot)

	workTempDir, err := os.MkdirTemp("", "fst-incr-worktree-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workTempDir)

	importIndex := filepath.Join(workTempDir, "index")
	importGit := newGitEnv(projectRoot, workTempDir, importIndex)

	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}

		commits, err := gitRevList(importGit, ws.Branch)
		if err != nil {
			return nil, fmt.Errorf("failed to list commits for branch %s: %w", ws.Branch, err)
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
			return nil, err
		}

		for _, commit := range newCommits {
			info, err := readGitCommitInfo(importGit, commit)
			if err != nil {
				return nil, err
			}
			if err := gitCheckoutTree(importGit, commit); err != nil {
				return nil, err
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
				return nil, err
			}

			// Update both maps
			commitToSnapshot[commit] = snapshotID
			mapping.Snapshots[snapshotID] = commit
			result.NewSnapshots++
		}

		// Update workspace head to branch tip, but only if the current head
		// is still what we expect (no local drift since last sync).
		tipCommit := commits[len(commits)-1]
		tipSnapID, ok := commitToSnapshot[tipCommit]
		if !ok {
			continue
		}

		// Reload config to get the freshest head
		freshCfg, loadErr := config.LoadAt(wsRoot)
		if loadErr != nil {
			freshCfg = wsCfg
		}
		currentHead := freshCfg.CurrentSnapshotID

		// Find the previous tip (the last commit we already knew about)
		previousTipSnap := ""
		for i := len(commits) - 1; i >= 0; i-- {
			snap, known := commitToSnapshot[commits[i]]
			if known && snap != "" {
				if _, wasKnown := originalCommitToSnapshot[commits[i]]; wasKnown {
					previousTipSnap = snap
					break
				}
			}
		}

		// Only update if head hasn't drifted (matches previous tip or is empty)
		if currentHead == "" || currentHead == previousTipSnap || currentHead == tipSnapID {
			freshCfg.CurrentSnapshotID = tipSnapID
			if err := config.SaveAt(wsRoot, freshCfg); err != nil {
				return nil, fmt.Errorf("failed to save workspace config: %w", err)
			}
			_ = s.RegisterWorkspace(store.WorkspaceInfo{
				WorkspaceID:       freshCfg.WorkspaceID,
				WorkspaceName:     freshCfg.WorkspaceName,
				Path:              wsRoot,
				CurrentSnapshotID: tipSnapID,
				BaseSnapshotID:    freshCfg.BaseSnapshotID,
				CreatedAt:         time.Now().UTC().Format(time.RFC3339),
			})
		} else {
			// Local head has diverged — report for merge
			result.Diverged = append(result.Diverged, backend.DivergenceInfo{
				ProjectRoot:   projectRoot,
				WorkspaceName: wsName,
				WorkspaceRoot: wsRoot,
				LocalHead:     currentHead,
				RemoteHead:    tipSnapID,
				MergeBase:     previousTipSnap,
			})
		}
	}

	// Save updated mapping
	if err := SaveGitMapping(configDir, mapping); err != nil {
		return nil, fmt.Errorf("failed to save git mapping: %w", err)
	}

	if result.NewSnapshots > 0 {
		fmt.Printf("Imported %d new snapshots\n", result.NewSnapshots)
	} else {
		fmt.Println("Already up to date")
	}

	return result, nil
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

// backendAutoExport spawns a background subprocess to sync with the backend.
// Skips silently if another backend operation is already running.
// Prints a warning if the previous background sync failed.
func backendAutoExport(projectRoot string) {
	logPath := filepath.Join(projectRoot, ".fst", "backend-export.log")

	// Check if the previous background sync failed
	checkPreviousSyncLog(logPath)

	// Try to acquire lock non-blocking to check if another operation is running.
	// We release it immediately — the subprocess will acquire its own lock.
	lock, err := workspace.TryAcquireBackendLock(projectRoot)
	if err != nil {
		return
	}
	if lock == nil {
		// Another backend operation is running, skip
		return
	}
	lock.Release()

	fstBin, err := os.Executable()
	if err != nil {
		return
	}

	cmd := exec.Command(fstBin, "sync")
	cmd.Dir = projectRoot
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

// checkPreviousSyncLog reads the previous background sync log and prints a
// warning if it contains error indicators.
func checkPreviousSyncLog(logPath string) {
	data, err := os.ReadFile(logPath)
	if err != nil {
		return // no previous log
	}
	content := strings.TrimSpace(string(data))
	if content == "" {
		return
	}
	lower := strings.ToLower(content)
	if strings.Contains(lower, "error") || strings.Contains(lower, "fatal") || strings.Contains(lower, "failed") {
		fmt.Println("Warning: last background sync had errors (see .fst/backend-export.log)")
	}
}

// buildOnDivergence creates an OnDivergence callback that uses the existing
// merge infrastructure to reconcile diverged workspace heads.
func buildOnDivergence(mode ConflictMode) func(backend.DivergenceInfo) (string, error) {
	return func(div backend.DivergenceInfo) (string, error) {
		s := store.OpenAt(div.ProjectRoot)

		// Load manifests
		var baseManifest *manifest.Manifest
		if div.MergeBase != "" {
			var err error
			baseManifest, err = loadManifestByID(div.ProjectRoot, div.MergeBase)
			if err != nil {
				baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
			}
		} else {
			baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
		}

		currentManifest, err := manifest.GenerateWithCache(div.WorkspaceRoot, config.GetStatCachePath(div.WorkspaceRoot))
		if err != nil {
			return "", fmt.Errorf("failed to scan local files: %w", err)
		}

		remoteManifest, err := loadManifestByID(div.ProjectRoot, div.RemoteHead)
		if err != nil {
			return "", fmt.Errorf("failed to load remote manifest: %w", err)
		}

		// Materialize remote snapshot to temp dir
		tempDir, err := os.MkdirTemp("", "fst-backend-merge-*")
		if err != nil {
			return "", fmt.Errorf("failed to create temp dir: %w", err)
		}
		defer os.RemoveAll(tempDir)

		if err := restoreFilesFromManifest(tempDir, s, remoteManifest); err != nil {
			return "", fmt.Errorf("failed to materialize remote snapshot: %w", err)
		}

		sourceManifest, err := manifest.Generate(tempDir, false)
		if err != nil {
			return "", fmt.Errorf("failed to scan remote files: %w", err)
		}

		mergeActions := computeMergeActions(baseManifest, currentManifest, sourceManifest)
		fmt.Printf("Merging diverged workspace '%s':\n", div.WorkspaceName)
		fmt.Printf("  Apply from remote:  %d files\n", len(mergeActions.toApply))
		fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
		fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))

		// Apply non-conflicting changes
		for _, action := range mergeActions.toApply {
			if err := applyChange(div.WorkspaceRoot, tempDir, action); err != nil {
				return "", err
			}
		}

		// Handle conflicts
		if len(mergeActions.conflicts) > 0 {
			switch mode {
			case ConflictModeAgent:
				preferredAgent, err := agent.GetPreferredAgent()
				if err != nil {
					return "", err
				}
				for _, conflict := range mergeActions.conflicts {
					if err := resolveConflictWithAgent(div.WorkspaceRoot, tempDir, conflict, preferredAgent, baseManifest); err != nil {
						return "", err
					}
				}
			case ConflictModeManual:
				for _, conflict := range mergeActions.conflicts {
					if err := createConflictMarkers(div.WorkspaceRoot, tempDir, conflict); err != nil {
						return "", err
					}
				}
				fmt.Println("Conflicts written with markers. Resolve them, then run 'fst snapshot'.")
			case ConflictModeTheirs:
				for _, conflict := range mergeActions.conflicts {
					if err := applyChange(div.WorkspaceRoot, tempDir, conflict); err != nil {
						return "", err
					}
				}
			case ConflictModeOurs:
				// Keep local version; nothing to do
			}
		}

		// Create merge snapshot with both parents
		mergeParents := normalizeMergeParents(div.LocalHead, div.RemoteHead)
		if err := config.WritePendingMergeParentsAt(div.ProjectRoot, mergeParents); err != nil {
			fmt.Printf("Warning: Could not record merge parents: %v\n", err)
		}

		if err := runSnapshot("Backend sync merge", false); err != nil {
			return "", fmt.Errorf("failed to create merge snapshot: %w", err)
		}

		// Read back the snapshot ID that was just created
		wsCfg, err := config.LoadAt(div.WorkspaceRoot)
		if err != nil {
			return "", fmt.Errorf("failed to read merged snapshot ID: %w", err)
		}

		return wsCfg.CurrentSnapshotID, nil
	}
}

func runBackendSetGitHub(repo string, createRepo, privateRepo bool, remoteName string, forceRemote bool) error {
	projectRoot, parentCfg, err := findProjectRootAndParent()
	if err != nil {
		return err
	}

	lock, err := workspace.AcquireBackendLock(projectRoot)
	if err != nil {
		return err
	}
	defer lock.Release()

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

	lock, err := workspace.AcquireBackendLock(projectRoot)
	if err != nil {
		return err
	}
	defer lock.Release()

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

	lock, err := workspace.AcquireBackendLock(projectRoot)
	if err != nil {
		return err
	}
	defer lock.Release()

	b := BackendFromConfig(parentCfg.Backend)
	if b == nil {
		return fmt.Errorf("no backend configured")
	}

	return b.Push(projectRoot)
}
