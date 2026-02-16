package commands

import (
	"fmt"
	"time"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newWorkspaceCmd()) })
}

func newWorkspaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Manage workspaces",
	}

	cmd.AddCommand(newWorkspaceInitCmd())
	cmd.AddCommand(newWorkspaceCreateCmd())
	cmd.AddCommand(newSetMainCmd())

	return cmd
}

func newWorkspaceInitCmd() *cobra.Command {
	var workspaceName string
	var noSnapshot bool
	var force bool

	cmd := &cobra.Command{
		Use:   "init [project-name]",
		Short: "Initialize a workspace in the current directory",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInit(args, workspaceName, noSnapshot, force)
		},
	}

	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Name for this workspace (must match directory name)")
	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Don't create initial snapshot")
	cmd.Flags().BoolVar(&force, "force", false, "Skip safety checks (use with caution)")

	return cmd
}

func newWorkspaceCreateCmd() *cobra.Command {
	var fromWorkspace string
	var backend string

	cmd := &cobra.Command{
		Use:   "create <workspace-name>",
		Short: "Create a new workspace forked from an existing one",
		Long: `Create a new workspace by copying files from a source workspace.

This is similar to 'git checkout -b': it creates a new workspace forked from
the source workspace's current snapshot, with all files copied over.

When run inside a workspace, the current workspace is used as the source.
When run from the project folder, the main workspace is used as the source.
Use --from to specify a different source workspace.

Examples:
  fst workspace create feature-1             # Fork from current/main workspace
  fst workspace create bugfix --from dev     # Fork from 'dev' workspace`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCreate(args, fromWorkspace, backend)
		},
	}

	cmd.Flags().StringVar(&fromWorkspace, "from", "", "Source workspace to fork from (default: current or main)")
	cmd.Flags().StringVar(&backend, "backend", "auto", "File materialization backend: auto, clone, copy")

	return cmd
}

func newSetMainCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "set-main [workspace]",
		Short: "Set a workspace as the main workspace for the project",
		Long: `Set a workspace as the main workspace for the project.

The main workspace is used as the default comparison target for 'fst drift'.
Other workspaces can sync their changes with the main workspace.

Without arguments, sets the current workspace as main.
With a workspace name, sets that workspace as main.

Examples:
  fst workspace set-main          # Set current workspace as main
  fst workspace set-main dev      # Set workspace "dev" as main`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var workspaceName string
			if len(args) > 0 {
				workspaceName = args[0]
			}
			return runSetMain(workspaceName)
		},
	}

	return cmd
}

func runSetMain(workspaceName string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	wsRoot, err := config.FindWorkspaceRoot()
	if err != nil {
		return fmt.Errorf("not in a workspace directory")
	}

	parentRoot, parentCfg, err := config.FindProjectRootFrom(wsRoot)
	if err != nil {
		return fmt.Errorf("no project folder found - run 'fst project init' first")
	}

	var targetWorkspaceID string
	var targetWorkspaceName string

	if workspaceName == "" {
		targetWorkspaceID = cfg.WorkspaceID
		targetWorkspaceName = cfg.WorkspaceName
	} else {
		s := store.OpenAt(parentRoot)
		wsInfo, err := s.FindWorkspaceByName(workspaceName)
		if err != nil {
			return fmt.Errorf("workspace '%s' not found locally\nRun 'fst info workspaces' to see available workspaces.", workspaceName)
		}
		targetWorkspaceID = wsInfo.WorkspaceID
		targetWorkspaceName = wsInfo.WorkspaceName
	}

	parentCfg.MainWorkspaceID = targetWorkspaceID
	if err := config.SaveProjectConfigAt(parentRoot, parentCfg); err != nil {
		return fmt.Errorf("failed to store main workspace locally: %w", err)
	}

	fmt.Printf("✓ Set '%s' as the main workspace for this project.\n", targetWorkspaceName)
	fmt.Println()
	fmt.Println("Other workspaces can now use 'fst drift' to compare against this workspace.")

	return nil
}

// formatWorkspaceTime formats a timestamp for display
func formatWorkspaceTime(timestamp string) string {
	t, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		return timestamp
	}

	diff := time.Since(t)

	switch {
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins <= 1 {
			return "just now"
		}
		return fmt.Sprintf("%dm ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		return fmt.Sprintf("%dh ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		return fmt.Sprintf("%dd ago", days)
	default:
		return t.Format("Jan 2")
	}
}
