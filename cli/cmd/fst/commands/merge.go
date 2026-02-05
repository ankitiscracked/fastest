package commands

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newMergeCmd()) })
}

// ConflictMode determines how conflicts are resolved
type ConflictMode int

const (
	ConflictModeAgent  ConflictMode = iota // Use AI agent (default)
	ConflictModeManual                     // Write conflict markers
	ConflictModeTheirs                     // Take source version
	ConflictModeOurs                       // Keep target version
)

func newMergeCmd() *cobra.Command {
	var manual bool
	var theirs bool
	var ours bool
	var dryRun bool
	var dryRunSummary bool
	var fromPath string
	var noPreSnapshot bool
	var force bool
	var abort bool

	cmd := &cobra.Command{
		Use:   "merge [workspace]",
		Short: "Merge changes from another workspace",
		Long: `Merge changes from another workspace into the current one.

This performs a three-way merge:
1. BASE: The common ancestor snapshot
2. CURRENT: Your current workspace (latest snapshot)
3. SOURCE: The workspace you're merging from (latest snapshot)

Merge inputs are snapshot-based (working trees are not used). The merge
aborts if it would overwrite local uncommitted changes in the target.

Non-conflicting changes are applied automatically. For conflicts:
- Default: Uses your coding agent (claude, aider, etc.) to intelligently merge
- Manual (--manual): Creates conflict markers for you to resolve
- Theirs (--theirs): Take source version for all conflicts
- Ours (--ours): Keep current version for all conflicts

Use --dry-run to preview the merge and see line-level conflict details.
By default, a pre-merge snapshot is created only if the target has local changes.
After a successful conflict-free merge, a snapshot is created automatically.

Workspace lookup uses the local registry. Use --from for explicit path.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if abort {
				return runMergeAbort()
			}
			// Validate mutually exclusive options
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
			if workspaceName == "" && fromPath == "" {
				return fmt.Errorf("must specify workspace name or --from path")
			}
			return runMerge(workspaceName, fromPath, mode, dryRun, dryRunSummary, noPreSnapshot, force)
		},
	}

	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take source version for all conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep current version for all conflicts")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Preview merge with line-level conflict details")
	cmd.Flags().BoolVar(&dryRunSummary, "agent-summary", false, "Generate LLM summary of conflicts (with --dry-run)")
	cmd.Flags().StringVar(&fromPath, "from", "", "Source workspace path")
	cmd.Flags().BoolVar(&noPreSnapshot, "no-pre-snapshot", false, "Skip pre-merge snapshot (only created if dirty)")
	cmd.Flags().BoolVar(&force, "force", false, "Allow merge without a common base (two-way merge)")
	cmd.Flags().BoolVar(&abort, "abort", false, "Abort an in-progress merge (clears pending merge state)")

	return cmd
}

func runMergeAbort() error {
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	if err := config.ClearPendingMergeParentsAt(root); err != nil {
		return fmt.Errorf("failed to clear merge state: %w", err)
	}

	fmt.Println("Merge state cleared.")
	return nil
}

// MergeResult tracks the result of a merge operation
type MergeResult struct {
	Applied    []string // Files applied without conflict
	Conflicts  []string // Files with conflicts
	Skipped    []string // Files skipped (files filter)
	Failed     []string // Files that failed to merge
	AgentUsed  bool
	ManualMode bool
}

func runMerge(sourceName string, fromPath string, mode ConflictMode, dryRun bool, dryRunSummary bool, noPreSnapshot bool, force bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	currentRoot, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var sourceRoot string
	var sourceDisplayName string

	// If --from path is specified, use it directly
	if fromPath != "" {
		// Resolve to absolute path
		if !filepath.IsAbs(fromPath) {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			fromPath = filepath.Join(cwd, fromPath)
		}
		sourceRoot = fromPath

		// Try to read source workspace name from config
		sourceConfigPath := filepath.Join(sourceRoot, ".fst", "config.json")
		if data, err := os.ReadFile(sourceConfigPath); err == nil {
			var sourceCfg config.ProjectConfig
			if json.Unmarshal(data, &sourceCfg) == nil && sourceCfg.WorkspaceName != "" {
				sourceDisplayName = sourceCfg.WorkspaceName
			}
		}
		if sourceDisplayName == "" {
			sourceDisplayName = filepath.Base(sourceRoot)
		}
	} else {
		// Look up workspace from local registry first
		registry, err := LoadRegistry()
		if err != nil {
			return fmt.Errorf("failed to load workspace registry: %w", err)
		}

		var found *RegisteredWorkspace
		if w, ok, err := resolveWorkspaceFromRegistry(sourceName, registry.Workspaces, cfg.ProjectID); err != nil {
			return err
		} else if ok {
			found = w
		}

		if found == nil {
			// Try cloud as fallback
			token, err := deps.AuthGetToken()
			if err != nil {
				fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
			} else if token != "" {
				client := deps.NewAPIClient(token, cfg)
				_, cloudWorkspaces, err := client.GetProject(cfg.ProjectID)
				if err == nil {
					ws, err := resolveWorkspaceFromAPI(sourceName, cloudWorkspaces)
					if err != nil {
						if !strings.Contains(err.Error(), "not found") {
							return err
						}
					} else if ws.LocalPath != nil && *ws.LocalPath != "" {
						sourceRoot = *ws.LocalPath
						sourceDisplayName = ws.Name
					}
				}
			}

			if sourceRoot == "" {
				return fmt.Errorf("workspace '%s' not found\nUse --from <path> to specify path directly, or run 'fst workspaces' to see available workspaces", sourceName)
			}
		} else {
			sourceRoot = found.Path
			sourceDisplayName = found.Name
		}
	}

	// Verify source path exists
	if _, err := os.Stat(sourceRoot); os.IsNotExist(err) {
		return fmt.Errorf("source workspace path does not exist: %s", sourceRoot)
	}

	// Load source workspace config
	sourceCfg, err := config.LoadAt(sourceRoot)
	if err != nil {
		return fmt.Errorf("failed to load source workspace config: %w", err)
	}

	fmt.Printf("Merging from: %s (%s)\n", sourceDisplayName, sourceRoot)
	fmt.Printf("Into:         %s (%s)\n", cfg.WorkspaceName, currentRoot)
	fmt.Println()

	token, err := deps.AuthGetToken()
	if err != nil {
		fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
	} else if token != "" {
		client := deps.NewAPIClient(token, cfg)
		warnIfRemoteHeadDiff("target", client, cfg, currentRoot)
		warnIfRemoteHeadDiff("source", client, sourceCfg, sourceRoot)
	}

	currentSnapshotID := cfg.CurrentSnapshotID
	if currentSnapshotID == "" {
		currentSnapshotID, err = config.GetLatestSnapshotIDAt(currentRoot)
		if err != nil {
			return fmt.Errorf("failed to determine latest snapshot for current workspace: %w", err)
		}
	}
	if currentSnapshotID == "" {
		return fmt.Errorf("current workspace has no snapshots - run 'fst snapshot' before merging")
	}
	currentManifest, err := loadManifestByID(currentRoot, currentSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to load current snapshot manifest: %w", err)
	}

	sourceSnapshotID := sourceCfg.CurrentSnapshotID
	if sourceSnapshotID == "" {
		sourceSnapshotID, err = config.GetLatestSnapshotIDAt(sourceRoot)
		if err != nil {
			return fmt.Errorf("failed to determine latest snapshot for source workspace: %w", err)
		}
	}
	if sourceSnapshotID == "" {
		return fmt.Errorf("source workspace has no snapshots - run 'fst snapshot' before merging")
	}
	sourceManifest, err := loadManifestByID(sourceRoot, sourceSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to load source snapshot manifest: %w", err)
	}

	// Determine merge base (common ancestor) from snapshot DAG
	mergeBaseID, err := dag.GetMergeBase(currentRoot, sourceRoot, currentSnapshotID, sourceSnapshotID)
	var baseManifest *manifest.Manifest
	if err != nil {
		if !force {
			return fmt.Errorf("could not determine merge base: %w\nRun 'fst snapshot' in both workspaces or re-run with --force for a two-way merge", err)
		}
		fmt.Printf("Warning: Could not determine merge base: %v\n", err)
		fmt.Println("Proceeding without three-way merge (will treat all changes as additions)")
		baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
	} else {
		// Try to load from current workspace's manifests first, then source's
		baseManifest, err = loadManifestByID(currentRoot, mergeBaseID)
		if err != nil {
			// Try source workspace's manifests
			baseManifest, err = loadManifestByID(sourceRoot, mergeBaseID)
		}
		if err != nil {
			fmt.Printf("Warning: Could not load base snapshot %s: %v\n", mergeBaseID, err)
			fmt.Println("Proceeding without three-way merge (will treat all changes as additions)")
			baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
		} else {
			fmt.Printf("Using merge base: %s\n", mergeBaseID)
		}
	}

	// Compute three-way diff
	fmt.Println("Computing differences...")
	mergeActions := computeMergeActions(baseManifest, currentManifest, sourceManifest)

	// Abort if merge would overwrite local uncommitted changes in target (git-like behavior)
	workingManifest, err := manifest.Generate(currentRoot, false)
	if err != nil {
		return fmt.Errorf("failed to scan current workspace: %w", err)
	}
	added, modified, deleted := manifest.Diff(currentManifest, workingManifest)
	dirtyPaths := make(map[string]struct{})
	for _, p := range added {
		dirtyPaths[p] = struct{}{}
	}
	for _, p := range modified {
		dirtyPaths[p] = struct{}{}
	}
	for _, p := range deleted {
		dirtyPaths[p] = struct{}{}
	}
	if len(dirtyPaths) > 0 {
		mergeTouched := make(map[string]struct{})
		for _, a := range mergeActions.toApply {
			mergeTouched[a.path] = struct{}{}
		}
		for _, a := range mergeActions.conflicts {
			mergeTouched[a.path] = struct{}{}
		}
		var overlaps []string
		for p := range dirtyPaths {
			if _, ok := mergeTouched[p]; ok {
				overlaps = append(overlaps, p)
			}
		}
		if len(overlaps) > 0 {
			preview := overlaps
			if len(preview) > 5 {
				preview = preview[:5]
			}
			return fmt.Errorf("merge would overwrite local changes in %d file(s): %s\nRun 'fst snapshot' or clean your working tree before merging", len(overlaps), strings.Join(preview, ", "))
		}
		fmt.Printf("Warning: current workspace has uncommitted changes in %d file(s) not touched by this merge.\n", len(dirtyPaths))
	}

	// Display summary
	fmt.Println()
	fmt.Printf("Merge plan:\n")
	fmt.Printf("  Apply from source:  %d files\n", len(mergeActions.toApply))
	fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
	fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))
	fmt.Println()

	if len(mergeActions.toApply) == 0 && len(mergeActions.conflicts) == 0 {
		fmt.Println("✓ Nothing to merge - workspaces are in sync")
		return nil
	}

	// Create auto-snapshot before merge only if there are dirty changes (unless dry-run or --no-pre-snapshot)
	if !dryRun && !noPreSnapshot && len(dirtyPaths) > 0 {
		snapshotID, err := CreateAutoSnapshot(fmt.Sprintf("Before merge from %s", sourceDisplayName))
		if err != nil {
			fmt.Printf("Warning: Could not create pre-merge snapshot: %v\n", err)
		} else if snapshotID != "" {
			fmt.Printf("Created snapshot %s (use 'fst rollback' to undo merge)\n", snapshotID)
			fmt.Println()
		}
	}

	if dryRun {
		printMergePlan(mergeActions)

		// Show line-level conflict details if there are conflicts
		if len(mergeActions.conflicts) > 0 {
			fmt.Println()
			fmt.Println("Conflict details:")
			conflictReport, err := conflicts.Detect(currentRoot, sourceRoot, true)
			if err != nil {
				fmt.Printf("  (Could not analyze conflicts: %v)\n", err)
			} else if conflictReport.TrueConflicts > 0 {
				for _, c := range conflictReport.Conflicts {
					fmt.Printf("\n  \033[31m%s\033[0m (%d conflicting regions)\n", c.Path, len(c.Hunks))
					for i, h := range c.Hunks {
						if h.EndLine > h.StartLine {
							fmt.Printf("    Region %d: lines %d-%d\n", i+1, h.StartLine, h.EndLine)
						} else {
							fmt.Printf("    Region %d: line %d\n", i+1, h.StartLine)
						}
						// Show previews of conflicting content
						if len(h.CurrentLines) > 0 {
							fmt.Printf("      Current: %s", truncatePreview(h.CurrentLines[0], 60))
							if len(h.CurrentLines) > 1 {
								fmt.Printf(" (+%d more lines)", len(h.CurrentLines)-1)
							}
							fmt.Println()
						}
						if len(h.SourceLines) > 0 {
							fmt.Printf("      Source:  %s", truncatePreview(h.SourceLines[0], 60))
							if len(h.SourceLines) > 1 {
								fmt.Printf(" (+%d more lines)", len(h.SourceLines)-1)
							}
							fmt.Println()
						}
					}
				}

				// Show auto-mergeable files
				autoMergeCount := len(conflictReport.OverlappingFiles) - conflictReport.TrueConflicts
				if autoMergeCount > 0 {
					fmt.Println()
					fmt.Printf("Files modified in both (auto-mergeable): %d\n", autoMergeCount)
				}

				// Generate LLM summary if requested
				if dryRunSummary {
					preferredAgent, err := agent.GetPreferredAgent()
					if err != nil {
						fmt.Printf("\nWarning: %v\n", err)
					} else {
						fmt.Printf("\nGenerating summary with %s...\n", preferredAgent.Name)
						conflictInfos := buildConflictInfosFromReport(conflictReport)
						conflictContext := agent.BuildConflictContext(conflictInfos)
						summaryText, err := agent.InvokeConflictSummary(preferredAgent, conflictContext)
						if err != nil {
							fmt.Printf("Warning: Failed to generate summary: %v\n", err)
						} else {
							fmt.Printf("\nSummary:\n  %s\n", summaryText)
						}
					}
				}
			} else {
				fmt.Println("  Files are modified in both workspaces but changes don't overlap.")
				fmt.Println("  These can be auto-merged.")
			}
		}

		fmt.Println()
		fmt.Println("(Dry run - no changes made)")
		fmt.Println()
		fmt.Println("To merge:")
		if len(mergeActions.conflicts) > 0 {
			fmt.Printf("  fst merge %s          # Let AI resolve conflicts\n", sourceName)
			fmt.Printf("  fst merge %s --manual  # Create conflict markers\n", sourceName)
			fmt.Printf("  fst merge %s --theirs  # Take their version for conflicts\n", sourceName)
			fmt.Printf("  fst merge %s --ours    # Keep your version for conflicts\n", sourceName)
		} else {
			fmt.Printf("  fst merge %s\n", sourceName)
		}
		return nil
	}

	result := &MergeResult{
		AgentUsed:  mode == ConflictModeAgent,
		ManualMode: mode == ConflictModeManual,
	}

	// Apply non-conflicting changes
	if len(mergeActions.toApply) > 0 {
		fmt.Println("Applying non-conflicting changes...")
		for _, action := range mergeActions.toApply {
			if err := applyChange(currentRoot, sourceRoot, action); err != nil {
				fmt.Printf("  ✗ %s: %v\n", action.path, err)
				result.Failed = append(result.Failed, action.path)
			} else {
				fmt.Printf("  ✓ %s\n", action.path)
				result.Applied = append(result.Applied, action.path)
			}
		}
		fmt.Println()
	}

	// Handle conflicts
	if len(mergeActions.conflicts) > 0 {
		switch mode {
		case ConflictModeAgent:
			fmt.Println("Resolving conflicts with agent...")
			preferredAgent, err := agent.GetPreferredAgent()
			if err != nil {
				fmt.Printf("Warning: %v\n", err)
				fmt.Println("Falling back to manual conflict markers...")
				mode = ConflictModeManual
			} else {
				fmt.Printf("Using %s for conflict resolution...\n", preferredAgent.Name)
				for _, conflict := range mergeActions.conflicts {
					if err := resolveConflictWithAgent(currentRoot, sourceRoot, conflict, preferredAgent, baseManifest); err != nil {
						fmt.Printf("  ✗ %s: %v (creating conflict markers)\n", conflict.path, err)
						// Fall back to manual for this file
						if err := createConflictMarkers(currentRoot, sourceRoot, conflict); err != nil {
							result.Failed = append(result.Failed, conflict.path)
						} else {
							result.Conflicts = append(result.Conflicts, conflict.path)
						}
					} else {
						fmt.Printf("  ✓ %s (merged by agent)\n", conflict.path)
						result.Applied = append(result.Applied, conflict.path)
					}
				}
			}

		case ConflictModeTheirs:
			fmt.Println("Taking source version for all conflicts...")
			for _, conflict := range mergeActions.conflicts {
				if err := applyChange(currentRoot, sourceRoot, conflict); err != nil {
					fmt.Printf("  ✗ %s: %v\n", conflict.path, err)
					result.Failed = append(result.Failed, conflict.path)
				} else {
					fmt.Printf("  ✓ %s (took theirs)\n", conflict.path)
					result.Applied = append(result.Applied, conflict.path)
				}
			}

		case ConflictModeOurs:
			fmt.Println("Keeping local version for all conflicts...")
			for _, conflict := range mergeActions.conflicts {
				fmt.Printf("  ✓ %s (kept ours)\n", conflict.path)
				result.Applied = append(result.Applied, conflict.path)
			}
		}

		// Handle manual mode (or fallback from agent)
		if mode == ConflictModeManual {
			fmt.Println("Creating conflict markers for manual resolution...")
			for _, conflict := range mergeActions.conflicts {
				if err := createConflictMarkers(currentRoot, sourceRoot, conflict); err != nil {
					fmt.Printf("  ✗ %s: %v\n", conflict.path, err)
					result.Failed = append(result.Failed, conflict.path)
				} else {
					fmt.Printf("  ⚠ %s (needs manual resolution)\n", conflict.path)
					result.Conflicts = append(result.Conflicts, conflict.path)
				}
			}
		}
		fmt.Println()
	}

	mergeParents := normalizeMergeParents(currentSnapshotID, sourceSnapshotID)
	if !dryRun && len(mergeParents) >= 2 && len(result.Failed) == 0 && (len(result.Applied) > 0 || len(result.Conflicts) > 0) {
		if err := config.WritePendingMergeParentsAt(currentRoot, mergeParents); err != nil {
			fmt.Printf("Warning: Could not record merge parents: %v\n", err)
		}
	}
	if !dryRun && len(result.Failed) > 0 {
		if err := config.ClearPendingMergeParentsAt(currentRoot); err != nil {
			fmt.Printf("Warning: Could not clear pending merge parents: %v\n", err)
		} else {
			fmt.Println("Warning: Merge had failures; merge parents were not recorded.")
		}
	}

	autoSnapshotFailed := false
	autoSnapshotSucceeded := false
	if !dryRun && len(result.Conflicts) == 0 && len(result.Failed) == 0 && len(result.Applied) > 0 {
		if err := runSnapshot(fmt.Sprintf("Merged %s", sourceDisplayName), false); err != nil {
			autoSnapshotFailed = true
			fmt.Printf("Warning: Could not create post-merge snapshot: %v\n", err)
		} else {
			autoSnapshotSucceeded = true
		}
	}

	// Summary
	fmt.Println("Merge complete:")
	fmt.Printf("  ✓ Applied:   %d files\n", len(result.Applied))
	if len(result.Conflicts) > 0 {
		fmt.Printf("  ⚠ Conflicts: %d files (need resolution)\n", len(result.Conflicts))
	}
	if len(result.Failed) > 0 {
		fmt.Printf("  ✗ Failed:    %d files\n", len(result.Failed))
	}

	if len(result.Conflicts) > 0 {
		fmt.Println()
		fmt.Println("To resolve conflicts manually:")
		fmt.Println("  1. Edit the conflicting files (look for <<<<<<< markers)")
		fmt.Println("  2. Remove the conflict markers")
		fmt.Println("  3. Run 'fst snapshot' to save the merged state")
	} else if len(result.Applied) > 0 && autoSnapshotFailed {
		fmt.Println()
		fmt.Printf("Run 'fst snapshot -m \"Merged %s\"' to save.\n", sourceDisplayName)
	}

	if autoSnapshotSucceeded {
		if refreshed, err := config.LoadAt(currentRoot); err == nil {
			cfg = refreshed
		} else {
			fmt.Printf("Warning: Could not reload config after merge snapshot: %v\n", err)
		}
	}

	return nil
}

func normalizeMergeParents(parents ...string) []string {
	seen := make(map[string]struct{}, len(parents))
	out := make([]string, 0, len(parents))
	for _, p := range parents {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

// MergeAction represents a single file merge action
type mergeAction struct {
	path        string
	actionType  string // "apply", "conflict", "skip", "in_sync"
	currentHash string
	sourceHash  string
	baseHash    string
	sourceMode  uint32
}

// MergeActions holds all computed merge actions
type mergeActions struct {
	toApply   []mergeAction
	conflicts []mergeAction
	inSync    []mergeAction
	skipped   []mergeAction
}

func computeMergeActions(base, current, source *manifest.Manifest) *mergeActions {
	result := &mergeActions{}

	// Build lookup maps
	baseFiles := make(map[string]manifest.FileEntry)
	for _, f := range base.FileEntries() {
		baseFiles[f.Path] = f
	}

	currentFiles := make(map[string]manifest.FileEntry)
	for _, f := range current.FileEntries() {
		currentFiles[f.Path] = f
	}

	sourceFiles := make(map[string]manifest.FileEntry)
	for _, f := range source.FileEntries() {
		sourceFiles[f.Path] = f
	}

	// Collect all unique paths
	allPaths := make(map[string]bool)
	for path := range baseFiles {
		allPaths[path] = true
	}
	for path := range currentFiles {
		allPaths[path] = true
	}
	for path := range sourceFiles {
		allPaths[path] = true
	}

	for path := range allPaths {
		baseFile, inBase := baseFiles[path]
		currentFile, inCurrent := currentFiles[path]
		sourceFile, inSource := sourceFiles[path]

		action := mergeAction{
			path: path,
		}

		if inBase {
			action.baseHash = baseFile.Hash
		}
		if inCurrent {
			action.currentHash = currentFile.Hash
		}
		if inSource {
			action.sourceHash = sourceFile.Hash
			action.sourceMode = sourceFile.Mode
		}

		// Determine action based on three-way comparison
		currentChanged := !inBase && inCurrent || (inBase && inCurrent && baseFile.Hash != currentFile.Hash)
		sourceChanged := !inBase && inSource || (inBase && inSource && baseFile.Hash != sourceFile.Hash)
		currentDeleted := inBase && !inCurrent
		sourceDeleted := inBase && !inSource

		switch {
		case !inSource && !sourceDeleted:
			// File only exists in current or was deleted in source but we have it
			// Nothing to merge from source
			continue

		case !inCurrent && inSource:
			// File only in source (added in source) - apply
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)

		case currentDeleted && inSource:
			// We deleted, source has it - conflict (or apply source?)
			// Treat as conflict - let user decide
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)

		case sourceDeleted && inCurrent:
			// Source deleted, we have it - keep ours (no action needed)
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case inCurrent && inSource && currentFile.Hash == sourceFile.Hash:
			// Same content - in sync
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case !currentChanged && sourceChanged:
			// Only source changed - apply
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)

		case currentChanged && !sourceChanged:
			// Only current changed - keep ours (already have it)
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case currentChanged && sourceChanged:
			// Both changed - conflict
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)

		default:
			// No changes
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		}
	}

	return result
}

func printMergePlan(actions *mergeActions) {
	if len(actions.toApply) > 0 {
		fmt.Println("Will apply from source:")
		for _, a := range actions.toApply {
			fmt.Printf("  + %s\n", a.path)
		}
	}

	if len(actions.conflicts) > 0 {
		fmt.Println("Conflicts to resolve:")
		for _, a := range actions.conflicts {
			fmt.Printf("  ! %s\n", a.path)
		}
	}
}

func readSnapshotContent(root, relPath, expectedHash string, mode uint32) ([]byte, os.FileMode, error) {
	if expectedHash == "" {
		return nil, 0, os.ErrNotExist
	}

	// Prefer global blob cache.
	if blobDir, err := config.GetGlobalBlobDir(); err == nil {
		blobPath := filepath.Join(blobDir, expectedHash)
		if data, err := os.ReadFile(blobPath); err == nil {
			return data, fileModeOrDefault(mode, 0644), nil
		}
	}

	// Fallback to reading from the workspace and verifying hash.
	sourcePath := filepath.Join(root, relPath)
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return nil, 0, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expectedHash {
		return nil, 0, fmt.Errorf("source file does not match snapshot (dirty)")
	}

	m := fileModeOrDefault(mode, 0)
	if m == 0 {
		if info, err := os.Stat(sourcePath); err == nil {
			m = info.Mode()
		} else {
			m = 0644
		}
	}

	return data, m, nil
}

func fileModeOrDefault(mode uint32, fallback os.FileMode) os.FileMode {
	if mode == 0 {
		return fallback
	}
	return os.FileMode(mode)
}

func applyChange(currentRoot, sourceRoot string, action mergeAction) error {
	currentPath := filepath.Join(currentRoot, action.path)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(currentPath), 0755); err != nil {
		return err
	}

	// Read source file content from snapshot
	content, mode, err := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)
	if err != nil {
		return fmt.Errorf("failed to read source snapshot: %w", err)
	}

	// Write to current
	if err := os.WriteFile(currentPath, content, mode); err != nil {
		return fmt.Errorf("failed to write: %w", err)
	}

	return nil
}

func resolveConflictWithAgent(currentRoot, sourceRoot string, action mergeAction, ag *agent.Agent, baseManifest *manifest.Manifest) error {
	currentPath := filepath.Join(currentRoot, action.path)

	// Read current content
	currentContent, err := os.ReadFile(currentPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read current: %w", err)
	}

	// Read source content from snapshot
	sourceContent, _, err := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read source snapshot: %w", err)
	}

	// Try to get base content from global blob cache
	var baseContent []byte
	if action.baseHash != "" {
		blobDir, err := config.GetGlobalBlobDir()
		if err == nil {
			blobPath := filepath.Join(blobDir, action.baseHash)
			baseContent, _ = os.ReadFile(blobPath) // Ignore error, may not exist
		}
	}

	// Invoke agent to merge
	mergeResult, err := agent.InvokeMerge(ag,
		string(baseContent),
		string(currentContent),
		string(sourceContent),
		action.path,
	)
	if err != nil {
		return err
	}

	// Display strategy
	if len(mergeResult.Strategy) > 0 {
		fmt.Printf("    Strategy:\n")
		for _, bullet := range mergeResult.Strategy {
			fmt.Printf("      • %s\n", bullet)
		}
	}

	// Show diff of what changed
	showMergeDiff(string(currentContent), mergeResult.MergedCode)

	// Write merged content
	mode := fileModeOrDefault(action.sourceMode, 0)
	if mode == 0 {
		if info, err := os.Stat(currentPath); err == nil {
			mode = info.Mode()
		} else {
			mode = 0644
		}
	}

	if err := os.WriteFile(currentPath, []byte(mergeResult.MergedCode), mode); err != nil {
		return fmt.Errorf("failed to write merged: %w", err)
	}

	return nil
}

// showMergeDiff displays a compact diff of what the agent changed
func showMergeDiff(before, after string) {
	beforeLines := strings.Split(before, "\n")
	afterLines := strings.Split(after, "\n")

	// Simple line-based diff display (show first few changes)
	fmt.Printf("    Diff:\n")

	changes := 0
	maxChanges := 10 // Limit output

	i, j := 0, 0
	for i < len(beforeLines) && j < len(afterLines) && changes < maxChanges {
		if beforeLines[i] == afterLines[j] {
			i++
			j++
			continue
		}

		// Found a difference
		if i < len(beforeLines) {
			line := truncatePreview(beforeLines[i], 60)
			fmt.Printf("      \033[31m- %s\033[0m\n", line)
			i++
			changes++
		}
		if j < len(afterLines) && changes < maxChanges {
			line := truncatePreview(afterLines[j], 60)
			fmt.Printf("      \033[32m+ %s\033[0m\n", line)
			j++
			changes++
		}
	}

	// Handle remaining lines
	for i < len(beforeLines) && changes < maxChanges {
		line := truncatePreview(beforeLines[i], 60)
		fmt.Printf("      \033[31m- %s\033[0m\n", line)
		i++
		changes++
	}
	for j < len(afterLines) && changes < maxChanges {
		line := truncatePreview(afterLines[j], 60)
		fmt.Printf("      \033[32m+ %s\033[0m\n", line)
		j++
		changes++
	}

	remaining := (len(beforeLines) - i) + (len(afterLines) - j)
	if remaining > 0 || changes >= maxChanges {
		fmt.Printf("      ... (%d more changes)\n", remaining)
	}
}

func createConflictMarkers(currentRoot, sourceRoot string, action mergeAction) error {
	currentPath := filepath.Join(currentRoot, action.path)

	// Read both versions
	currentContent, currentErr := os.ReadFile(currentPath)
	sourceContent, _, sourceErr := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)

	if currentErr != nil && sourceErr != nil {
		return fmt.Errorf("cannot read either version")
	}

	// Build conflict content
	var result strings.Builder

	result.WriteString("<<<<<<< CURRENT (this workspace)\n")
	if currentErr == nil {
		result.Write(currentContent)
		if len(currentContent) > 0 && currentContent[len(currentContent)-1] != '\n' {
			result.WriteString("\n")
		}
	} else {
		result.WriteString("(file does not exist in current)\n")
	}

	result.WriteString("=======\n")

	if sourceErr == nil {
		result.Write(sourceContent)
		if len(sourceContent) > 0 && sourceContent[len(sourceContent)-1] != '\n' {
			result.WriteString("\n")
		}
	} else {
		result.WriteString("(file does not exist in source)\n")
	}

	result.WriteString(">>>>>>> SOURCE (merging from)\n")

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(currentPath), 0755); err != nil {
		return err
	}

	// Write conflict file
	if err := os.WriteFile(currentPath, []byte(result.String()), 0644); err != nil {
		return err
	}

	return nil
}

func loadBaseManifest(cfg *config.ProjectConfig) (*manifest.Manifest, error) {
	if cfg.BaseSnapshotID == "" {
		return nil, fmt.Errorf("no base snapshot")
	}

	manifestsDir, err := config.GetManifestsDir()
	if err != nil {
		return nil, err
	}

	manifestHash, err := config.ManifestHashFromSnapshotID(cfg.BaseSnapshotID)
	if err != nil {
		return nil, err
	}
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("snapshot not in local snapshots: %w", err)
	}

	return manifest.FromJSON(data)
}

func warnIfRemoteHeadDiff(label string, client *api.Client, cfg *config.ProjectConfig, root string) {
	if cfg == nil || cfg.WorkspaceID == "" {
		return
	}

	remoteWs, err := client.GetWorkspace(cfg.WorkspaceID)
	if err != nil || remoteWs.CurrentSnapshotID == nil || *remoteWs.CurrentSnapshotID == "" {
		return
	}

	localHead := cfg.CurrentSnapshotID
	if localHead == "" {
		if latest, err := config.GetLatestSnapshotIDAt(root); err == nil {
			localHead = latest
		}
	}

	if localHead == "" || localHead == *remoteWs.CurrentSnapshotID {
		return
	}

	fmt.Printf("Warning: %s workspace has remote changes not in this local copy (remote %s, local %s).\n", label, *remoteWs.CurrentSnapshotID, localHead)
	fmt.Printf("         Run 'fst sync' in the %s workspace before merging to avoid missing changes.\n", label)
}

// loadManifestByID loads a manifest from the manifests directory by snapshot ID
func loadManifestByID(root, snapshotID string) (*manifest.Manifest, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, snapshotID)
	if err != nil {
		return nil, err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("snapshot manifest not found: %w", err)
	}

	return manifest.FromJSON(data)
}

// truncatePreview shortens a string for preview display
func truncatePreview(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		return s[:maxLen-3] + "..."
	}
	return s
}

// buildConflictInfosFromReport converts conflicts.Report to agent.ConflictInfo slice
func buildConflictInfosFromReport(report *conflicts.Report) []agent.ConflictInfo {
	var infos []agent.ConflictInfo

	for _, c := range report.Conflicts {
		info := agent.ConflictInfo{
			Path:      c.Path,
			HunkCount: len(c.Hunks),
		}

		for _, h := range c.Hunks {
			hunkInfo := agent.HunkInfo{
				StartLine: h.StartLine,
				EndLine:   h.EndLine,
			}

			// Add previews (limit to first 5 lines each)
			if len(h.CurrentLines) > 0 {
				limit := 5
				if len(h.CurrentLines) < limit {
					limit = len(h.CurrentLines)
				}
				hunkInfo.CurrentPreview = h.CurrentLines[:limit]
			}
			if len(h.SourceLines) > 0 {
				limit := 5
				if len(h.SourceLines) < limit {
					limit = len(h.SourceLines)
				}
				hunkInfo.SourcePreview = h.SourceLines[:limit]
			}

			info.Hunks = append(info.Hunks, hunkInfo)
		}

		infos = append(infos, info)
	}

	return infos
}
