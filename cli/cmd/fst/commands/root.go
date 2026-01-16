package commands

import (
	"fmt"

	"github.com/spf13/cobra"
)

var (
	// Version information
	Version   = "0.0.1"
	BuildTime = "dev"
	GitCommit = "unknown"
)

var rootCmd = &cobra.Command{
	Use:   "fst",
	Short: "Fastest - sync project state across interfaces",
	Long: `Fastest (fst) is a tool for keeping projects and their state in sync
across CLI and Web interfaces, designed for agentic coding workflows.

It provides:
  - Project management and identity
  - Immutable snapshots of project state
  - Workspace management for parallel development
  - Drift detection with LLM-powered summaries
  - Merge tools with agent-assisted conflict resolution`,
}

var versionCmd = &cobra.Command{
	Use:   "version",
	Short: "Print version information",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("fst version %s\n", Version)
		fmt.Printf("  Build time: %s\n", BuildTime)
		fmt.Printf("  Git commit: %s\n", GitCommit)
	},
}

func init() {
	rootCmd.AddCommand(versionCmd)

	// Placeholder commands for features not yet implemented in separate files
	rootCmd.AddCommand(cloneCmd)
	rootCmd.AddCommand(watchCmd)
	rootCmd.AddCommand(mergeCmd)
	rootCmd.AddCommand(exportCmd)
}

func Execute() error {
	return rootCmd.Execute()
}

// Placeholder commands - will be implemented in separate files

var cloneCmd = &cobra.Command{
	Use:   "clone <project|snapshot>",
	Short: "Clone a project or snapshot",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Clone %s not yet implemented\n", args[0])
	},
}

var watchCmd = &cobra.Command{
	Use:   "watch",
	Short: "Watch for changes and update drift",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Watch daemon not yet implemented")
	},
}

var mergeCmd = &cobra.Command{
	Use:   "merge <source-workspace>",
	Short: "Merge changes from another workspace",
	Args:  cobra.ExactArgs(1),
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Printf("Merge from %s not yet implemented\n", args[0])
	},
}

var exportCmd = &cobra.Command{
	Use:   "export",
	Short: "Export snapshot to Git",
	Run: func(cmd *cobra.Command, args []string) {
		fmt.Println("Use 'fst export git' to export to Git")
	},
}

func init() {
	// Add subcommands to export
	exportCmd.AddCommand(&cobra.Command{
		Use:   "git",
		Short: "Export to Git repository",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Println("Git export not yet implemented")
		},
	})

	// Add flags
	watchCmd.Flags().Bool("summarize", false, "Periodically regenerate summaries")
	watchCmd.Flags().Int("interval", 5, "Sync interval in seconds")

	mergeCmd.Flags().Bool("agent", true, "Use agent for conflict resolution")
	mergeCmd.Flags().Bool("manual", false, "Manual conflict resolution")
	mergeCmd.Flags().StringSlice("cherry-pick", nil, "Cherry-pick specific files")
}
