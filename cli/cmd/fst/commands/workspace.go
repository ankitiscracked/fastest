package commands

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	rootCmd.AddCommand(newWorkspacesCmd())
	rootCmd.AddCommand(newWorkspaceCmd())
}

func newWorkspacesCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "workspaces",
		Aliases: []string{"ws"},
		Short:   "List workspaces for the current project",
		RunE:    runWorkspaces,
	}
}

func runWorkspaces(cmd *cobra.Command, args []string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	client := api.NewClient(token)
	_, workspaces, err := client.GetProject(cfg.ProjectID)
	if err != nil {
		return fmt.Errorf("failed to get project: %w", err)
	}

	if len(workspaces) == 0 {
		fmt.Println("No workspaces found.")
		return nil
	}

	fmt.Printf("Workspaces for project (current: %s):\n", cfg.WorkspaceName)
	fmt.Println()

	fmt.Printf("  %-12s  %-20s  %-15s  %-12s  %s\n", "ID", "NAME", "MACHINE", "BASE", "LAST SEEN")
	fmt.Printf("  %-12s  %-20s  %-15s  %-12s  %s\n",
		strings.Repeat("-", 12),
		strings.Repeat("-", 20),
		strings.Repeat("-", 15),
		strings.Repeat("-", 12),
		strings.Repeat("-", 15))

	for _, w := range workspaces {
		shortID := w.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}

		name := w.Name
		if w.ID == cfg.WorkspaceID {
			name = "* " + name // Mark current workspace
		}
		if len(name) > 20 {
			name = name[:17] + "..."
		}

		machineID := "-"
		if w.MachineID != nil && *w.MachineID != "" {
			machineID = *w.MachineID
			if len(machineID) > 15 {
				machineID = machineID[:12] + "..."
			}
		}

		baseSnapshot := "-"
		if w.BaseSnapshotID != nil && *w.BaseSnapshotID != "" {
			baseSnapshot = *w.BaseSnapshotID
			if len(baseSnapshot) > 12 {
				baseSnapshot = baseSnapshot[:12]
			}
		}

		lastSeen := "never"
		if w.LastSeenAt != nil && *w.LastSeenAt != "" {
			lastSeen = formatRelativeTime(*w.LastSeenAt)
		}

		fmt.Printf("  %-12s  %-20s  %-15s  %-12s  %s\n", shortID, name, machineID, baseSnapshot, lastSeen)
	}

	fmt.Println()
	fmt.Println("* = current workspace")

	return nil
}

func newWorkspaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Workspace management commands",
		Long: `Manage workspaces for the current project.

Without subcommands, shows the current workspace status.`,
		RunE: runWorkspaceStatus,
	}

	cmd.AddCommand(newWorkspaceCreateCmd())

	return cmd
}

func runWorkspaceStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	fmt.Printf("Current workspace:\n")
	fmt.Println()
	fmt.Printf("  Name:       %s\n", cfg.WorkspaceName)
	fmt.Printf("  ID:         %s\n", cfg.WorkspaceID)
	fmt.Printf("  Project:    %s\n", cfg.ProjectID)

	if cfg.BaseSnapshotID != "" {
		fmt.Printf("  Base:       %s\n", cfg.BaseSnapshotID)
	} else {
		fmt.Printf("  Base:       (no base snapshot)\n")
	}

	fmt.Printf("  Mode:       %s\n", cfg.Mode)

	// TODO: Show drift summary when implemented

	return nil
}

func newWorkspaceCreateCmd() *cobra.Command {
	var baseSnapshotID string
	var targetDir string

	cmd := &cobra.Command{
		Use:   "create [name]",
		Short: "Create a new workspace",
		Long: `Create a new workspace for the current project.

This registers a new workspace with the cloud. If --to is specified,
it will also set up the workspace in that directory.`,
		Args: cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaceCreate(args[0], baseSnapshotID, targetDir)
		},
	}

	cmd.Flags().StringVar(&baseSnapshotID, "base", "", "Base snapshot ID for the workspace")
	cmd.Flags().StringVar(&targetDir, "to", "", "Target directory for the workspace")

	return cmd
}

func runWorkspaceCreate(name, baseSnapshotID, targetDir string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	client := api.NewClient(token)

	// Build request
	machineID := config.GetMachineID()
	req := api.CreateWorkspaceRequest{
		Name:      name,
		MachineID: &machineID,
	}

	if baseSnapshotID != "" {
		req.BaseSnapshotID = &baseSnapshotID
	}

	if targetDir != "" {
		req.LocalPath = &targetDir
	}

	fmt.Printf("Creating workspace \"%s\"...\n", name)
	workspace, err := client.CreateWorkspace(cfg.ProjectID, req)
	if err != nil {
		return fmt.Errorf("failed to create workspace: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Workspace created!")
	fmt.Println()
	fmt.Printf("  ID:   %s\n", workspace.ID)
	fmt.Printf("  Name: %s\n", workspace.Name)

	if targetDir != "" {
		fmt.Println()
		fmt.Println("To initialize this workspace in the target directory:")
		fmt.Printf("  cd %s\n", targetDir)
		fmt.Printf("  fst clone %s --workspace %s\n", cfg.ProjectID, workspace.ID)
	}

	return nil
}
