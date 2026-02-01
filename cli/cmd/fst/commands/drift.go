package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newDriftCmd()) })
}

func newDriftCmd() *cobra.Command {
	var jsonOutput bool
	var summary bool
	var sync bool
	var noDirty bool

	cmd := &cobra.Command{
		Use:   "drift [workspace]",
		Short: "Show divergence from upstream or another workspace",
		Long: `Show drift between this workspace and another workspace.

By default, drift compares current files for each workspace.
Use --no-dirty to compare latest snapshots instead.

With a workspace argument, compares against that workspace:
  - If the argument contains '/' or starts with '.', it's treated as a path
  - Otherwise, it's treated as a workspace name (looked up in the registry)

Examples:
  fst drift                    # Drift vs main workspace (current files)
  fst drift main               # Drift vs workspace named "main"
  fst drift ../other-project   # Divergence from workspace at path
  fst drift --json             # Output as JSON
  fst drift --agent-summary    # Generate AI summary of divergence`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			if len(args) > 0 {
				target = args[0]
			}
			return runDrift(target, jsonOutput, summary, sync, !noDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "agent-summary", false, "Generate LLM summary of divergence (requires configured agent)")
	cmd.Flags().BoolVar(&sync, "sync", false, "Sync drift report to cloud")
	cmd.Flags().BoolVar(&noDirty, "no-dirty", false, "Compare latest snapshots instead of current files")

	return cmd
}

func runDrift(target string, jsonOutput, generateSummary, syncToCloud, includeDirty bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var otherRoot string
	var otherName string

	if target == "" {
		// No target specified - compare with main workspace
		token, err := deps.AuthGetToken()
		if err != nil {
			return deps.AuthFormatError(err)
		}
		if token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first\nOr specify a workspace: fst drift <workspace>")
		}

		client := deps.NewAPIClient(token, cfg)
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
			return fmt.Errorf("main workspace '%s' not found in local registry\nIt may be on a different machine. Use 'fst workspace copy' to clone it locally.", mainWorkspace.Name)
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

	ourManifest, ourRef, err := loadWorkspaceManifest(root, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to load current workspace manifest: %w", err)
	}
	theirManifest, theirRef, err := loadWorkspaceManifest(otherRoot, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to load comparison workspace manifest: %w", err)
	}

	report := drift.CompareManifests(ourManifest, theirManifest)

	// Sync to cloud if requested
	if syncToCloud {
		token, err := deps.AuthGetToken()
		if err != nil {
			return deps.AuthFormatError(err)
		}
		if token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first")
		}

		client := deps.NewAPIClient(token, cfg)
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
	fmt.Printf("Comparing: %s <-> %s\n", cfg.WorkspaceName, otherName)
	if includeDirty {
		fmt.Printf("Mode: current files (%s vs %s)\n", ourRef, theirRef)
	} else {
		fmt.Printf("Mode: latest snapshots (%s vs %s)\n", ourRef, theirRef)
	}
	fmt.Println()

	if !report.HasChanges() {
		fmt.Println("Workspaces are in sync.")
		return nil
	}

	printChanges(report)

	if generateSummary {
		fmt.Println()
		fmt.Println("Summary generation is not supported for snapshot-based drift yet.")
	}

	return nil
}

func loadWorkspaceManifest(root string, includeDirty bool) (*manifest.Manifest, string, error) {
	if includeDirty {
		current, err := manifest.Generate(root, false)
		if err != nil {
			return nil, "", err
		}
		return current, "current", nil
	}

	snapshotID, _ := config.GetLatestSnapshotIDAt(root)
	if snapshotID == "" {
		return nil, "", fmt.Errorf("no snapshots found")
	}
	m, err := drift.LoadManifestFromSnapshots(root, snapshotID)
	if err != nil {
		return nil, "", err
	}
	return m, snapshotID, nil
}

// runDriftFromBase shows drift from fork snapshot (when no upstream is available)
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
		token, err := deps.AuthGetToken()
		if err != nil {
			return deps.AuthFormatError(err)
		}
		if token == "" {
			return fmt.Errorf("not logged in - run 'fst login' first")
		}

		client := deps.NewAPIClient(token, cfg)
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
		fmt.Println("No changes from fork snapshot.")
		return nil
	}

	fmt.Printf("Drift from fork snapshot (%s):\n", report.ForkSnapshotID)
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
