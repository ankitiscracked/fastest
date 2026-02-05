package commands

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var (
	// Version information
	Version   = "0.0.1"
	BuildTime = "dev"
	GitCommit = "unknown"
)

var rootCmd = newRootCmd()

type registrar func(*cobra.Command)

var registrars []registrar

func register(r registrar) {
	registrars = append(registrars, r)
	if rootCmd != nil {
		r(rootCmd)
	}
}

func newRootCmd() *cobra.Command {
	return &cobra.Command{
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
}

func NewRootCmd() *cobra.Command {
	cmd := newRootCmd()
	for _, r := range registrars {
		r(cmd)
	}
	return cmd
}

func Execute() error {
	if len(os.Args) > 1 {
		rootCmd.SetArgs(rewriteArgs(os.Args[1:]))
	}
	return rootCmd.Execute()
}

func rewriteArgs(args []string) []string {
	rewritten := make([]string, 0, len(args))
	for _, arg := range args {
		switch {
		case arg == "-am":
			rewritten = append(rewritten, "--agent-message")
		case strings.HasPrefix(arg, "-am="):
			rewritten = append(rewritten, "--agent-message"+arg[len("-am"):])
		default:
			rewritten = append(rewritten, arg)
		}
	}
	return rewritten
}

func newVersionCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "version",
		Short: "Print version information",
		Run: func(cmd *cobra.Command, args []string) {
			fmt.Printf("fst version %s\n", Version)
			fmt.Printf("  Build time: %s\n", BuildTime)
			fmt.Printf("  Git commit: %s\n", GitCommit)
		},
	}
}

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newVersionCmd()) })
}
