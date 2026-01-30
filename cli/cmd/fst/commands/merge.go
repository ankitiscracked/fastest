package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/drift"
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
	var useAgent bool
	var manual bool
	var theirs bool
	var ours bool
	var cherryPick []string
	var dryRun bool
	var dryRunSummary bool
	var fromPath string
	var mergeAll bool
	var showPlan bool
	var noSnapshot bool

	cmd := &cobra.Command{
		Use:   "merge [workspace]",
		Short: "Merge changes from another workspace",
		Long: `Merge changes from another workspace into the current one.

This performs a three-way merge:
1. BASE: The common ancestor snapshot
2. CURRENT: Your current workspace (where you're running the command)
3. SOURCE: The workspace you're merging from

Non-conflicting changes are applied automatically. For conflicts:
- Default (--agent): Uses your coding agent (claude, aider, etc.) to intelligently merge
- Manual (--manual): Creates conflict markers for you to resolve
- Theirs (--theirs): Take source version for all conflicts
- Ours (--ours): Keep current version for all conflicts

Use --dry-run to preview the merge and see line-level conflict details.
Use --all to merge all workspaces in the project (non-conflicting first).
Use --plan to analyze all workspaces and suggest optimal merge order.

Workspace lookup uses the local registry. Use --from for explicit path.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			// Validate mutually exclusive options
			modeCount := 0
			if useAgent {
				modeCount++
			}
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
				return fmt.Errorf("only one of --agent, --manual, --theirs, --ours can be specified")
			}

			mode := ConflictModeAgent // default
			if manual {
				mode = ConflictModeManual
			} else if theirs {
				mode = ConflictModeTheirs
			} else if ours {
				mode = ConflictModeOurs
			}

			// Handle --plan mode
			if showPlan {
				if len(args) > 0 {
					return fmt.Errorf("cannot specify workspace with --plan")
				}
				return runMergePlan()
			}

			// Handle --all mode
			if mergeAll {
				if len(args) > 0 {
					return fmt.Errorf("cannot specify workspace with --all")
				}
				return runMergeAll(mode, dryRun, noSnapshot)
			}

			var workspaceName string
			if len(args) > 0 {
				workspaceName = args[0]
			}
			if workspaceName == "" && fromPath == "" {
				return fmt.Errorf("must specify workspace name or --from path")
			}
			return runMerge(workspaceName, fromPath, mode, cherryPick, dryRun, dryRunSummary, noSnapshot)
		},
	}

	cmd.Flags().BoolVar(&useAgent, "agent", false, "Use coding agent for conflict resolution (default)")
	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take source version for all conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep current version for all conflicts")
	cmd.Flags().StringSliceVar(&cherryPick, "files", nil, "Only merge specific files")
	cmd.Flags().StringSliceVar(&cherryPick, "cherry-pick", nil, "Only merge specific files (alias for --files)")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Preview merge with line-level conflict details")
	cmd.Flags().BoolVar(&dryRunSummary, "summary", false, "Generate LLM summary of conflicts (with --dry-run)")
	cmd.Flags().StringVar(&fromPath, "from", "", "Source workspace path")
	cmd.Flags().BoolVarP(&mergeAll, "all", "a", false, "Merge all workspaces in the project")
	cmd.Flags().BoolVar(&showPlan, "plan", false, "Analyze workspaces and suggest optimal merge order")
	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Skip auto-snapshot before merge")

	return cmd
}

// MergeResult tracks the result of a merge operation
type MergeResult struct {
	Applied    []string // Files applied without conflict
	Conflicts  []string // Files with conflicts
	Skipped    []string // Files skipped (cherry-pick filter)
	Failed     []string // Files that failed to merge
	AgentUsed  bool
	ManualMode bool
}

func runMerge(sourceName string, fromPath string, mode ConflictMode, cherryPick []string, dryRun bool, dryRunSummary bool, noSnapshot bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
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
		for _, w := range registry.Workspaces {
			if (w.Name == sourceName || w.ID == sourceName) && w.ProjectID == cfg.ProjectID {
				wCopy := w
				found = &wCopy
				break
			}
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
					for _, ws := range cloudWorkspaces {
						if ws.Name == sourceName || ws.ID == sourceName {
							if ws.LocalPath != nil && *ws.LocalPath != "" {
								sourceRoot = *ws.LocalPath
								sourceDisplayName = ws.Name
								break
							}
						}
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

	// Determine merge base (common ancestor) using merge history and relationships
	mergeBaseID, err := getMergeBase(cfg, sourceCfg, currentRoot, sourceRoot)
	var baseManifest *manifest.Manifest
	if err != nil {
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
			fmt.Printf("Warning: Could not load fork snapshot %s: %v\n", mergeBaseID, err)
			fmt.Println("Proceeding without three-way merge (will treat all changes as additions)")
			baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
		} else {
			fmt.Printf("Using merge base: %s\n", mergeBaseID)
		}
	}

	// Generate manifests for local and remote
	fmt.Println("Scanning local workspace...")
	currentManifest, err := manifest.Generate(currentRoot, false)
	if err != nil {
		return fmt.Errorf("failed to scan local workspace: %w", err)
	}

	fmt.Println("Scanning source workspace...")
	sourceManifest, err := manifest.Generate(sourceRoot, false)
	if err != nil {
		return fmt.Errorf("failed to scan source workspace: %w", err)
	}

	// Compute three-way diff
	fmt.Println("Computing differences...")
	mergeActions := computeMergeActions(baseManifest, currentManifest, sourceManifest, cherryPick)

	// Display summary
	fmt.Println()
	fmt.Printf("Merge plan:\n")
	fmt.Printf("  Apply from source:  %d files\n", len(mergeActions.toApply))
	fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
	fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))
	if len(cherryPick) > 0 {
		fmt.Printf("  Skipped (filter):   %d files\n", len(mergeActions.skipped))
	}
	fmt.Println()

	if len(mergeActions.toApply) == 0 && len(mergeActions.conflicts) == 0 {
		fmt.Println("✓ Nothing to merge - workspaces are in sync")
		return nil
	}

	// Create auto-snapshot before merge (unless dry-run or --no-snapshot)
	if !dryRun && !noSnapshot {
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
			fmt.Printf("  fst merge %s --agent   # Let AI resolve conflicts\n", sourceName)
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
	} else if len(result.Applied) > 0 {
		fmt.Println()
		fmt.Printf("Run 'fst snapshot -m \"Merged %s\"' to save.\n", sourceDisplayName)
	}

	// Update merge history to track this merge for future three-way merges
	if err := updateMergeHistory(cfg, sourceCfg, sourceRoot); err != nil {
		fmt.Printf("Warning: Could not update merge history: %v\n", err)
	}

	return nil
}

// updateMergeHistory records the merge in the target's config for future merges.
// It also inherits the source's merge history for transitive tracking.
func updateMergeHistory(targetCfg, sourceCfg *config.ProjectConfig, sourceRoot string) error {
	// Get source's latest snapshot ID
	sourceLatestID, err := config.GetLatestSnapshotIDAt(sourceRoot)
	if err != nil || sourceLatestID == "" {
		return fmt.Errorf("could not determine source's latest snapshot")
	}

	// Initialize merge history if needed
	if targetCfg.MergeHistory == nil {
		targetCfg.MergeHistory = make(map[string]config.MergeRecord)
	}

	// Record direct merge from source
	targetCfg.MergeHistory[sourceCfg.WorkspaceID] = config.MergeRecord{
		LastMergedSnapshot: sourceLatestID,
		MergedAt:           time.Now().UTC().Format(time.RFC3339),
	}

	// Inherit source's merge history (transitive tracking)
	// This allows us to know about workspaces that were merged into source
	if sourceCfg.MergeHistory != nil {
		for wsID, record := range sourceCfg.MergeHistory {
			// Only inherit if we don't already have a more recent record
			if existing, ok := targetCfg.MergeHistory[wsID]; !ok {
				targetCfg.MergeHistory[wsID] = record
			} else if record.MergedAt > existing.MergedAt {
				// Source has a more recent merge from this workspace
				targetCfg.MergeHistory[wsID] = record
			}
		}
	}

	// Save updated config
	return config.Save(targetCfg)
}

// MergeAction represents a single file merge action
type mergeAction struct {
	path        string
	actionType  string // "apply", "conflict", "skip", "in_sync"
	currentHash string
	sourceHash  string
	baseHash    string
}

// MergeActions holds all computed merge actions
type mergeActions struct {
	toApply   []mergeAction
	conflicts []mergeAction
	inSync    []mergeAction
	skipped   []mergeAction
}

func computeMergeActions(base, current, source *manifest.Manifest, cherryPick []string) *mergeActions {
	result := &mergeActions{}

	// Build lookup maps
	baseFiles := make(map[string]manifest.FileEntry)
	for _, f := range base.Files {
		baseFiles[f.Path] = f
	}

	currentFiles := make(map[string]manifest.FileEntry)
	for _, f := range current.Files {
		currentFiles[f.Path] = f
	}

	sourceFiles := make(map[string]manifest.FileEntry)
	for _, f := range source.Files {
		sourceFiles[f.Path] = f
	}

	// Build cherry-pick filter
	cherryPickSet := make(map[string]bool)
	for _, f := range cherryPick {
		cherryPickSet[f] = true
	}
	useCherryPick := len(cherryPick) > 0

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
		// Check cherry-pick filter
		if useCherryPick && !cherryPickSet[path] {
			result.skipped = append(result.skipped, mergeAction{path: path, actionType: "skip"})
			continue
		}

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

func applyChange(currentRoot, sourceRoot string, action mergeAction) error {
	sourcePath := filepath.Join(sourceRoot, action.path)
	currentPath := filepath.Join(currentRoot, action.path)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(currentPath), 0755); err != nil {
		return err
	}

	// Read source file
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("failed to read source: %w", err)
	}

	// Get source file mode
	info, err := os.Stat(sourcePath)
	if err != nil {
		return fmt.Errorf("failed to stat source: %w", err)
	}

	// Write to current
	if err := os.WriteFile(currentPath, content, info.Mode()); err != nil {
		return fmt.Errorf("failed to write: %w", err)
	}

	return nil
}

func resolveConflictWithAgent(currentRoot, sourceRoot string, action mergeAction, ag *agent.Agent, baseManifest *manifest.Manifest) error {
	currentPath := filepath.Join(currentRoot, action.path)
	sourcePath := filepath.Join(sourceRoot, action.path)

	// Read current content
	currentContent, err := os.ReadFile(currentPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read current: %w", err)
	}

	// Read source content
	sourceContent, err := os.ReadFile(sourcePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read source: %w", err)
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
	info, err := os.Stat(sourcePath)
	mode := os.FileMode(0644)
	if err == nil {
		mode = info.Mode()
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
	sourcePath := filepath.Join(sourceRoot, action.path)

	// Read both versions
	currentContent, currentErr := os.ReadFile(currentPath)
	sourceContent, sourceErr := os.ReadFile(sourcePath)

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
	if cfg.ForkSnapshotID == "" {
		return nil, fmt.Errorf("no fork snapshot")
	}

	manifestsDir, err := config.GetManifestsDir()
	if err != nil {
		return nil, err
	}

	manifestHash, err := config.ManifestHashFromSnapshotID(cfg.ForkSnapshotID)
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

// snapshotMeta represents snapshot metadata for merge base computation
type snapshotMeta struct {
	ID          string `json:"id"`
	WorkspaceID string `json:"workspace_id"`
	CreatedAt   string `json:"created_at"`
}

// loadSnapshotMetaFromDir loads snapshot metadata from a specific snapshots directory
func loadSnapshotMetaFromDir(snapshotsDir, snapshotID string) (*snapshotMeta, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	metaPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	data, err := os.ReadFile(metaPath)
	if err != nil {
		return nil, fmt.Errorf("snapshot metadata not found: %w", err)
	}

	var meta snapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, fmt.Errorf("failed to parse snapshot metadata: %w", err)
	}
	return &meta, nil
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

// getMergeBase determines the correct fork snapshot for a three-way merge.
// It checks in order:
// 1. Merge history - if we've merged from this source before, use that snapshot
// 2. Direct relationship - if one workspace was forked from the other
// 3. Sibling relationship - if both were forked from the same parent
func getMergeBase(targetCfg, sourceCfg *config.ProjectConfig, targetRoot, sourceRoot string) (string, error) {
	// 1. Check if we've merged from this source before
	if targetCfg.MergeHistory != nil {
		if record, ok := targetCfg.MergeHistory[sourceCfg.WorkspaceID]; ok {
			return record.LastMergedSnapshot, nil
		}
	}

	// Helper to try loading metadata from multiple directories
	targetSnapshotsDir := config.GetSnapshotsDirAt(targetRoot)
	sourceSnapshotsDir := config.GetSnapshotsDirAt(sourceRoot)

	tryLoadMeta := func(snapshotID string) *snapshotMeta {
		// Try target's directory first, then source's
		if meta, err := loadSnapshotMetaFromDir(targetSnapshotsDir, snapshotID); err == nil {
			return meta
		}
		if meta, err := loadSnapshotMetaFromDir(sourceSnapshotsDir, snapshotID); err == nil {
			return meta
		}
		return nil
	}

	// 2. Check direct relationships using ForkSnapshotID
	// When B forks from A, B.ForkSnapshotID points to a snapshot created by A
	// So we need to check both directories for the metadata

	// Check if target was forked from source
	if targetCfg.ForkSnapshotID != "" {
		if targetBaseMeta := tryLoadMeta(targetCfg.ForkSnapshotID); targetBaseMeta != nil {
			if targetBaseMeta.WorkspaceID == sourceCfg.WorkspaceID {
				// Target was forked from source, use target's base as common ancestor
				return targetCfg.ForkSnapshotID, nil
			}
		}
	}

	// Check if source was forked from target
	if sourceCfg.ForkSnapshotID != "" {
		if sourceBaseMeta := tryLoadMeta(sourceCfg.ForkSnapshotID); sourceBaseMeta != nil {
			if sourceBaseMeta.WorkspaceID == targetCfg.WorkspaceID {
				// Source was forked from target, use source's base as common ancestor
				return sourceCfg.ForkSnapshotID, nil
			}
		}
	}

	// 3. Check if both are siblings (forked from same parent)
	if targetCfg.ForkSnapshotID != "" && sourceCfg.ForkSnapshotID != "" {
		targetBaseMeta := tryLoadMeta(targetCfg.ForkSnapshotID)
		sourceBaseMeta := tryLoadMeta(sourceCfg.ForkSnapshotID)

		if targetBaseMeta != nil && sourceBaseMeta != nil {
			if targetBaseMeta.WorkspaceID == sourceBaseMeta.WorkspaceID {
				// Both forked from same workspace, use the earlier snapshot as common ancestor
				if targetBaseMeta.CreatedAt < sourceBaseMeta.CreatedAt {
					return targetCfg.ForkSnapshotID, nil
				}
				return sourceCfg.ForkSnapshotID, nil
			}
		}
	}

	// 4. Fall back to target's fork snapshot (original behavior)
	if targetCfg.ForkSnapshotID != "" {
		return targetCfg.ForkSnapshotID, nil
	}

	return "", fmt.Errorf("no common ancestor found between workspaces")
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

// runMergeAll merges all workspaces in the project into the current one
func runMergeAll(mode ConflictMode, dryRun bool, noSnapshot bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	if _, err := config.FindProjectRoot(); err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Load workspace registry
	registry, err := LoadRegistry()
	if err != nil {
		return fmt.Errorf("failed to load workspace registry: %w", err)
	}

	// Find all other workspaces in this project
	var otherWorkspaces []RegisteredWorkspace
	for _, ws := range registry.Workspaces {
		if ws.ProjectID == cfg.ProjectID && ws.Name != cfg.WorkspaceName {
			// Check if workspace exists
			if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); err == nil {
				otherWorkspaces = append(otherWorkspaces, ws)
			}
		}
	}

	if len(otherWorkspaces) == 0 {
		fmt.Println("No other workspaces found to merge.")
		return nil
	}

	// Analyze each workspace for changes and overlaps
	type workspaceAnalysis struct {
		ws            RegisteredWorkspace
		hasChanges    bool
		changedFiles  map[string]bool
		conflictsWith []string // names of workspaces it conflicts with
	}

	analyses := make([]workspaceAnalysis, len(otherWorkspaces))
	allChangedFiles := make(map[string][]string) // file -> workspace names

	fmt.Printf("Analyzing %d workspaces...\n", len(otherWorkspaces))

	for i, ws := range otherWorkspaces {
		analyses[i] = workspaceAnalysis{
			ws:           ws,
			changedFiles: make(map[string]bool),
		}

		changes, err := getWorkspaceChanges(ws)
		if err != nil {
			continue
		}

		hasChanges := len(changes.FilesAdded) > 0 || len(changes.FilesModified) > 0 || len(changes.FilesDeleted) > 0
		analyses[i].hasChanges = hasChanges

		if hasChanges {
			for _, f := range changes.FilesAdded {
				analyses[i].changedFiles[f] = true
				allChangedFiles[f] = append(allChangedFiles[f], ws.Name)
			}
			for _, f := range changes.FilesModified {
				analyses[i].changedFiles[f] = true
				allChangedFiles[f] = append(allChangedFiles[f], ws.Name)
			}
			for _, f := range changes.FilesDeleted {
				analyses[i].changedFiles[f] = true
				allChangedFiles[f] = append(allChangedFiles[f], ws.Name)
			}
		}
	}

	// Determine which workspaces conflict with each other
	for i := range analyses {
		for file := range analyses[i].changedFiles {
			if workspaces := allChangedFiles[file]; len(workspaces) > 1 {
				for _, wsName := range workspaces {
					if wsName != analyses[i].ws.Name {
						// Check if already in list
						found := false
						for _, existing := range analyses[i].conflictsWith {
							if existing == wsName {
								found = true
								break
							}
						}
						if !found {
							analyses[i].conflictsWith = append(analyses[i].conflictsWith, wsName)
						}
					}
				}
			}
		}
	}

	// Sort: workspaces without changes first, then without conflicts, then with conflicts
	// This gives us optimal merge order
	sortedAnalyses := make([]workspaceAnalysis, len(analyses))
	copy(sortedAnalyses, analyses)

	// Simple sorting: no changes < no conflicts < has conflicts
	for i := 0; i < len(sortedAnalyses)-1; i++ {
		for j := i + 1; j < len(sortedAnalyses); j++ {
			swap := false
			// Prioritize workspaces with no changes (skip them)
			if !sortedAnalyses[i].hasChanges && sortedAnalyses[j].hasChanges {
				continue
			}
			if sortedAnalyses[i].hasChanges && !sortedAnalyses[j].hasChanges {
				swap = true
			}
			// Then prioritize no conflicts
			if !swap && len(sortedAnalyses[i].conflictsWith) > len(sortedAnalyses[j].conflictsWith) {
				swap = true
			}
			if swap {
				sortedAnalyses[i], sortedAnalyses[j] = sortedAnalyses[j], sortedAnalyses[i]
			}
		}
	}

	// Filter to only workspaces with changes
	var toMerge []workspaceAnalysis
	for _, a := range sortedAnalyses {
		if a.hasChanges {
			toMerge = append(toMerge, a)
		}
	}

	if len(toMerge) == 0 {
		fmt.Println("No workspaces have changes to merge.")
		return nil
	}

	// Show merge plan
	fmt.Println()
	fmt.Printf("Merge plan (%d workspaces with changes):\n", len(toMerge))
	fmt.Println()

	for i, a := range toMerge {
		conflictInfo := ""
		if len(a.conflictsWith) > 0 {
			conflictInfo = fmt.Sprintf(" \033[33m(overlaps with: %s)\033[0m", strings.Join(a.conflictsWith, ", "))
		}
		fmt.Printf("  %d. %s (%d files)%s\n", i+1, a.ws.Name, len(a.changedFiles), conflictInfo)
	}

	if dryRun {
		fmt.Println()
		fmt.Println("(Dry run - no changes made)")
		fmt.Println()
		fmt.Println("To merge all:")
		fmt.Println("  fst merge --all")
		return nil
	}

	// Create single auto-snapshot before merging all (unless --no-snapshot)
	if !noSnapshot {
		snapshotID, err := CreateAutoSnapshot("Before merge --all")
		if err != nil {
			fmt.Printf("Warning: Could not create pre-merge snapshot: %v\n", err)
		} else if snapshotID != "" {
			fmt.Printf("Created snapshot %s (use 'fst rollback' to undo merge)\n", snapshotID)
		}
		fmt.Println()
	}

	fmt.Printf("Merging into: %s\n", cfg.WorkspaceName)
	fmt.Println()

	// Perform merges
	type mergeOutcome struct {
		workspace string
		success   bool
		applied   int
		conflicts int
		failed    int
		err       error
	}

	var outcomes []mergeOutcome

	for i, a := range toMerge {
		fmt.Printf("[%d/%d] Merging %s...\n", i+1, len(toMerge), a.ws.Name)

		// Run merge (skip individual snapshots - we created one at the start)
		err := runMerge(a.ws.Name, "", mode, nil, false, false, true)

		outcome := mergeOutcome{
			workspace: a.ws.Name,
		}

		if err != nil {
			outcome.success = false
			outcome.err = err
			fmt.Printf("  \033[31m✗ Failed: %v\033[0m\n", err)
		} else {
			outcome.success = true
			fmt.Printf("  \033[32m✓ Merged successfully\033[0m\n")
		}

		outcomes = append(outcomes, outcome)
		fmt.Println()
	}

	// Summary
	fmt.Println("═══════════════════════════════════════")
	fmt.Println("Merge All Complete")
	fmt.Println()

	successCount := 0
	failCount := 0
	for _, o := range outcomes {
		if o.success {
			successCount++
			fmt.Printf("  \033[32m✓ %s\033[0m\n", o.workspace)
		} else {
			failCount++
			fmt.Printf("  \033[31m✗ %s: %v\033[0m\n", o.workspace, o.err)
		}
	}

	fmt.Println()
	fmt.Printf("Merged: %d/%d workspaces\n", successCount, len(outcomes))

	if failCount > 0 {
		fmt.Println()
		fmt.Println("Some merges failed. You can retry individual workspaces with:")
		fmt.Println("  fst merge <workspace>")
	} else if successCount > 0 {
		fmt.Println()
		fmt.Printf("Run 'fst snapshot -m \"Merged all workspaces\"' to save.\n")
	}

	return nil
}

// runMergePlan analyzes all workspaces and suggests optimal merge order
func runMergePlan() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	currentRoot, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Load workspace registry
	registry, err := LoadRegistry()
	if err != nil {
		return fmt.Errorf("failed to load workspace registry: %w", err)
	}

	// Find all other workspaces in this project
	var otherWorkspaces []RegisteredWorkspace
	for _, ws := range registry.Workspaces {
		if ws.ProjectID == cfg.ProjectID && ws.Name != cfg.WorkspaceName {
			// Check if workspace exists
			if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); err == nil {
				otherWorkspaces = append(otherWorkspaces, ws)
			}
		}
	}

	if len(otherWorkspaces) == 0 {
		fmt.Println("No other workspaces found in this project.")
		return nil
	}

	fmt.Printf("Analyzing %d workspaces for optimal merge order...\n", len(otherWorkspaces))
	fmt.Println()

	// Analyze each workspace
	type workspaceInfo struct {
		ws                  RegisteredWorkspace
		hasChanges          bool
		addedFiles          []string
		modifiedFiles       []string
		deletedFiles        []string
		totalFiles          int
		conflictsWithMe     int            // files that conflict with current workspace
		conflictsWithOthers map[string]int // workspace name -> conflict count
		agent               string
	}

	workspaces := make([]workspaceInfo, len(otherWorkspaces))
	allChangedFiles := make(map[string][]string) // file -> workspace names

	// Get current workspace's changes
	currentChanges, _ := getWorkspaceChangesForPath(currentRoot)
	currentFiles := make(map[string]bool)
	if currentChanges != nil {
		for _, f := range currentChanges.FilesAdded {
			currentFiles[f] = true
		}
		for _, f := range currentChanges.FilesModified {
			currentFiles[f] = true
		}
		for _, f := range currentChanges.FilesDeleted {
			currentFiles[f] = true
		}
	}

	for i, ws := range otherWorkspaces {
		workspaces[i] = workspaceInfo{
			ws:                  ws,
			conflictsWithOthers: make(map[string]int),
		}

		changes, err := getWorkspaceChanges(ws)
		if err != nil {
			continue
		}

		hasChanges := len(changes.FilesAdded) > 0 || len(changes.FilesModified) > 0 || len(changes.FilesDeleted) > 0
		workspaces[i].hasChanges = hasChanges
		workspaces[i].addedFiles = changes.FilesAdded
		workspaces[i].modifiedFiles = changes.FilesModified
		workspaces[i].deletedFiles = changes.FilesDeleted
		workspaces[i].totalFiles = len(changes.FilesAdded) + len(changes.FilesModified) + len(changes.FilesDeleted)

		// Check for agent in latest snapshot
		snapshotsDir := config.GetSnapshotsDirAt(ws.Path)
		entries, _ := os.ReadDir(snapshotsDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".meta.json") {
				data, _ := os.ReadFile(filepath.Join(snapshotsDir, entry.Name()))
				var meta SnapshotMeta
				if json.Unmarshal(data, &meta) == nil && meta.Agent != "" {
					workspaces[i].agent = meta.Agent
					break
				}
			}
		}

		// Track files
		allFiles := append(append(changes.FilesAdded, changes.FilesModified...), changes.FilesDeleted...)
		for _, f := range allFiles {
			allChangedFiles[f] = append(allChangedFiles[f], ws.Name)
			// Check if this conflicts with current workspace
			if currentFiles[f] {
				workspaces[i].conflictsWithMe++
			}
		}
	}

	// Determine conflicts between other workspaces
	for i := range workspaces {
		allFiles := append(append(workspaces[i].addedFiles, workspaces[i].modifiedFiles...), workspaces[i].deletedFiles...)
		for _, f := range allFiles {
			for _, otherName := range allChangedFiles[f] {
				if otherName != workspaces[i].ws.Name {
					workspaces[i].conflictsWithOthers[otherName]++
				}
			}
		}
	}

	// Score workspaces for merge priority
	// Lower score = should merge first
	type scoredWorkspace struct {
		info    workspaceInfo
		score   int
		reasons []string
	}

	scored := make([]scoredWorkspace, 0)
	for _, ws := range workspaces {
		if !ws.hasChanges {
			continue // Skip workspaces with no changes
		}

		sw := scoredWorkspace{info: ws, score: 0}

		// Penalty for conflicts with current workspace
		if ws.conflictsWithMe > 0 {
			sw.score += ws.conflictsWithMe * 10
			sw.reasons = append(sw.reasons, fmt.Sprintf("%d files conflict with your workspace", ws.conflictsWithMe))
		}

		// Penalty for conflicts with other workspaces
		totalOtherConflicts := 0
		for _, count := range ws.conflictsWithOthers {
			totalOtherConflicts += count
		}
		if totalOtherConflicts > 0 {
			sw.score += totalOtherConflicts * 5
			sw.reasons = append(sw.reasons, fmt.Sprintf("%d overlapping files with other workspaces", totalOtherConflicts))
		}

		// Small bonus for smaller changes (easier to review)
		if ws.totalFiles <= 5 {
			sw.score -= 2
			sw.reasons = append(sw.reasons, "small changeset")
		} else if ws.totalFiles > 20 {
			sw.score += 3
			sw.reasons = append(sw.reasons, "large changeset")
		}

		scored = append(scored, sw)
	}

	// Sort by score (lowest first)
	for i := 0; i < len(scored)-1; i++ {
		for j := i + 1; j < len(scored); j++ {
			if scored[i].score > scored[j].score {
				scored[i], scored[j] = scored[j], scored[i]
			}
		}
	}

	// Print analysis
	fmt.Printf("Current workspace: \033[1m%s\033[0m\n", cfg.WorkspaceName)
	if len(currentFiles) > 0 {
		fmt.Printf("Your changes: %d files\n", len(currentFiles))
	}
	fmt.Println()

	if len(scored) == 0 {
		fmt.Println("No workspaces have changes to merge.")
		return nil
	}

	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Println("RECOMMENDED MERGE ORDER")
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Println()

	for i, sw := range scored {
		// Status indicator
		statusColor := "\033[32m" // green
		statusIcon := "✓"
		if sw.info.conflictsWithMe > 0 {
			statusColor = "\033[31m" // red
			statusIcon = "!"
		} else if len(sw.info.conflictsWithOthers) > 0 {
			statusColor = "\033[33m" // yellow
			statusIcon = "~"
		}

		agentTag := ""
		if sw.info.agent != "" {
			agentTag = fmt.Sprintf(" \033[36m[%s]\033[0m", sw.info.agent)
		}

		fmt.Printf("%s%d. %s %s\033[0m%s\n", statusColor, i+1, statusIcon, sw.info.ws.Name, agentTag)
		fmt.Printf("   Files: +%d ~%d -%d (%d total)\n",
			len(sw.info.addedFiles), len(sw.info.modifiedFiles), len(sw.info.deletedFiles), sw.info.totalFiles)

		if len(sw.reasons) > 0 {
			fmt.Printf("   Notes: %s\n", strings.Join(sw.reasons, ", "))
		}

		// Show conflicting files if any
		if sw.info.conflictsWithMe > 0 {
			fmt.Printf("   \033[31mConflicts with your workspace:\033[0m\n")
			count := 0
			allFiles := append(append(sw.info.addedFiles, sw.info.modifiedFiles...), sw.info.deletedFiles...)
			for _, f := range allFiles {
				if currentFiles[f] {
					fmt.Printf("      - %s\n", f)
					count++
					if count >= 3 {
						remaining := sw.info.conflictsWithMe - count
						if remaining > 0 {
							fmt.Printf("      ... and %d more\n", remaining)
						}
						break
					}
				}
			}
		}

		if len(sw.info.conflictsWithOthers) > 0 {
			fmt.Printf("   \033[33mOverlaps with:\033[0m ")
			names := make([]string, 0)
			for name := range sw.info.conflictsWithOthers {
				names = append(names, name)
			}
			fmt.Printf("%s\n", strings.Join(names, ", "))
		}

		fmt.Println()
	}

	// Summary and recommendations
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Println("RECOMMENDATIONS")
	fmt.Println("═══════════════════════════════════════════════════════════")
	fmt.Println()

	// Count categories
	noConflicts := 0
	withConflicts := 0
	for _, sw := range scored {
		if sw.info.conflictsWithMe == 0 && len(sw.info.conflictsWithOthers) == 0 {
			noConflicts++
		}
		if sw.info.conflictsWithMe > 0 {
			withConflicts++
		}
	}

	if noConflicts > 0 {
		fmt.Printf("✓ %d workspace(s) can be merged without conflicts\n", noConflicts)
	}
	if withConflicts > 0 {
		fmt.Printf("! %d workspace(s) have conflicts with your changes\n", withConflicts)
		fmt.Println("  Consider using --agent for AI-assisted conflict resolution")
	}

	fmt.Println()
	fmt.Println("Commands:")
	if len(scored) > 0 {
		fmt.Printf("  fst merge %s           # Merge first recommended workspace\n", scored[0].info.ws.Name)
	}
	fmt.Println("  fst merge --all            # Merge all in recommended order")
	fmt.Println("  fst merge <name> --dry-run # Preview merge for specific workspace")

	return nil
}

// getWorkspaceChangesForPath computes drift for a workspace by path
func getWorkspaceChangesForPath(root string) (*drift.Report, error) {
	wsCfg, err := config.LoadAt(root)
	if err != nil {
		return nil, err
	}

	if wsCfg.ForkSnapshotID == "" {
		return &drift.Report{}, nil
	}

	// Load base manifest
	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, wsCfg.ForkSnapshotID)
	if err != nil {
		return nil, err
	}
	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}

	baseManifest, err := manifest.FromJSON(manifestData)
	if err != nil {
		return nil, err
	}

	// Generate current manifest
	currentManifest, err := manifest.Generate(root, false)
	if err != nil {
		return nil, err
	}

	// Compute diff
	added, modified, deleted := manifest.Diff(baseManifest, currentManifest)

	return &drift.Report{
		ForkSnapshotID: wsCfg.ForkSnapshotID,
		FilesAdded:     added,
		FilesModified:  modified,
		FilesDeleted:   deleted,
	}, nil
}
