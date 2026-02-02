package commands

import "github.com/spf13/cobra"

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newGitCmd()) })
}

func newGitCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "git",
		Short: "Git import/export tools",
		Long:  "Import and export workspace history to and from Git repositories.",
	}

	cmd.AddCommand(newExportGitCmd())
	cmd.AddCommand(newImportGitCmd())

	return cmd
}
