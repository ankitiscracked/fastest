package commands

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newSyncCmd()) })
}

func newSyncCmd() *cobra.Command {
	var manual bool
	var theirs bool
	var ours bool
	var files []string
	var dryRun bool
	var dryRunSummary bool
	var noSnapshot bool

	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Sync local and remote for this workspace",
		Long: `Sync local and remote changes for the current workspace.

If the local and remote heads diverged, this performs a three-way merge
and creates a new snapshot on success.`,
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

			return runSync(mode, files, dryRun, dryRunSummary, noSnapshot)
		},
	}

	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take remote version for conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep local version for conflicts")
	cmd.Flags().StringSliceVar(&files, "files", nil, "Only sync specific files")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Preview sync with line-level conflict details")
	cmd.Flags().BoolVar(&dryRunSummary, "agent-summary", false, "Generate LLM summary of conflicts (with --dry-run)")
	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Skip auto-snapshot before sync")

	return cmd
}

func runSync(mode ConflictMode, cherryPick []string, dryRun bool, dryRunSummary bool, noSnapshot bool) error {
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
	ws, err := client.GetWorkspace(cfg.WorkspaceID)
	if err != nil {
		return fmt.Errorf("failed to fetch workspace: %w", err)
	}
	if ws.CurrentSnapshotID == nil || *ws.CurrentSnapshotID == "" {
		return fmt.Errorf("workspace has no remote snapshot")
	}
	remoteHead := *ws.CurrentSnapshotID

	localHead := cfg.CurrentSnapshotID
	if localHead == "" {
		localHead, _ = config.GetLatestSnapshotID()
	}

	if localHead != "" && localHead == remoteHead {
		fmt.Println("✓ Already in sync.")
		return nil
	}

	remoteSnapshot, err := client.GetSnapshot(remoteHead)
	if err != nil {
		return err
	}

	manifestJSON, err := client.DownloadManifest(remoteSnapshot.ManifestHash)
	if err != nil {
		return fmt.Errorf("failed to download manifest: %w", err)
	}

	remoteManifest, err := manifest.FromJSON(manifestJSON)
	if err != nil {
		return fmt.Errorf("failed to parse remote manifest: %w", err)
	}

	tempDir, err := os.MkdirTemp("", "fst-sync-*")
	if err != nil {
		return fmt.Errorf("failed to create temp dir: %w", err)
	}
	defer os.RemoveAll(tempDir)

	if err := materializeSnapshot(client, tempDir, remoteManifest); err != nil {
		return err
	}

	baseManifest, err := getSyncMergeBaseManifest(client, root, localHead, remoteHead)
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
	mergeActions = filterMergeActions(mergeActions, cherryPick)
	fmt.Println("Merge plan:")
	fmt.Printf("  Apply from remote:  %d files\n", len(mergeActions.toApply))
	fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
	fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))
	if len(mergeActions.skipped) > 0 {
		fmt.Printf("  Skipped (filter):   %d files\n", len(mergeActions.skipped))
	}

	if len(mergeActions.toApply) == 0 && len(mergeActions.conflicts) == 0 {
		fmt.Println("✓ Nothing to sync - already aligned")
		return nil
	}

	if !dryRun && !noSnapshot {
		snapshotID, err := CreateAutoSnapshot("Before sync")
		if err != nil {
			return fmt.Errorf("failed to create pre-sync snapshot (use --no-snapshot to skip): %w", err)
		}
		if snapshotID != "" {
			fmt.Printf("Created snapshot %s (use 'fst rollback' to undo sync)\n", snapshotID)
		}
	}

	if dryRun {
		printCloudMergePlan(mergeActions)
		if dryRunSummary && len(mergeActions.conflicts) > 0 {
			preferredAgent, err := agent.GetPreferredAgent()
			if err == nil {
				conflictContext := buildSyncConflictContext(mergeActions.conflicts)
				summaryText, err := agent.InvokeConflictSummary(preferredAgent, conflictContext)
				if err == nil && summaryText != "" {
					fmt.Println()
					fmt.Println("Summary:")
					fmt.Println(summaryText)
				}
			}
		}
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
			preferredAgent, err := agent.GetPreferredAgent()
			if err != nil {
				return err
			}
			for _, conflict := range mergeActions.conflicts {
				if err := resolveConflictWithAgent(root, tempDir, conflict, preferredAgent, baseManifest); err != nil {
					return err
				}
			}
		case ConflictModeManual:
			for _, conflict := range mergeActions.conflicts {
				if err := createConflictMarkers(root, tempDir, conflict); err != nil {
					return err
				}
			}
			fmt.Println("Conflicts written with markers. Resolve them, then run 'fst snapshot'.")
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

	if !dryRun {
		mergeParents := normalizeMergeParents(localHead, remoteHead)
		if len(mergeParents) >= 2 {
			if err := config.WritePendingMergeParentsAt(root, mergeParents); err != nil {
				fmt.Printf("Warning: Could not record merge parents: %v\n", err)
			}
		}
	}

	if err := runSnapshot("Sync merge", false); err != nil {
		return err
	}

	return deps.UploadSnapshot(client, root, cfg)
}

func filterMergeActions(actions *mergeActions, files []string) *mergeActions {
	if len(files) == 0 {
		return actions
	}

	filesSet := make(map[string]bool, len(files))
	for _, f := range files {
		filesSet[f] = true
	}

	filtered := &mergeActions{}
	for _, a := range actions.toApply {
		if filesSet[a.path] {
			filtered.toApply = append(filtered.toApply, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}
	for _, a := range actions.conflicts {
		if filesSet[a.path] {
			filtered.conflicts = append(filtered.conflicts, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}
	for _, a := range actions.inSync {
		if filesSet[a.path] {
			filtered.inSync = append(filtered.inSync, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}

	return filtered
}

func getSyncMergeBaseManifest(client *api.Client, root, localHead, remoteHead string) (*manifest.Manifest, error) {
	if localHead == "" || remoteHead == "" {
		return &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}, nil
	}

	localAncestors := map[string]struct{}{}
	current := localHead
	for current != "" {
		if _, ok := localAncestors[current]; ok {
			break
		}
		localAncestors[current] = struct{}{}
		parent, err := config.SnapshotPrimaryParentIDAt(root, current)
		if err != nil {
			break
		}
		current = parent
	}

	mergeBaseID := ""
	remoteCurrent := remoteHead
	for remoteCurrent != "" {
		if _, ok := localAncestors[remoteCurrent]; ok {
			mergeBaseID = remoteCurrent
			break
		}
		snap, err := client.GetSnapshot(remoteCurrent)
		if err != nil {
			break
		}
		if len(snap.ParentSnapshotIDs) == 0 {
			break
		}
		remoteCurrent = snap.ParentSnapshotIDs[0]
	}

	if mergeBaseID == "" {
		return &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}, nil
	}

	if localManifest, err := loadManifestByID(root, mergeBaseID); err == nil {
		return localManifest, nil
	}

	baseSnap, err := client.GetSnapshot(mergeBaseID)
	if err != nil {
		return &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}, nil
	}
	baseJSON, err := client.DownloadManifest(baseSnap.ManifestHash)
	if err != nil {
		return &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}, nil
	}
	return manifest.FromJSON(baseJSON)
}

func buildSyncConflictContext(conflicts []mergeAction) string {
	lines := []string{"Conflicting files:"}
	for _, c := range conflicts {
		lines = append(lines, "- "+c.path)
	}
	return strings.Join(lines, "\n")
}
