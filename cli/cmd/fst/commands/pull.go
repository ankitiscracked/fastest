package commands

import (
	"bufio"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newPullCmd()) })
}

func newPullCmd() *cobra.Command {
	var snapshotID string
	var hard bool
	var manual bool
	var theirs bool
	var ours bool
	var dryRun bool
	var dryRunSummary bool

	cmd := &cobra.Command{
		Use:   "pull [workspace]",
		Short: "Pull latest snapshot from cloud",
		Long: `Pull the latest snapshot for this workspace from the cloud.

By default, pull merges the remote snapshot into your local workspace.
Use --hard to replace local files with the remote snapshot.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			modeCount := 0
			if manual {
				modeCount++
			}
			if theirs {
				modeCount++
			}
			if ours {
				modeCount++
			}
			if modeCount > 1 {
				return fmt.Errorf("only one of --manual, --theirs, --ours can be specified")
			}

			mode := ConflictModeAgent // default
			if manual {
				mode = ConflictModeManual
			} else if theirs {
				mode = ConflictModeTheirs
			} else if ours {
				mode = ConflictModeOurs
			}

			var workspaceName string
			if len(args) > 0 {
				workspaceName = args[0]
			}
			return runPull(workspaceName, snapshotID, hard, mode, dryRun, dryRunSummary)
		},
	}

	cmd.Flags().StringVar(&snapshotID, "snapshot", "", "Pull a specific snapshot ID")
	cmd.Flags().BoolVar(&hard, "hard", false, "Replace local files with the remote snapshot (destructive)")
	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take remote version for conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep local version for conflicts")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Preview pull with line-level conflict details")
	cmd.Flags().BoolVar(&dryRunSummary, "agent-summary", false, "Generate LLM summary of conflicts (with --dry-run)")

	return cmd
}

func runPull(workspaceName string, snapshotID string, hard bool, mode ConflictMode, dryRun bool, dryRunSummary bool) error {
	// Check for backend dispatch
	if projectRoot, parentCfg, findErr := findProjectRootAndParent(); findErr == nil {
		if b := backend.FromConfig(parentCfg.Backend, RunExportGitAt); b != nil {
			lock, lockErr := workspace.AcquireBackendLock(projectRoot)
			if lockErr != nil {
				return lockErr
			}
			defer lock.Release()

			if err := b.Pull(projectRoot); err == backend.ErrNoRemote {
				fmt.Println("Backend has no remote to pull from.")
				return nil
			} else {
				return err
			}
		}
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	token, err := deps.AuthGetToken()
	if err != nil {
		return deps.AuthFormatError(err)
	}
	if token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	client := deps.NewAPIClient(token, cfg)

	if snapshotID != "" && strings.HasPrefix(snapshotID, "snap-") && len(snapshotID) < 30 {
		if resolved, err := config.ResolveSnapshotIDAt(root, snapshotID); err == nil {
			snapshotID = resolved
		} else {
			return fmt.Errorf("snapshot %q not found locally; use full snapshot ID", snapshotID)
		}
	}

	if snapshotID == "" {
		var remoteWorkspaceID string
		if workspaceName == "" {
			remoteWorkspaceID = cfg.WorkspaceID
		} else {
			_, workspaces, err := client.GetProject(cfg.ProjectID)
			if err != nil {
				return fmt.Errorf("failed to fetch project: %w", err)
			}
			ws, err := resolveWorkspaceFromAPI(workspaceName, workspaces)
			if err != nil {
				return err
			}
			remoteWorkspaceID = ws.ID
		}

		ws, err := client.GetWorkspace(remoteWorkspaceID)
		if err != nil {
			return fmt.Errorf("failed to fetch workspace: %w", err)
		}
		if ws.CurrentSnapshotID == nil || *ws.CurrentSnapshotID == "" {
			return fmt.Errorf("workspace has no remote snapshot")
		}
		snapshotID = *ws.CurrentSnapshotID
	}

	latestLocalID := cfg.CurrentSnapshotID
	if latestLocalID == "" {
		var err error
		latestLocalID, err = config.GetLatestSnapshotID()
		if err != nil {
			return fmt.Errorf("failed to read local snapshots: %w", err)
		}
	}
	dirty, err := isWorkingTreeDirty(root, latestLocalID)
	if err != nil {
		return err
	}

	snapshot, err := client.GetSnapshot(snapshotID)
	if err != nil {
		return err
	}

	manifestJSON, err := client.DownloadManifest(snapshot.ManifestHash)
	if err != nil {
		return fmt.Errorf("failed to download manifest: %w", err)
	}

	m, err := manifest.FromJSON(manifestJSON)
	if err != nil {
		return fmt.Errorf("failed to parse manifest: %w", err)
	}

	if hard {
		if !confirmDestructivePull(snapshotID) {
			return fmt.Errorf("pull cancelled")
		}

		if err := removeFilesNotInManifest(root, m); err != nil {
			return err
		}

		if err := materializeSnapshot(client, root, m); err != nil {
			return err
		}

		if err := writeSnapshotFiles(root, snapshot, manifestJSON, m, cfg.WorkspaceName); err != nil {
			return err
		}

		cfg.Mode = "cloud"
		cfg.CurrentSnapshotID = snapshotID
		_ = config.SaveAt(root, cfg)

		fmt.Println("✓ Pull complete!")
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
		return nil
	}

	// Merge remote snapshot into local workspace (sync-like behavior)
	if dirty {
		snapshotID, err := CreateAutoSnapshot("Before pull")
		if err != nil {
			return fmt.Errorf("failed to create pre-pull snapshot (use --hard to skip): %w", err)
		}
		if snapshotID != "" {
			fmt.Printf("Created snapshot %s (use 'fst restore' to undo pull)\n", snapshotID)
		}
	}

	tempDir, err := os.MkdirTemp("", "fst-pull-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)

	if err := materializeSnapshot(client, tempDir, m); err != nil {
		return err
	}

	baseManifest, mergeBaseID, err := getSyncMergeBase(client, root, latestLocalID, snapshotID)
	if err != nil {
		return err
	}

	currentManifest, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
	if err != nil {
		return fmt.Errorf("failed to scan local files: %w", err)
	}

	sourceManifest, err := manifest.Generate(tempDir, false)
	if err != nil {
		return fmt.Errorf("failed to scan remote files: %w", err)
	}

	mergeActions := computeMergeActions(baseManifest, currentManifest, sourceManifest)
	fmt.Println("Merge plan:")
	fmt.Printf("  Apply from remote:  %d files\n", len(mergeActions.toApply))
	fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
	fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))

	if len(mergeActions.toApply) == 0 && len(mergeActions.conflicts) == 0 {
		fmt.Println("✓ Nothing to pull - already aligned")
		return nil
	}

	if dryRun {
		printCloudMergePlan(mergeActions)
		if dryRunSummary && len(mergeActions.conflicts) > 0 {
			preferredAgent, err := deps.AgentGetPreferred()
			if err == nil {
				conflictContext := buildSyncConflictContext(mergeActions.conflicts)
				summaryText, err := agent.InvokeConflictSummary(preferredAgent, conflictContext, deps.AgentInvoke)
				if err == nil && summaryText != "" {
					fmt.Println()
					fmt.Println("Summary:")
					fmt.Println(summaryText)
				}
			}
		}
		sourceLabel := workspaceName
		if sourceLabel == "" {
			sourceLabel = "remote"
		}
		fmt.Println()
		fmt.Println(dag.RenderMergeDiagram(dag.MergeDiagramOpts{
			CurrentID:     latestLocalID,
			SourceID:      snapshotID,
			MergeBaseID:   mergeBaseID,
			CurrentLabel:  "local",
			SourceLabel:   sourceLabel,
			Message:       "Pull merge (dry run)",
			ConflictCount: len(mergeActions.conflicts),
			Colorize:      true,
		}))
		return nil
	}

	for _, action := range mergeActions.toApply {
		if err := applyChange(root, tempDir, action); err != nil {
			return err
		}
	}

	if len(mergeActions.conflicts) > 0 {
		switch mode {
		case ConflictModeAgent:
			preferredAgent, err := deps.AgentGetPreferred()
			if err != nil {
				return err
			}
			for _, conflict := range mergeActions.conflicts {
				if err := resolveConflictWithAgent(root, tempDir, conflict, preferredAgent, baseManifest, deps.AgentInvoke); err != nil {
					return err
				}
			}
		case ConflictModeManual:
			for _, conflict := range mergeActions.conflicts {
				if err := createConflictMarkers(root, tempDir, conflict); err != nil {
					return err
				}
			}
			sourceLabel := workspaceName
			if sourceLabel == "" {
				sourceLabel = "remote"
			}
			fmt.Println("Conflicts written with markers. Resolve them, then run 'fst snapshot'.")
			fmt.Println()
			fmt.Println(dag.RenderMergeDiagram(dag.MergeDiagramOpts{
				CurrentID:     latestLocalID,
				SourceID:      snapshotID,
				MergeBaseID:   mergeBaseID,
				CurrentLabel:  "local",
				SourceLabel:   sourceLabel,
				Message:       "Pull merge",
				Pending:       true,
				ConflictCount: len(mergeActions.conflicts),
				Colorize:      true,
			}))
			return nil
		case ConflictModeTheirs:
			for _, conflict := range mergeActions.conflicts {
				if err := applyChange(root, tempDir, conflict); err != nil {
					return err
				}
			}
		case ConflictModeOurs:
			// Keep local version; nothing to do
		}
	}

	if err := runSnapshot("Pull merge", false); err != nil {
		return err
	}

	return deps.UploadSnapshot(client, root, cfg)
}

func confirmDestructivePull(snapshotID string) bool {
	reader := bufio.NewReader(os.Stdin)
	fmt.Printf("This will replace local files with remote snapshot %s and discard local changes. Continue? [y/N] ", snapshotID)
	resp, _ := reader.ReadString('\n')
	resp = strings.TrimSpace(strings.ToLower(resp))
	return resp == "y" || resp == "yes"
}

func uploadLatestSnapshotToCloud(client *api.Client, root string, cfg *config.ProjectConfig) error {
	latestID, err := config.GetLatestSnapshotIDAt(root)
	if err != nil || latestID == "" {
		return fmt.Errorf("failed to determine latest snapshot for upload")
	}

	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, latestID)
	if err != nil {
		return err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	manifestJSON, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("failed to read manifest: %w", err)
	}

	m, err := manifest.FromJSON(manifestJSON)
	if err != nil {
		return fmt.Errorf("failed to parse manifest: %w", err)
	}

	if err := uploadSnapshotToCloud(client, root, m, manifestHash, manifestJSON); err != nil {
		return err
	}

	parentIDs, _ := config.SnapshotParentIDsAt(root, latestID)
	if parentIDs == nil {
		parentIDs = []string{}
	}
	if _, _, err := client.CreateSnapshot(cfg.ProjectID, latestID, manifestHash, parentIDs, cfg.WorkspaceID); err != nil {
		return err
	}

	return nil
}

func isWorkingTreeDirty(root, latestSnapshotID string) (bool, error) {
	current, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
	if err != nil {
		return false, fmt.Errorf("failed to scan files: %w", err)
	}

	if latestSnapshotID == "" {
		return current.FileCount() > 0, nil
	}

	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, latestSnapshotID)
	if err != nil {
		return true, err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return true, nil
	}

	previous, err := manifest.FromJSON(data)
	if err != nil {
		return true, nil
	}

	currentHash, err := current.Hash()
	if err != nil {
		return false, fmt.Errorf("failed to hash current manifest: %w", err)
	}
	previousHash, err := previous.Hash()
	if err != nil {
		return false, fmt.Errorf("failed to hash snapshot manifest: %w", err)
	}

	return currentHash != previousHash, nil
}

func removeFilesNotInManifest(root string, target *manifest.Manifest) error {
	current, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
	if err != nil {
		return fmt.Errorf("failed to scan current files: %w", err)
	}

	targetSet := make(map[string]struct{}, len(target.Files))
	for _, f := range append(target.FileEntries(), target.SymlinkEntries()...) {
		targetSet[f.Path] = struct{}{}
	}

	for _, f := range append(current.FileEntries(), current.SymlinkEntries()...) {
		if _, ok := targetSet[f.Path]; ok {
			continue
		}
		path := filepath.Join(root, filepath.FromSlash(f.Path))
		if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
			return err
		}
	}

	return nil
}
