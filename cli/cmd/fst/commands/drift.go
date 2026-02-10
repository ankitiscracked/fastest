package commands

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/ui"
	"github.com/anthropics/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newDriftCmd()) })
}

// driftResult is the top-level JSON output structure
type driftResult struct {
	OurWorkspace      string           `json:"our_workspace"`
	TheirWorkspace    string           `json:"their_workspace"`
	CommonAncestorID  string           `json:"common_ancestor_id,omitempty"`
	Mode              string           `json:"mode"`
	OurChanges        *drift.Report    `json:"our_changes"`
	TheirChanges      *drift.Report    `json:"their_changes"`
	SnapshotConflicts *conflictSummary `json:"snapshot_conflicts"`
	DirtyConflicts    *conflictSummary `json:"dirty_conflicts,omitempty"`
	OverlappingFiles  []string         `json:"overlapping_files"`
	Summary           string           `json:"summary,omitempty"`
}

type conflictSummary struct {
	TotalFiles   int                   `json:"total_files"`
	TotalRegions int                   `json:"total_regions"`
	Files        []fileConflictSummary `json:"files"`
}

type fileConflictSummary struct {
	Path          string `json:"path"`
	ConflictCount int    `json:"conflict_count"`
}

func newDriftCmd() *cobra.Command {
	var jsonOutput bool
	var summary bool
	var noDirty bool

	cmd := &cobra.Command{
		Use:   "drift [workspace-name]",
		Short: "Show drift and conflicts with another workspace",
		Long: `Show how this workspace has diverged from another workspace,
including file-level conflicts detected via 3-way merge against
their common ancestor (found via DAG traversal).

By default, includes uncommitted (dirty) changes in the analysis.
Use --no-dirty to compare only committed snapshots.

With no argument, compares against the project's main workspace.

Exit codes:
  0  No drift detected
  1  Drift detected (for CI/CD scripting)

Examples:
  fst drift                    # Drift vs main workspace
  fst drift feature-branch     # Drift vs workspace named "feature-branch"
  fst drift --no-dirty         # Compare committed snapshots only
  fst drift --json             # Output as JSON
  fst drift --agent-summary    # Generate AI risk assessment`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			if len(args) > 0 {
				target = args[0]
			}
			return runDrift(cmd, target, jsonOutput, summary, noDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "agent-summary", false, "Generate AI drift risk assessment (requires configured agent)")
	cmd.Flags().BoolVar(&noDirty, "no-dirty", false, "Compare committed snapshots only, skip dirty changes")

	return cmd
}

func runDrift(cmd *cobra.Command, target string, jsonOutput, generateSummary, noDirty bool) error {
	ws, err := workspace.Open()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	defer ws.Close()

	dr, err := ws.Drift(workspace.DriftOpts{
		TargetName: target,
		NoDirty:    noDirty,
	})
	if err != nil {
		return err
	}

	// Build view model
	snapshotSummary := aggregateConflicts(dr.SnapshotConflicts)
	var dirtySummary *conflictSummary
	if dr.DirtyConflicts != nil {
		dirtySummary = subtractConflicts(dr.DirtyConflicts, dr.SnapshotConflicts)
	}

	var summaryText string
	if generateSummary {
		summaryText = generateDriftSummary(dr.OurName, dr.TheirName, dr.OurChanges, dr.TheirChanges, snapshotSummary, dirtySummary)
	}

	mode := "dirty"
	if noDirty {
		mode = "snapshot"
	}

	result := driftResult{
		OurWorkspace:      dr.OurName,
		TheirWorkspace:    dr.TheirName,
		CommonAncestorID:  dr.CommonAncestorID,
		Mode:              mode,
		OurChanges:        dr.OurChanges,
		TheirChanges:      dr.TheirChanges,
		SnapshotConflicts: snapshotSummary,
		DirtyConflicts:    dirtySummary,
		OverlappingFiles:  dr.OverlappingPaths,
		Summary:           summaryText,
	}

	if jsonOutput {
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to serialize result: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	printDriftReport(result, !noDirty)

	// Exit code 1 when drift is detected
	hasDrift := (result.OurChanges != nil && result.OurChanges.HasChanges()) ||
		(result.TheirChanges != nil && result.TheirChanges.HasChanges())
	if hasDrift {
		cmd.SilenceErrors = true
		return SilentExit(1)
	}
	return nil
}

func aggregateConflicts(report *conflicts.Report) *conflictSummary {
	summary := &conflictSummary{}
	if report == nil {
		return summary
	}
	for _, c := range report.Conflicts {
		count := len(c.Hunks)
		summary.Files = append(summary.Files, fileConflictSummary{
			Path:          c.Path,
			ConflictCount: count,
		})
		summary.TotalRegions += count
	}
	summary.TotalFiles = len(summary.Files)
	return summary
}

func subtractConflicts(full, baseline *conflicts.Report) *conflictSummary {
	baselineSet := make(map[string]int)
	if baseline != nil {
		for _, c := range baseline.Conflicts {
			baselineSet[c.Path] = len(c.Hunks)
		}
	}

	summary := &conflictSummary{}
	if full == nil {
		return summary
	}
	for _, c := range full.Conflicts {
		fullCount := len(c.Hunks)
		baseCount := baselineSet[c.Path]
		additional := fullCount - baseCount
		if additional > 0 {
			summary.Files = append(summary.Files, fileConflictSummary{
				Path:          c.Path,
				ConflictCount: additional,
			})
			summary.TotalRegions += additional
		} else if baseCount == 0 && fullCount > 0 {
			summary.Files = append(summary.Files, fileConflictSummary{
				Path:          c.Path,
				ConflictCount: fullCount,
			})
			summary.TotalRegions += fullCount
		}
	}
	summary.TotalFiles = len(summary.Files)
	return summary
}

func generateDriftSummary(ourName, theirName string, ourChanges, theirChanges *drift.Report, snapshotConflicts, dirtyConflicts *conflictSummary) string {
	preferredAgent, err := agent.GetPreferredAgent()
	if err != nil {
		fmt.Printf("Warning: %v\n", err)
		return ""
	}

	fmt.Printf("Generating drift assessment with %s...\n", preferredAgent.Name)

	var snapshotList, dirtyList []agent.FileConflictSummary
	if snapshotConflicts != nil {
		for _, f := range snapshotConflicts.Files {
			snapshotList = append(snapshotList, agent.FileConflictSummary{
				Path:          f.Path,
				ConflictCount: f.ConflictCount,
			})
		}
	}
	if dirtyConflicts != nil {
		for _, f := range dirtyConflicts.Files {
			dirtyList = append(dirtyList, agent.FileConflictSummary{
				Path:          f.Path,
				ConflictCount: f.ConflictCount,
			})
		}
	}

	context := agent.BuildDriftContext(
		ourName, theirName,
		ourChanges.FilesAdded, ourChanges.FilesModified, ourChanges.FilesDeleted,
		theirChanges.FilesAdded, theirChanges.FilesModified, theirChanges.FilesDeleted,
		snapshotList, dirtyList,
	)

	summaryText, err := agent.InvokeDriftSummary(preferredAgent, context)
	if err != nil {
		fmt.Printf("Warning: Failed to generate summary: %v\n", err)
		return ""
	}
	return summaryText
}

func printDriftReport(result driftResult, includeDirty bool) {
	fmt.Printf("Drift: %s <-> %s\n", result.OurWorkspace, result.TheirWorkspace)
	fmt.Printf("Common ancestor: %s\n", result.CommonAncestorID)
	if includeDirty {
		fmt.Println("Mode: current files (dirty)")
	} else {
		fmt.Println("Mode: committed snapshots")
	}
	fmt.Println()

	ourHasChanges := result.OurChanges != nil && result.OurChanges.HasChanges()
	theirHasChanges := result.TheirChanges != nil && result.TheirChanges.HasChanges()

	if !ourHasChanges && !theirHasChanges {
		fmt.Println("Workspaces are in sync. No drift detected.")
		return
	}

	if ourHasChanges {
		fmt.Println("Our changes (from ancestor):")
		printChanges(result.OurChanges)
		fmt.Println()
	}

	if theirHasChanges {
		fmt.Println("Their changes (from ancestor):")
		printChanges(result.TheirChanges)
		fmt.Println()
	}

	if result.SnapshotConflicts != nil && result.SnapshotConflicts.TotalFiles > 0 {
		fmt.Println("Snapshot conflicts:")
		printConflictSummary(result.SnapshotConflicts)
		fmt.Println()
	}

	if result.DirtyConflicts != nil && result.DirtyConflicts.TotalFiles > 0 {
		fmt.Println("Dirty conflicts (additional):")
		printConflictSummary(result.DirtyConflicts)
		fmt.Println()
	}

	if (result.SnapshotConflicts == nil || result.SnapshotConflicts.TotalFiles == 0) &&
		(result.DirtyConflicts == nil || result.DirtyConflicts.TotalFiles == 0) {
		if len(result.OverlappingFiles) > 0 {
			fmt.Printf("No conflicts (%d files modified in both workspaces, but changes don't overlap).\n", len(result.OverlappingFiles))
		}
	}

	if result.Summary != "" {
		fmt.Println("Assessment:")
		fmt.Printf("  %s\n", result.Summary)
	}
}

func printChanges(report *drift.Report) {
	if len(report.FilesAdded) > 0 {
		fmt.Printf("  Added (%d):\n", len(report.FilesAdded))
		for _, f := range report.FilesAdded {
			fmt.Printf("    %s\n", ui.Green("+ "+f))
		}
	}

	if len(report.FilesModified) > 0 {
		fmt.Printf("  Modified (%d):\n", len(report.FilesModified))
		for _, f := range report.FilesModified {
			fmt.Printf("    %s\n", ui.Yellow("~ "+f))
		}
	}

	if len(report.FilesDeleted) > 0 {
		fmt.Printf("  Deleted (%d):\n", len(report.FilesDeleted))
		for _, f := range report.FilesDeleted {
			fmt.Printf("    %s\n", ui.Red("- "+f))
		}
	}
}

func printConflictSummary(cs *conflictSummary) {
	for _, f := range cs.Files {
		label := "conflicts"
		if f.ConflictCount == 1 {
			label = "conflict"
		}
		fmt.Printf("  %s\n", ui.Red(fmt.Sprintf("%-40s %d %s", f.Path, f.ConflictCount, label)))
	}
	filesLabel := "files"
	if cs.TotalFiles == 1 {
		filesLabel = "file"
	}
	regionsLabel := "conflicts"
	if cs.TotalRegions == 1 {
		regionsLabel = "conflict"
	}
	fmt.Printf("  Total: %d %s across %d %s\n", cs.TotalRegions, regionsLabel, cs.TotalFiles, filesLabel)
}
