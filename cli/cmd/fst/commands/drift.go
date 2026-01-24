package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
)

func init() {
	rootCmd.AddCommand(newDriftCmd())
}

func newDriftCmd() *cobra.Command {
	var jsonOutput bool
	var summary bool
	var sync bool
	var includeDirty bool

	cmd := &cobra.Command{
		Use:   "drift [workspace]",
		Short: "Show divergence from upstream or another workspace",
		Long: `Show how this workspace has diverged from its upstream or another workspace.

Without arguments, shows divergence from the upstream workspace (the workspace
that created this workspace's base snapshot).

With a workspace argument, shows divergence from that workspace:
  - If the argument contains '/' or starts with '.', it's treated as a path
  - Otherwise, it's treated as a workspace name (looked up in the registry)

When comparing workspaces that share a common ancestor, shows:
  - What we changed since the common base
  - What they changed since the common base
  - Which files overlap (potential merge conflicts)

This helps you merge early to avoid complex conflicts in agentic workflows.

Examples:
  fst drift                    # Divergence from upstream workspace
  fst drift main               # Divergence from workspace named "main"
  fst drift ../other-project   # Divergence from workspace at path
  fst drift --json             # Output as JSON
  fst drift --summary          # Generate AI summary of divergence`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			if len(args) > 0 {
				target = args[0]
			}
			return runDrift(target, jsonOutput, summary, sync, includeDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "summary", false, "Generate LLM summary of divergence (requires configured agent)")
	cmd.Flags().BoolVar(&sync, "sync", false, "Sync drift report to cloud")
	cmd.Flags().BoolVar(&includeDirty, "include-dirty", false, "Include uncommitted changes in comparison")

	return cmd
}

func runDrift(target string, jsonOutput, generateSummary, syncToCloud, includeDirty bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var otherRoot string
	var otherName string

	if target == "" {
		// No target specified - compare with main workspace
		token, err := auth.GetToken()
		if err != nil || token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first\nOr specify a workspace: fst drift <workspace>")
		}

		client := api.NewClient(token)
		project, workspacesList, err := client.GetProject(cfg.ProjectID)
		if err != nil {
			return fmt.Errorf("failed to fetch project: %w", err)
		}

		if project.MainWorkspaceID == nil || *project.MainWorkspaceID == "" {
			return fmt.Errorf("no main workspace configured for this project\nSet one with: fst workspace set-main <workspace>\nOr specify a workspace to compare: fst drift <workspace>")
		}

		// Check if current workspace is the main workspace
		if *project.MainWorkspaceID == cfg.WorkspaceID {
			fmt.Println("This is the main workspace - nothing to compare against.")
			fmt.Println("Use 'fst drift <workspace>' to compare with a specific workspace.")
			return nil
		}

		// Find main workspace in the list
		var mainWorkspace *api.Workspace
		for i := range workspacesList {
			if workspacesList[i].ID == *project.MainWorkspaceID {
				mainWorkspace = &workspacesList[i]
				break
			}
		}

		if mainWorkspace == nil {
			return fmt.Errorf("main workspace not found")
		}

		// Look up main workspace path from local registry
		registry, err := LoadRegistry()
		if err != nil {
			return fmt.Errorf("failed to load workspace registry: %w", err)
		}

		found := false
		for _, ws := range registry.Workspaces {
			if ws.ID == mainWorkspace.ID {
				otherRoot = ws.Path
				otherName = ws.Name
				found = true
				break
			}
		}

		if !found {
			return fmt.Errorf("main workspace '%s' not found in local registry\nIt may be on a different machine. Use 'fst copy' to clone it locally.", mainWorkspace.Name)
		}
	} else {
		// Target specified - determine if it's a path or name
		if isPath(target) {
			// Treat as path
			if !filepath.IsAbs(target) {
				cwd, err := os.Getwd()
				if err != nil {
					return err
				}
				otherRoot = filepath.Join(cwd, target)
			} else {
				otherRoot = target
			}
			otherName = filepath.Base(otherRoot)

			// Verify it's a workspace
			if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
				return fmt.Errorf("not a workspace: %s", otherRoot)
			}
		} else {
			// Treat as workspace name - look up in registry
			registry, err := LoadRegistry()
			if err != nil {
				return fmt.Errorf("failed to load workspace registry: %w", err)
			}

			found := false
			for _, ws := range registry.Workspaces {
				if ws.Name == target && ws.ProjectID == cfg.ProjectID {
					otherRoot = ws.Path
					otherName = ws.Name
					found = true
					break
				}
			}

			if !found {
				return fmt.Errorf("workspace '%s' not found in project\nUse a path (e.g., ../workspace) or run 'fst workspaces' to see available workspaces", target)
			}
		}
	}

	// Verify other workspace still exists
	if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
		return fmt.Errorf("workspace no longer exists: %s", otherRoot)
	}

	// Compute divergence
	report, err := drift.ComputeDivergence(root, otherRoot, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to compute divergence: %w", err)
	}

	// Generate summary if requested
	if generateSummary && (report.OurChanges.HasChanges() || (report.TheirChanges != nil && report.TheirChanges.HasChanges())) {
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			fmt.Printf("Warning: %v\n", err)
		} else {
			fmt.Printf("Generating summary with %s...\n", preferredAgent.Name)
			summary, err := generateDivergenceSummary(root, report, preferredAgent)
			if err != nil {
				fmt.Printf("Warning: Failed to generate summary: %v\n", err)
			} else {
				report.Summary = summary
			}
		}
	}

	// Sync to cloud if requested
	if syncToCloud && report.OurChanges != nil {
		token, err := auth.GetToken()
		if err != nil || token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first")
		}

		client := api.NewClient(token)
		err = client.ReportDrift(
			cfg.WorkspaceID,
			len(report.OurChanges.FilesAdded),
			len(report.OurChanges.FilesModified),
			len(report.OurChanges.FilesDeleted),
			report.OurChanges.BytesChanged,
			report.Summary,
		)
		if err != nil {
			return fmt.Errorf("failed to sync drift: %w", err)
		}
		if !jsonOutput {
			fmt.Println("Synced to cloud.")
			fmt.Println()
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
	fmt.Printf("Comparing: %s <-> %s\n", cfg.WorkspaceName, otherName)
	if report.HasCommonAncestor {
		fmt.Printf("Common ancestor: %s\n", report.CommonAncestorID)
	} else {
		fmt.Println()
		fmt.Println("\033[33m⚠ No common ancestor found.\033[0m")
		fmt.Println("  Cannot determine who changed what - showing file differences only.")
		fmt.Println("  Merge may require manual conflict resolution.")
	}
	fmt.Println()

	// Check if in sync
	ourHasChanges := report.OurChanges != nil && report.OurChanges.HasChanges()
	theirHasChanges := report.TheirChanges != nil && report.TheirChanges.HasChanges()

	if !ourHasChanges && !theirHasChanges {
		fmt.Println("Workspaces are in sync.")
		return nil
	}

	if report.HasCommonAncestor {
		// Show our changes
		if ourHasChanges {
			fmt.Printf("Our changes (since %s):\n", report.CommonAncestorID)
			printChanges(report.OurChanges)
			fmt.Println()
		} else {
			fmt.Println("We have no changes.")
			fmt.Println()
		}

		// Show their changes
		if theirHasChanges {
			fmt.Printf("Their changes (since %s):\n", report.CommonAncestorID)
			printChanges(report.TheirChanges)
			fmt.Println()
		} else {
			fmt.Println("They have no changes.")
			fmt.Println()
		}
	} else {
		// No common ancestor - show simple diff
		if ourHasChanges {
			fmt.Println("Files different between workspaces:")
			printChanges(report.OurChanges)
			fmt.Println()
		}
	}

	// Highlight overlapping files
	if len(report.OverlappingFiles) > 0 {
		fmt.Printf("⚠ Overlapping files (%d) - potential merge conflicts:\n", len(report.OverlappingFiles))
		for _, f := range report.OverlappingFiles {
			fmt.Printf("  \033[31m! %s\033[0m\n", f)
		}
		fmt.Println()
		fmt.Println("Consider merging soon to avoid complex conflicts:")
		fmt.Printf("  fst merge %s\n", target)
	}

	// Show summary if generated
	if report.Summary != "" {
		fmt.Println()
		fmt.Printf("Summary:\n  %s\n", report.Summary)
	}

	return nil
}

// runDriftFromBase shows drift from base snapshot (when no upstream is available)
func runDriftFromBase(root string, cfg *config.ProjectConfig, jsonOutput, generateSummary, syncToCloud bool) error {
	report, err := drift.ComputeFromCache(root)
	if err != nil {
		return fmt.Errorf("failed to compute drift: %w", err)
	}

	// Generate summary if requested
	if generateSummary && report.HasChanges() {
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			fmt.Printf("Warning: %v\n", err)
		} else {
			fmt.Printf("Generating summary with %s...\n", preferredAgent.Name)

			fileContents := make(map[string]string)
			for _, f := range report.FilesAdded {
				content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
				if err == nil {
					fileContents[f] = content
				}
			}
			for _, f := range report.FilesModified {
				content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
				if err == nil {
					fileContents[f] = content
				}
			}

			diffContext := agent.BuildDiffContext(
				report.FilesAdded,
				report.FilesModified,
				report.FilesDeleted,
				fileContents,
			)

			summary, err := agent.InvokeSummary(preferredAgent, diffContext)
			if err != nil {
				fmt.Printf("Warning: Failed to generate summary: %v\n", err)
			} else {
				report.Summary = summary
			}
		}
	}

	// Sync to cloud if requested
	if syncToCloud {
		token, err := auth.GetToken()
		if err != nil || token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first")
		}

		client := api.NewClient(token)
		err = client.ReportDrift(
			cfg.WorkspaceID,
			len(report.FilesAdded),
			len(report.FilesModified),
			len(report.FilesDeleted),
			report.BytesChanged,
			report.Summary,
		)
		if err != nil {
			return fmt.Errorf("failed to sync drift: %w", err)
		}
		if !jsonOutput {
			fmt.Println("Synced to cloud.")
			fmt.Println()
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
	if !report.HasChanges() {
		fmt.Println("No changes from base snapshot.")
		return nil
	}

	fmt.Printf("Drift from base snapshot (%s):\n", report.BaseSnapshotID)
	fmt.Println()
	printChanges(report)

	if report.Summary != "" {
		fmt.Println()
		fmt.Printf("Summary:\n  %s\n", report.Summary)
	}

	return nil
}

// isPath determines if a string looks like a file path
func isPath(s string) bool {
	return strings.Contains(s, "/") || strings.HasPrefix(s, ".")
}

// printChanges prints the changes in a report
func printChanges(report *drift.Report) {
	if len(report.FilesAdded) > 0 {
		fmt.Printf("  Added (%d):\n", len(report.FilesAdded))
		for _, f := range report.FilesAdded {
			fmt.Printf("    \033[32m+ %s\033[0m\n", f)
		}
	}

	if len(report.FilesModified) > 0 {
		fmt.Printf("  Modified (%d):\n", len(report.FilesModified))
		for _, f := range report.FilesModified {
			fmt.Printf("    \033[33m~ %s\033[0m\n", f)
		}
	}

	if len(report.FilesDeleted) > 0 {
		fmt.Printf("  Deleted (%d):\n", len(report.FilesDeleted))
		for _, f := range report.FilesDeleted {
			fmt.Printf("    \033[31m- %s\033[0m\n", f)
		}
	}
}

// generateDivergenceSummary uses the coding agent to summarize divergence
func generateDivergenceSummary(root string, report *drift.DivergenceReport, ag *agent.Agent) (string, error) {
	// Build context describing the divergence
	var context strings.Builder
	context.WriteString("Two workspaces have diverged from a common ancestor.\n\n")

	if report.OurChanges != nil && report.OurChanges.HasChanges() {
		context.WriteString("Our changes:\n")
		for _, f := range report.OurChanges.FilesAdded {
			context.WriteString(fmt.Sprintf("  + %s\n", f))
		}
		for _, f := range report.OurChanges.FilesModified {
			context.WriteString(fmt.Sprintf("  ~ %s\n", f))
		}
		for _, f := range report.OurChanges.FilesDeleted {
			context.WriteString(fmt.Sprintf("  - %s\n", f))
		}
		context.WriteString("\n")
	}

	if report.TheirChanges != nil && report.TheirChanges.HasChanges() {
		context.WriteString("Their changes:\n")
		for _, f := range report.TheirChanges.FilesAdded {
			context.WriteString(fmt.Sprintf("  + %s\n", f))
		}
		for _, f := range report.TheirChanges.FilesModified {
			context.WriteString(fmt.Sprintf("  ~ %s\n", f))
		}
		for _, f := range report.TheirChanges.FilesDeleted {
			context.WriteString(fmt.Sprintf("  - %s\n", f))
		}
		context.WriteString("\n")
	}

	if len(report.OverlappingFiles) > 0 {
		context.WriteString("Overlapping files (both modified):\n")
		for _, f := range report.OverlappingFiles {
			context.WriteString(fmt.Sprintf("  ! %s\n", f))
		}
	}

	return agent.InvokeSummary(ag, context.String())
}
