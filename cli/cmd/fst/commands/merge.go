package commands

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/store"
	"github.com/anthropics/fastest/cli/internal/ui"
	"github.com/anthropics/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newMergeCmd()) })
}

// ConflictMode determines how conflicts are resolved (CLI layer).
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

Exit codes:
  0  Merge completed without conflicts
  1  Merge completed with unresolved conflicts (for CI/CD scripting)`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if abort {
				return runMergeAbort()
			}

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

			mode := ConflictModeAgent
			if manual {
				mode = ConflictModeManual
			} else if theirs {
				mode = ConflictModeTheirs
			} else if ours {
				mode = ConflictModeOurs
			}

			if len(args) == 0 {
				return fmt.Errorf("must specify workspace name")
			}

			return runMerge(cmd, args[0], mode, dryRun, dryRunSummary, noPreSnapshot, force)
		},
	}

	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take source version for all conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep current version for all conflicts")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Preview merge with line-level conflict details")
	cmd.Flags().BoolVar(&dryRunSummary, "agent-summary", false, "Generate LLM summary of conflicts (with --dry-run)")
	cmd.Flags().BoolVar(&noPreSnapshot, "no-pre-snapshot", false, "Skip pre-merge snapshot (only created if dirty)")
	cmd.Flags().BoolVar(&force, "force", false, "Allow merge without a common base (two-way merge)")
	cmd.Flags().BoolVar(&abort, "abort", false, "Abort an in-progress merge (clears pending merge state)")

	return cmd
}

func runMergeAbort() error {
	ws, err := workspace.Open()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	defer ws.Close()

	if err := ws.MergeAbort(); err != nil {
		return err
	}
	fmt.Println("Merge state cleared.")
	return nil
}

func runMerge(cmd *cobra.Command, sourceName string, mode ConflictMode, dryRun bool, dryRunSummary bool, noPreSnapshot bool, force bool) error {
	ws, err := workspace.Open()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	defer ws.Close()

	// Resolve source workspace via project registry
	sourceInfo, err := ws.Store().FindWorkspaceByName(sourceName)
	if err != nil {
		return fmt.Errorf("workspace '%s' not found in project registry\nRun 'fst workspaces' to see available workspaces", sourceName)
	}

	sourceSnapshotID := sourceInfo.CurrentSnapshotID
	if sourceSnapshotID == "" {
		return fmt.Errorf("source workspace '%s' has no snapshots - run 'fst snapshot' in that workspace first", sourceName)
	}

	currentSnapshotID := ws.CurrentSnapshotID()
	if currentSnapshotID == "" {
		return fmt.Errorf("current workspace has no snapshots - run 'fst snapshot' before merging")
	}

	fmt.Printf("Merging from: %s\n", sourceInfo.WorkspaceName)
	fmt.Printf("Into:         %s (%s)\n", ws.WorkspaceName(), ws.Root())
	fmt.Println()

	// Plan the merge
	plan, err := ws.Store().PlanMerge(currentSnapshotID, sourceSnapshotID, force)
	if err != nil {
		return fmt.Errorf("merge planning failed: %w", err)
	}

	if plan.MergeBaseID != "" {
		fmt.Printf("Using merge base: %s\n", plan.MergeBaseID)
	} else if force {
		fmt.Println("Warning: No common ancestor found. Proceeding with two-way merge.")
	}

	// Display summary
	fmt.Println()
	fmt.Printf("Merge plan:\n")
	fmt.Printf("  Apply from source:  %d files\n", len(plan.ToApply))
	if len(plan.AutoMerged) > 0 {
		fmt.Printf("  Auto-merge:         %d files\n", len(plan.AutoMerged))
	}
	fmt.Printf("  Conflicts:          %d files\n", len(plan.Conflicts))
	fmt.Printf("  Already in sync:    %d files\n", plan.InSync)
	fmt.Println()

	if len(plan.ToApply) == 0 && len(plan.AutoMerged) == 0 && len(plan.Conflicts) == 0 {
		fmt.Println("Nothing to merge - workspaces are in sync")
		return nil
	}

	// Dry-run mode
	if dryRun {
		printMergePlan(plan)

		if len(plan.Conflicts) > 0 {
			printConflictDetails(ws, sourceInfo, dryRunSummary)
		}

		fmt.Println()
		fmt.Println(dag.RenderMergeDiagram(dag.MergeDiagramOpts{
			CurrentID:    currentSnapshotID,
			SourceID:     sourceSnapshotID,
			MergeBaseID:  plan.MergeBaseID,
			CurrentLabel: ws.WorkspaceName(),
			SourceLabel:  sourceInfo.WorkspaceName,
		}))
		fmt.Println()
		fmt.Println("(Dry run - no changes made)")
		fmt.Println()
		fmt.Println("To merge:")
		if len(plan.Conflicts) > 0 {
			fmt.Printf("  fst merge %s          # Let AI resolve conflicts\n", sourceName)
			fmt.Printf("  fst merge %s --manual  # Create conflict markers\n", sourceName)
			fmt.Printf("  fst merge %s --theirs  # Take their version for conflicts\n", sourceName)
			fmt.Printf("  fst merge %s --ours    # Keep your version for conflicts\n", sourceName)
		} else {
			fmt.Printf("  fst merge %s\n", sourceName)
		}
		return nil
	}

	// Pre-merge auto-snapshot — abort if it fails so the user has a restore point
	if !noPreSnapshot {
		snapshotID, err := ws.AutoSnapshot(fmt.Sprintf("Before merge from %s", sourceInfo.WorkspaceName))
		if err != nil {
			return fmt.Errorf("failed to create pre-merge snapshot (use --no-pre-snapshot to skip): %w", err)
		}
		if snapshotID != "" {
			fmt.Printf("Created snapshot %s (use 'fst restore' to undo merge)\n", snapshotID)
			fmt.Println()
		}
	}

	// Build merge options
	applyOpts := workspace.ApplyMergeOpts{
		Plan: plan,
	}

	switch mode {
	case ConflictModeTheirs:
		applyOpts.Mode = workspace.ConflictModeTheirs
	case ConflictModeOurs:
		applyOpts.Mode = workspace.ConflictModeOurs
	case ConflictModeManual:
		applyOpts.Mode = workspace.ConflictModeManual
	case ConflictModeAgent:
		applyOpts.Mode = workspace.ConflictModeManual // fallback if agent fails
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			fmt.Printf("Warning: %v\n", err)
			fmt.Println("Falling back to manual conflict markers...")
		} else {
			fmt.Printf("Using %s for conflict resolution...\n", preferredAgent.Name)
			applyOpts.Resolver = func(path string, current, source, base []byte) ([]byte, error) {
				result, err := agent.InvokeMerge(preferredAgent, string(base), string(current), string(source), path)
				if err != nil {
					return nil, err
				}
				if len(result.Strategy) > 0 {
					fmt.Printf("    Strategy:\n")
					for _, bullet := range result.Strategy {
						fmt.Printf("      . %s\n", bullet)
					}
				}
				showMergeDiff(string(current), result.MergedCode)
				return []byte(result.MergedCode), nil
			}
		}
	}

	// Apply merge
	fmt.Println("Applying merge...")
	result, err := ws.ApplyMerge(applyOpts)
	if err != nil {
		return err
	}

	// Print per-file results
	for _, f := range result.Applied {
		fmt.Printf("  Applied: %s\n", f)
	}
	for _, f := range result.AutoMerged {
		fmt.Printf("  Auto-merged: %s\n", f)
	}
	for _, f := range result.Conflicts {
		fmt.Printf("  Conflict: %s (needs manual resolution)\n", f)
	}
	for _, f := range result.Failed {
		fmt.Printf("  Failed: %s\n", f)
	}
	fmt.Println()

	// Post-merge auto-snapshot (only if clean)
	var mergedSnapshotID string
	totalApplied := len(result.Applied) + len(result.AutoMerged)
	if len(result.Conflicts) == 0 && len(result.Failed) == 0 && totalApplied > 0 {
		snapResult, err := ws.Snapshot(workspace.SnapshotOpts{
			Message: fmt.Sprintf("Merged %s", sourceInfo.WorkspaceName),
		})
		if err != nil {
			fmt.Printf("Warning: Could not create post-merge snapshot: %v\n", err)
			fmt.Printf("Run 'fst snapshot -m \"Merged %s\"' to save.\n", sourceInfo.WorkspaceName)
		} else {
			mergedSnapshotID = snapResult.SnapshotID
		}
	}

	// Summary
	fmt.Println("Merge complete:")
	fmt.Printf("  Applied:      %d files\n", len(result.Applied))
	if len(result.AutoMerged) > 0 {
		fmt.Printf("  Auto-merged:  %d files\n", len(result.AutoMerged))
	}
	if len(result.Conflicts) > 0 {
		fmt.Printf("  Conflicts:    %d files (need resolution)\n", len(result.Conflicts))
	}
	if len(result.Failed) > 0 {
		fmt.Printf("  Failed:       %d files\n", len(result.Failed))
	}

	// DAG diagram
	fmt.Println()
	fmt.Println(dag.RenderMergeDiagram(dag.MergeDiagramOpts{
		CurrentID:    currentSnapshotID,
		SourceID:     sourceSnapshotID,
		MergeBaseID:  plan.MergeBaseID,
		MergedID:     mergedSnapshotID,
		CurrentLabel: ws.WorkspaceName(),
		SourceLabel:  sourceInfo.WorkspaceName,
		Message:      fmt.Sprintf("Merged %s", sourceInfo.WorkspaceName),
	}))

	if len(result.Conflicts) > 0 {
		fmt.Println()
		fmt.Println("To resolve conflicts manually:")
		fmt.Println("  1. Edit the conflicting files (look for <<<<<<< markers)")
		fmt.Println("  2. Remove the conflict markers")
		fmt.Println("  3. Run 'fst snapshot' to save the merged state")
		if cmd != nil {
			cmd.SilenceErrors = true
			return SilentExit(1)
		}
	}

	return nil
}

func printMergePlan(plan *store.MergePlan) {
	if len(plan.ToApply) > 0 {
		fmt.Println("Will apply from source:")
		for _, a := range plan.ToApply {
			fmt.Printf("  + %s\n", a.Path)
		}
	}

	if len(plan.AutoMerged) > 0 {
		fmt.Println("Will auto-merge (non-overlapping changes):")
		for _, a := range plan.AutoMerged {
			fmt.Printf("  ~ %s\n", a.Path)
		}
	}

	if len(plan.Conflicts) > 0 {
		fmt.Println("Conflicts to resolve:")
		for _, a := range plan.Conflicts {
			fmt.Printf("  ! %s\n", a.Path)
		}
	}
}

func printConflictDetails(ws *workspace.Workspace, sourceInfo *store.WorkspaceInfo, agentSummary bool) {
	if sourceInfo.Path == "" {
		return
	}

	fmt.Println()
	fmt.Println("Conflict details:")
	conflictReport, err := conflicts.Detect(ws.Root(), sourceInfo.Path, true)
	if err != nil {
		fmt.Printf("  (Could not analyze conflicts: %v)\n", err)
		return
	}

	if conflictReport.TrueConflicts == 0 {
		fmt.Println("  Files are modified in both workspaces but changes don't overlap.")
		fmt.Println("  These can be auto-merged.")
		return
	}

	for _, c := range conflictReport.Conflicts {
		fmt.Printf("\n  %s (%d conflicting regions)\n", ui.Red(c.Path), len(c.Hunks))
		for i, h := range c.Hunks {
			if h.EndLine > h.StartLine {
				fmt.Printf("    Region %d: lines %d-%d\n", i+1, h.StartLine, h.EndLine)
			} else {
				fmt.Printf("    Region %d: line %d\n", i+1, h.StartLine)
			}
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

	autoMergeCount := len(conflictReport.OverlappingFiles) - conflictReport.TrueConflicts
	if autoMergeCount > 0 {
		fmt.Println()
		fmt.Printf("Files modified in both (auto-mergeable): %d\n", autoMergeCount)
	}

	if agentSummary {
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
}

func showMergeDiff(before, after string) {
	beforeLines := strings.Split(before, "\n")
	afterLines := strings.Split(after, "\n")

	fmt.Printf("    Diff:\n")

	changes := 0
	maxChanges := 10

	i, j := 0, 0
	for i < len(beforeLines) && j < len(afterLines) && changes < maxChanges {
		if beforeLines[i] == afterLines[j] {
			i++
			j++
			continue
		}
		if i < len(beforeLines) {
			fmt.Printf("      %s\n", ui.Red("- "+truncatePreview(beforeLines[i], 60)))
			i++
			changes++
		}
		if j < len(afterLines) && changes < maxChanges {
			fmt.Printf("      %s\n", ui.Green("+ "+truncatePreview(afterLines[j], 60)))
			j++
			changes++
		}
	}

	for i < len(beforeLines) && changes < maxChanges {
		fmt.Printf("      %s\n", ui.Red("- "+truncatePreview(beforeLines[i], 60)))
		i++
		changes++
	}
	for j < len(afterLines) && changes < maxChanges {
		fmt.Printf("      %s\n", ui.Green("+ "+truncatePreview(afterLines[j], 60)))
		j++
		changes++
	}

	remaining := (len(beforeLines) - i) + (len(afterLines) - j)
	if remaining > 0 || changes >= maxChanges {
		fmt.Printf("      ... (%d more changes)\n", remaining)
	}
}

func truncatePreview(s string, maxLen int) string {
	s = strings.TrimSpace(s)
	if len(s) > maxLen {
		return s[:maxLen-3] + "..."
	}
	return s
}

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
