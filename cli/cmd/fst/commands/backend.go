package commands

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/gitstore"
	"github.com/anthropics/fastest/cli/internal/gitutil"
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

		if err := gitstore.RestoreFilesFromManifest(tempDir, s, remoteManifest); err != nil {
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

		hasConflicts := mode == ConflictModeManual && len(mergeActions.conflicts) > 0
		fmt.Println()
		fmt.Println(dag.RenderMergeDiagram(dag.MergeDiagramOpts{
			CurrentID:     div.LocalHead,
			SourceID:      div.RemoteHead,
			MergeBaseID:   div.MergeBase,
			MergedID:      wsCfg.CurrentSnapshotID,
			CurrentLabel:  "local",
			SourceLabel:   "remote",
			Message:       "Sync merge",
			Pending:       hasConflicts,
			ConflictCount: len(mergeActions.conflicts),
			Colorize:      true,
		}))

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
			if err := gitutil.RunCommand(projectRoot, "remote", "set-url", remoteName, remoteURL); err != nil {
				return fmt.Errorf("failed to update remote '%s': %w", remoteName, err)
			}
		}
	} else {
		if err := gitutil.RunCommand(projectRoot, "remote", "add", remoteName, remoteURL); err != nil {
			return fmt.Errorf("failed to add remote '%s': %w", remoteName, err)
		}
	}

	// Push
	if err := gitstore.PushExportToRemote(projectRoot, remoteName); err != nil {
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

	b := backend.FromConfig(parentCfg.Backend, RunExportGitAt)
	if b == nil {
		return fmt.Errorf("no backend configured")
	}

	return b.Push(projectRoot)
}
