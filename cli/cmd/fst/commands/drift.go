package commands

import (
	"fmt"
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
	var includeDirty bool

	cmd := &cobra.Command{
		Use:   "drift",
		Short: "Show changes from main workspace",
		Long: `Show the drift (changes) from the main workspace.

For linked workspaces, this compares your current working directory against
the main workspace and shows which files have been added, modified, or deleted.

For main workspaces, this compares against the base snapshot.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDrift(jsonOutput, summary, sync, includeDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "summary", false, "Generate LLM summary of changes (requires configured agent)")
	cmd.Flags().BoolVar(&sync, "sync", false, "Sync drift report to cloud")
	cmd.Flags().BoolVar(&includeDirty, "include-dirty", false, "Include main workspace's uncommitted changes in comparison")

	return cmd
}

func runDrift(jsonOutput, generateSummary, syncToCloud, includeDirty bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Compute drift against main workspace (or base for main workspaces)
	report, err := drift.ComputeAgainstMain(root, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to compute drift: %w", err)
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
		if cfg.IsMain {
			fmt.Println("No changes from base snapshot")
		} else {
			fmt.Println("No differences from main workspace")
		}
		return nil
	}

	if cfg.IsMain {
		fmt.Printf("Drift from base: %s\n", report.FormatSummary())
	} else {
		fmt.Printf("Differences from main: %s\n", report.FormatSummary())
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
