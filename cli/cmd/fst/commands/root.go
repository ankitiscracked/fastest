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
		Short: "Fastest - parallel agent workflows from the ground up",
		Long: `Fastest (fst) is infrastructure for parallel agent workflows, built from the
ground up. Existing tools treat parallel development as an afterthought — fst
makes it the core primitive.

It provides:
  - Parallel workspaces with independent snapshot histories
  - Immutable snapshots of project state
  - Three-way merge with agent-assisted conflict resolution
  - Drift detection across workspaces
  - CLI-first interface for agents and humans alike`,
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
