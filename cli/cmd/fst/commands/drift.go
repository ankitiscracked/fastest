package commands

import (
	"fmt"
	"os"
	"path/filepath"

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
	var workspace string
	var includeDirty bool

	cmd := &cobra.Command{
		Use:   "drift",
		Short: "Show changes from base snapshot or another workspace",
		Long: `Show the drift (changes) from the base snapshot or another workspace.

By default, compares your current working directory against the workspace's
base_snapshot_id and shows which files have been added, modified, or deleted.

Use --workspace to compare against another workspace's current state.

Examples:
  fst drift                        # Compare against base snapshot
  fst drift --workspace ../feature # Compare against another workspace
  fst drift --json                 # Output as JSON
  fst drift --summary              # Generate AI summary of changes`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDrift(jsonOutput, summary, sync, workspace, includeDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "summary", false, "Generate LLM summary of changes (requires configured agent)")
	cmd.Flags().BoolVar(&sync, "sync", false, "Sync drift report to cloud")
	cmd.Flags().StringVarP(&workspace, "workspace", "w", "", "Compare against another workspace (path)")
	cmd.Flags().BoolVar(&includeDirty, "include-dirty", false, "Include other workspace's uncommitted changes in comparison")

	return cmd
}

func runDrift(jsonOutput, generateSummary, syncToCloud bool, otherWorkspace string, includeDirty bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var report *drift.Report

	if otherWorkspace != "" {
		// Compare against another workspace
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

		report, err = drift.ComputeAgainstWorkspace(root, otherRoot, includeDirty)
		if err != nil {
			return fmt.Errorf("failed to compute drift: %w", err)
		}
	} else {
		// Compare against base snapshot
		report, err = drift.ComputeFromCache(root)
		if err != nil {
			return fmt.Errorf("failed to compute drift: %w", err)
		}
	}

	// Generate summary if requested
	if generateSummary && report.HasChanges() {
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			fmt.Printf("Warning: %v\n", err)
			fmt.Println("Falling back to basic summary...")
			report.Summary = generateBasicSummary(report)
		} else {
			fmt.Printf("Generating summary with %s...\n", preferredAgent.Name)

			// Build diff context with file contents
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
				report.Summary = generateBasicSummary(report)
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
			fmt.Println("✓ Drift synced to cloud")
			fmt.Println()
		}
	}

	// Output
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
		if otherWorkspace != "" {
			fmt.Println("No differences from the other workspace")
		} else {
			fmt.Println("No changes from base snapshot")
		}
		return nil
	}

	if otherWorkspace != "" {
		fmt.Printf("Differences from workspace: %s\n", report.FormatSummary())
	} else {
		fmt.Printf("Drift from base: %s\n", report.FormatSummary())
	}
	fmt.Println()

	if len(report.FilesAdded) > 0 {
		fmt.Printf("Added (%d):\n", len(report.FilesAdded))
		for _, f := range report.FilesAdded {
			fmt.Printf("  \033[32m+ %s\033[0m\n", f)
		}
		fmt.Println()
	}

	if len(report.FilesModified) > 0 {
		fmt.Printf("Modified (%d):\n", len(report.FilesModified))
		for _, f := range report.FilesModified {
			fmt.Printf("  \033[33m~ %s\033[0m\n", f)
		}
		fmt.Println()
	}

	if len(report.FilesDeleted) > 0 {
		fmt.Printf("Deleted (%d):\n", len(report.FilesDeleted))
		for _, f := range report.FilesDeleted {
			fmt.Printf("  \033[31m- %s\033[0m\n", f)
		}
		fmt.Println()
	}

	if report.Summary != "" {
		fmt.Printf("Summary:\n  %s\n", report.Summary)
	}

	return nil
}

func generateBasicSummary(report *drift.Report) string {
	parts := []string{}

	if len(report.FilesAdded) > 0 {
		if len(report.FilesAdded) == 1 {
			parts = append(parts, fmt.Sprintf("Added %s", report.FilesAdded[0]))
		} else {
			parts = append(parts, fmt.Sprintf("Added %d files", len(report.FilesAdded)))
		}
	}

	if len(report.FilesModified) > 0 {
		if len(report.FilesModified) == 1 {
			parts = append(parts, fmt.Sprintf("Modified %s", report.FilesModified[0]))
		} else {
			parts = append(parts, fmt.Sprintf("Modified %d files", len(report.FilesModified)))
		}
	}

	if len(report.FilesDeleted) > 0 {
		if len(report.FilesDeleted) == 1 {
			parts = append(parts, fmt.Sprintf("Deleted %s", report.FilesDeleted[0]))
		} else {
			parts = append(parts, fmt.Sprintf("Deleted %d files", len(report.FilesDeleted)))
		}
	}

	if len(parts) == 0 {
		return "No changes"
	}

	result := parts[0]
	for i := 1; i < len(parts); i++ {
		if i == len(parts)-1 {
			result += " and " + parts[i]
		} else {
			result += ", " + parts[i]
		}
	}

	return result + "."
}
