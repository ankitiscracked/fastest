package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	rootCmd.AddCommand(newInitCmd())
	rootCmd.AddCommand(newProjectsCmd())
	rootCmd.AddCommand(newProjectCmd())
}

func newInitCmd() *cobra.Command {
	var workspaceName string

	cmd := &cobra.Command{
		Use:   "init [name]",
		Short: "Initialize a new Fastest project",
		Long: `Initialize a new Fastest project in the current directory.

This will:
1. Create a new project in the cloud
2. Create a workspace for this directory
3. Set up the local .fst/ directory with configuration

If no name is provided, the current directory name will be used.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInit(args, workspaceName)
		},
	}

	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Name for this workspace (default: machine hostname)")

	return cmd
}

func runInit(args []string, workspaceName string) error {
	// Check if already initialized
	if config.IsInitialized() {
		return fmt.Errorf("already initialized - .fst/ directory exists")
	}

	// Get auth token
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	// Determine project name
	var projectName string
	if len(args) > 0 {
		projectName = args[0]
	} else {
		cwd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("failed to get current directory: %w", err)
		}
		projectName = filepath.Base(cwd)
	}

	// Determine workspace name
	if workspaceName == "" {
		workspaceName = config.GetMachineID()
	}

	// Get current directory for local_path
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	client := api.NewClient(token)

	// Create project
	fmt.Printf("Creating project \"%s\"...\n", projectName)
	project, err := client.CreateProject(projectName)
	if err != nil {
		return fmt.Errorf("failed to create project: %w", err)
	}

	// Create workspace
	fmt.Printf("Creating workspace \"%s\"...\n", workspaceName)
	machineID := config.GetMachineID()
	workspace, err := client.CreateWorkspace(project.ID, api.CreateWorkspaceRequest{
		Name:      workspaceName,
		MachineID: &machineID,
		LocalPath: &cwd,
	})
	if err != nil {
		return fmt.Errorf("failed to create workspace: %w", err)
	}

	// Initialize local config
	fmt.Println("Initializing local configuration...")
	if err := config.Init(project.ID, projectName, workspace.ID, workspaceName); err != nil {
		return fmt.Errorf("failed to initialize local config: %w", err)
	}

	fmt.Println()
	fmt.Println("✓ Project initialized successfully!")
	fmt.Println()
	fmt.Printf("  Project:   %s (%s)\n", projectName, project.ID[:8]+"...")
	fmt.Printf("  Workspace: %s (%s)\n", workspaceName, workspace.ID[:8]+"...")
	fmt.Printf("  Directory: %s\n", cwd)
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  fst snapshot    # Capture current state")
	fmt.Println("  fst drift       # Check for changes")
	fmt.Println("  fst watch       # Start monitoring")

	return nil
}

func newProjectsCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "projects",
		Aliases: []string{"ps"},
		Short:   "List your projects",
		RunE:    runProjects,
	}
}

func runProjects(cmd *cobra.Command, args []string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	client := api.NewClient(token)
	projects, err := client.ListProjects()
	if err != nil {
		return fmt.Errorf("failed to list projects: %w", err)
	}

	if len(projects) == 0 {
		fmt.Println("No projects found.")
		fmt.Println()
		fmt.Println("Create one with: fst init [name]")
		return nil
	}

	fmt.Println("Your projects:")
	fmt.Println()

	// Table header
	fmt.Printf("  %-12s  %-30s  %s\n", "ID", "NAME", "UPDATED")
	fmt.Printf("  %-12s  %-30s  %s\n", strings.Repeat("-", 12), strings.Repeat("-", 30), strings.Repeat("-", 20))

	for _, p := range projects {
		updatedAt := formatRelativeTime(p.UpdatedAt)
		shortID := p.ID
		if len(shortID) > 12 {
			shortID = shortID[:12]
		}
		name := p.Name
		if len(name) > 30 {
			name = name[:27] + "..."
		}
		fmt.Printf("  %-12s  %-30s  %s\n", shortID, name, updatedAt)
	}

	return nil
}

func newProjectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "project [id]",
		Short: "Show project details",
		Long: `Show details for a specific project.

If no ID is provided and you're in a project directory, shows the current project.`,
		Args: cobra.MaximumNArgs(1),
		RunE: runProject,
	}
}

func runProject(cmd *cobra.Command, args []string) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	var projectID string
	if len(args) > 0 {
		projectID = args[0]
	} else {
		// Try to get from local config
		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("no project ID provided and not in a project directory")
		}
		projectID = cfg.ProjectID
	}

	client := api.NewClient(token)
	project, workspaces, err := client.GetProject(projectID)
	if err != nil {
		return fmt.Errorf("failed to get project: %w", err)
	}

	fmt.Printf("Project: %s\n", project.Name)
	fmt.Printf("ID: %s\n", project.ID)
	fmt.Printf("Created: %s\n", formatRelativeTime(project.CreatedAt))
	fmt.Printf("Updated: %s\n", formatRelativeTime(project.UpdatedAt))

	if project.LastSnapshotID != nil {
		fmt.Printf("Last Snapshot: %s\n", *project.LastSnapshotID)
	}

	fmt.Println()

	if len(workspaces) == 0 {
		fmt.Println("No workspaces.")
	} else {
		fmt.Printf("Workspaces (%d):\n", len(workspaces))
		fmt.Println()
		fmt.Printf("  %-12s  %-20s  %-15s  %s\n", "ID", "NAME", "MACHINE", "LAST SEEN")
		fmt.Printf("  %-12s  %-20s  %-15s  %s\n",
			strings.Repeat("-", 12),
			strings.Repeat("-", 20),
			strings.Repeat("-", 15),
			strings.Repeat("-", 15))

		for _, w := range workspaces {
			shortID := w.ID
			if len(shortID) > 12 {
				shortID = shortID[:12]
			}
			name := w.Name
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
			lastSeen := "never"
			if w.LastSeenAt != nil && *w.LastSeenAt != "" {
				lastSeen = formatRelativeTime(*w.LastSeenAt)
			}
			fmt.Printf("  %-12s  %-20s  %-15s  %s\n", shortID, name, machineID, lastSeen)
		}
	}

	return nil
}

// formatRelativeTime formats a timestamp as a human-readable relative time
func formatRelativeTime(timestamp string) string {
	t, err := time.Parse(time.RFC3339, timestamp)
	if err != nil {
		// Try without timezone
		t, err = time.Parse("2006-01-02T15:04:05", timestamp)
		if err != nil {
			return timestamp
		}
	}

	diff := time.Since(t)

	switch {
	case diff < time.Minute:
		return "just now"
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins == 1 {
			return "1 minute ago"
		}
		return fmt.Sprintf("%d minutes ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		if hours == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		if days == 1 {
			return "1 day ago"
		}
		return fmt.Sprintf("%d days ago", days)
	default:
		return t.Format("Jan 2, 2006")
	}
}
