package commands

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/conflicts"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newConflictsCmd()) })
}

func newConflictsCmd() *cobra.Command {
	var showAll bool
	var includeDirty bool
	var jsonOutput bool
	var summary bool

	cmd := &cobra.Command{
		Use:        "conflicts <workspace-path>",
		Short:      "Show git-style conflicts with another workspace (deprecated: use 'fst merge --dry-run')",
		Deprecated: "Use 'fst merge --dry-run' instead for conflict detection",
		Long: `DEPRECATED: This command is deprecated. Use 'fst merge --dry-run' instead.

Detect git-style conflicts with another workspace.

A conflict occurs when the same lines/regions of a file have been modified
in both your workspace and the other workspace since your common fork snapshot.

This performs a 3-way comparison:
1. Your changes: base → current workspace
2. Other's changes: base → other workspace
3. Conflicts: overlapping line modifications

Files modified in both workspaces but in different regions are NOT conflicts
and can be auto-merged.

Both workspaces must share a common fork_snapshot_id (i.e., one was forked
from the other) for meaningful conflict detection.

Examples:
  fst merge --dry-run ../feature-workspace   # Preferred way
  fst conflicts ../feature-workspace         # Deprecated`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			fmt.Println("\033[33mNote: 'fst conflicts' is deprecated. Use 'fst merge --dry-run' instead.\033[0m")
			fmt.Println()
			return runConflicts(args[0], showAll, includeDirty, jsonOutput, summary)
		},
	}

	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show all overlapping files, not just conflicts")
	cmd.Flags().BoolVar(&includeDirty, "include-dirty", false, "Include other workspace's uncommitted changes in comparison")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "summary", false, "Generate LLM summary of conflicts (requires configured agent)")

	return cmd
}

func runConflicts(otherWorkspace string, showAll, includeDirty, jsonOutput, generateSummary bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Resolve other workspace path
	otherRoot := otherWorkspace
	if !filepath.IsAbs(otherRoot) {
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		otherRoot = filepath.Join(cwd, otherRoot)
	}

	// Verify the other workspace exists
	if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
		return fmt.Errorf("not a workspace: %s", otherRoot)
	}

	// Detect git-style conflicts
	report, err := conflicts.Detect(root, otherRoot, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to detect conflicts: %w", err)
	}

	// Generate LLM summary if requested and there are conflicts
	var summaryText string
	if generateSummary && report.TrueConflicts > 0 {
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			fmt.Printf("Warning: %v\n", err)
		} else {
			fmt.Printf("Generating summary with %s...\n", preferredAgent.Name)

			// Build conflict context
			conflictInfos := buildConflictInfos(report)
			conflictContext := agent.BuildConflictContext(conflictInfos)

			summaryText, err = agent.InvokeConflictSummary(preferredAgent, conflictContext)
			if err != nil {
				fmt.Printf("Warning: Failed to generate summary: %v\n", err)
			}
		}
	}

	// JSON output
	if jsonOutput {
		data, err := report.ToJSON()
		if err != nil {
			return fmt.Errorf("failed to serialize report: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	// Human-readable output
	fmt.Printf("Workspace: %s\n", cfg.WorkspaceName)
	fmt.Printf("Comparing against: %s\n", otherRoot)
	fmt.Println()

	// Summary
	if report.TrueConflicts == 0 {
		if len(report.OverlappingFiles) > 0 {
			fmt.Printf("✓ No conflicts (%d files modified in both workspaces, but changes don't overlap)\n",
				len(report.OverlappingFiles))
			fmt.Println()
			fmt.Println("These files can be auto-merged since changes are in different regions.")

			if showAll {
				fmt.Println()
				fmt.Println("Overlapping files (auto-mergeable):")
				for _, path := range report.OverlappingFiles {
					fmt.Printf("  \033[33m%s\033[0m\n", path)
				}
			}
		} else {
			fmt.Println("✓ No conflicts with the other workspace")
		}
		return nil
	}

	// Show conflicts
	fmt.Printf("⚠ %d conflicting files with %d overlapping regions:\n", report.TrueConflicts, countHunks(report))
	fmt.Println()

	for _, c := range report.Conflicts {
		fmt.Printf("  \033[31m%s\033[0m (%d conflicting regions)\n", c.Path, len(c.Hunks))
		for i, h := range c.Hunks {
			if h.EndLine > h.StartLine {
				fmt.Printf("    Conflict %d: lines %d-%d\n", i+1, h.StartLine, h.EndLine)
			} else {
				fmt.Printf("    Conflict %d: line %d\n", i+1, h.StartLine)
			}
		}
	}

	// Optionally show non-conflicting overlapping files
	if showAll && len(report.OverlappingFiles) > report.TrueConflicts {
		fmt.Println()
		fmt.Println("Files modified in both (auto-mergeable):")
		for _, path := range report.OverlappingFiles {
			if !hasConflict(report.Conflicts, path) {
				fmt.Printf("  \033[33m%s\033[0m\n", path)
			}
		}
	}

	// Show LLM summary if generated
	if summaryText != "" {
		fmt.Println()
		fmt.Printf("Summary:\n  %s\n", summaryText)
	}

	fmt.Println()
	fmt.Println("To resolve conflicts:")
	fmt.Printf("  fst merge %s --agent   # Let AI resolve conflicts\n", otherWorkspace)
	fmt.Printf("  fst merge %s --manual  # Create conflict markers for manual resolution\n", otherWorkspace)

	return nil
}

// buildConflictInfos converts conflicts.Report to agent.ConflictInfo slice
func buildConflictInfos(report *conflicts.Report) []agent.ConflictInfo {
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

func countHunks(report *conflicts.Report) int {
	total := 0
	for _, c := range report.Conflicts {
		total += len(c.Hunks)
	}
	return total
}

func hasConflict(conflicts []conflicts.FileConflict, path string) bool {
	for _, c := range conflicts {
		if c.Path == path {
			return true
		}
	}
	return false
}
