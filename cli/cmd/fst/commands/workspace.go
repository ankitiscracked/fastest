package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
)

func init() {
	rootCmd.AddCommand(newWorkspacesCmd())
	rootCmd.AddCommand(newWorkspaceCmd())
}

// WorkspaceRegistry holds all registered workspaces
type WorkspaceRegistry struct {
	Workspaces []RegisteredWorkspace `json:"workspaces"`
}

// RegisteredWorkspace represents a workspace in the registry
type RegisteredWorkspace struct {
	ID             string `json:"id"`
	ProjectID      string `json:"project_id"`
	Name           string `json:"name"`
	Path           string `json:"path"`
	BaseSnapshotID string `json:"base_snapshot_id"`
	CreatedAt      string `json:"created_at"`
}

// GetRegistryPath returns the path to the workspace registry
func GetRegistryPath() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(homeDir, ".config", "fst", "workspaces.json"), nil
}

// LoadRegistry loads the workspace registry
func LoadRegistry() (*WorkspaceRegistry, error) {
	path, err := GetRegistryPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &WorkspaceRegistry{Workspaces: []RegisteredWorkspace{}}, nil
		}
		return nil, err
	}

	var registry WorkspaceRegistry
	if err := json.Unmarshal(data, &registry); err != nil {
		return nil, err
	}

	return &registry, nil
}

// SaveRegistry saves the workspace registry
func SaveRegistry(registry *WorkspaceRegistry) error {
	path, err := GetRegistryPath()
	if err != nil {
		return err
	}

	// Ensure directory exists
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(registry, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

// RegisterWorkspace adds a workspace to the registry
func RegisterWorkspace(ws RegisteredWorkspace) error {
	registry, err := LoadRegistry()
	if err != nil {
		return err
	}

	// Check if already registered (by path)
	for i, existing := range registry.Workspaces {
		if existing.Path == ws.Path {
			// Update existing entry
			registry.Workspaces[i] = ws
			return SaveRegistry(registry)
		}
	}

	// Add new entry
	registry.Workspaces = append(registry.Workspaces, ws)
	return SaveRegistry(registry)
}

// UnregisterWorkspace removes a workspace from the registry
func UnregisterWorkspace(path string) error {
	registry, err := LoadRegistry()
	if err != nil {
		return err
	}

	filtered := []RegisteredWorkspace{}
	for _, ws := range registry.Workspaces {
		if ws.Path != path {
			filtered = append(filtered, ws)
		}
	}

	registry.Workspaces = filtered
	return SaveRegistry(registry)
}

func newWorkspacesCmd() *cobra.Command {
	var showAll bool

	cmd := &cobra.Command{
		Use:     "workspaces",
		Aliases: []string{"ws"},
		Short:   "List workspaces for this project",
		Long: `List all registered workspaces for the current project.

Shows workspace name, path, base snapshot, and current drift status.
Use --all to show workspaces from all projects.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runWorkspaces(showAll)
		},
	}

	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show workspaces from all projects")

	return cmd
}

func runWorkspaces(showAll bool) error {
	var currentProjectID string

	if !showAll {
		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("not in a project directory - use --all to see all workspaces")
		}
		currentProjectID = cfg.ProjectID
	}

	registry, err := LoadRegistry()
	if err != nil {
		return fmt.Errorf("failed to load workspace registry: %w", err)
	}

	// Filter workspaces
	var workspaces []RegisteredWorkspace
	for _, ws := range registry.Workspaces {
		if showAll || ws.ProjectID == currentProjectID {
			workspaces = append(workspaces, ws)
		}
	}

	if len(workspaces) == 0 {
		if showAll {
			fmt.Println("No workspaces registered.")
		} else {
			fmt.Println("No workspaces found for this project.")
		}
		fmt.Println()
		fmt.Println("Create one with: fst init")
		return nil
	}

	// Get current workspace path for highlighting
	currentPath := ""
	if root, err := config.FindProjectRoot(); err == nil {
		currentPath = root
	}

	// Display header
	if showAll {
		fmt.Printf("All workspaces (%d):\n\n", len(workspaces))
	} else {
		fmt.Printf("Workspaces for project (%d):\n\n", len(workspaces))
	}

	// Table header
	fmt.Printf("  %-10s  %-15s  %-35s  %s\n", "STATUS", "NAME", "PATH", "DRIFT")
	fmt.Printf("  %-10s  %-15s  %-35s  %s\n",
		strings.Repeat("-", 10),
		strings.Repeat("-", 15),
		strings.Repeat("-", 35),
		strings.Repeat("-", 15))

	for _, ws := range workspaces {
		displayWorkspace(ws, currentPath)
	}

	return nil
}

func displayWorkspace(ws RegisteredWorkspace, currentPath string) {
	// Check if this is the current workspace
	isCurrent := ws.Path == currentPath
	indicator := " "
	if isCurrent {
		indicator = "*"
	}

	// Check if workspace still exists
	status := "ok"
	exists := true
	if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); os.IsNotExist(err) {
		status = "missing"
		exists = false
	}

	// Get drift info if workspace exists
	driftStr := "-"
	if exists {
		// Try to compute drift
		report, err := drift.ComputeFromCache(ws.Path)
		if err == nil && report.HasChanges() {
			driftStr = fmt.Sprintf("+%d ~%d -%d",
				len(report.FilesAdded),
				len(report.FilesModified),
				len(report.FilesDeleted))
		} else if err == nil {
			driftStr = "clean"
		}
	}

	// Truncate path for display
	displayPath := ws.Path
	if len(displayPath) > 35 {
		displayPath = "..." + displayPath[len(displayPath)-32:]
	}

	// Truncate name
	name := ws.Name
	if len(name) > 15 {
		name = name[:12] + "..."
	}

	// Status with color
	statusStr := status
	if status == "missing" {
		statusStr = "\033[31mmissing\033[0m"
	} else if isCurrent {
		statusStr = "\033[32mcurrent\033[0m"
	}

	fmt.Printf("%s %-10s  %-15s  %-35s  %s\n",
		indicator,
		statusStr,
		name,
		displayPath,
		driftStr)
}

func newWorkspaceCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Show current workspace status",
		Long: `Show the status of the current workspace.

Displays workspace name, ID, project, base snapshot, and mode.`,
		RunE: runWorkspaceStatus,
	}

	return cmd
}

func runWorkspaceStatus(cmd *cobra.Command, args []string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, _ := config.FindProjectRoot()

	fmt.Printf("Current workspace:\n")
	fmt.Println()
	fmt.Printf("  Name:       %s\n", cfg.WorkspaceName)
	fmt.Printf("  ID:         %s\n", cfg.WorkspaceID)
	fmt.Printf("  Project:    %s\n", cfg.ProjectID)
	fmt.Printf("  Directory:  %s\n", root)

	if cfg.BaseSnapshotID != "" {
		fmt.Printf("  Base:       %s\n", cfg.BaseSnapshotID)
	} else {
		fmt.Printf("  Base:       (no base snapshot)\n")
	}

	fmt.Printf("  Mode:       %s\n", cfg.Mode)

	// Show drift summary
	report, err := drift.ComputeFromCache(root)
	if err == nil {
		fmt.Println()
		if report.HasChanges() {
			fmt.Printf("  Drift:      +%d added, ~%d modified, -%d deleted\n",
				len(report.FilesAdded),
				len(report.FilesModified),
				len(report.FilesDeleted))
		} else {
			fmt.Printf("  Drift:      clean (no changes)\n")
		}
	}

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
