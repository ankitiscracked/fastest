package commands

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newInitCmd())
	rootCmd.AddCommand(newProjectsCmd())
	rootCmd.AddCommand(newProjectCmd())
}

func newInitCmd() *cobra.Command {
	var workspaceName string
	var noSnapshot bool
	var force bool

	cmd := &cobra.Command{
		Use:   "init [name]",
		Short: "Initialize a new Fastest project",
		Long: `Initialize a new Fastest project in the current directory.

This will:
1. Create a project (locally, or in cloud if authenticated)
2. Create a main workspace for this directory
3. Set up the local .fst/ directory
4. Create an initial snapshot of current files

Works without cloud auth - project syncs to cloud when you log in.
If no name is provided, the current directory name will be used.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInit(args, workspaceName, noSnapshot, force)
		},
	}

	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Name for this workspace (default: main)")
	cmd.Flags().BoolVar(&noSnapshot, "no-snapshot", false, "Don't create initial snapshot")
	cmd.Flags().BoolVar(&force, "force", false, "Skip safety checks (use with caution)")

	return cmd
}

func runInit(args []string, workspaceName string, noSnapshot bool, force bool) error {
	// Get current directory
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	// Check if current directory has .fst
	if _, err := os.Stat(filepath.Join(cwd, ".fst")); err == nil {
		return fmt.Errorf("already initialized - .fst exists in this directory")
	}

	// Safety checks (can be bypassed with --force)
	if !force {
		// Check for dangerous directories
		homeDir, _ := os.UserHomeDir()
		if cwd == homeDir {
			return fmt.Errorf("refusing to initialize in home directory - this would track all your files\nUse --force to override (not recommended)")
		}
		if cwd == "/" {
			return fmt.Errorf("refusing to initialize in root directory\nUse --force to override (not recommended)")
		}

		// Check if inside an existing fst project
		parentDir := filepath.Dir(cwd)
		for parentDir != "/" && parentDir != "." {
			if _, err := os.Stat(filepath.Join(parentDir, ".fst")); err == nil {
				return fmt.Errorf("already inside an fst project at %s\nUse --force to create a nested project", parentDir)
			}
			parentDir = filepath.Dir(parentDir)
		}

		// Quick file count to warn about large directories
		fileCount := 0
		filepath.Walk(cwd, func(path string, info os.FileInfo, err error) error {
			if err != nil {
				return nil
			}
			if !info.IsDir() {
				fileCount++
				if fileCount > 10000 {
					return fmt.Errorf("stopped counting") // Early exit
				}
			}
			return nil
		})

		if fileCount > 5000 {
			fmt.Printf("Warning: This directory contains %d+ files.\n", fileCount)
			fmt.Print("Are you sure you want to initialize here? [y/N] ")
			reader := bufio.NewReader(os.Stdin)
			response, _ := reader.ReadString('\n')
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "y" && response != "yes" {
				return fmt.Errorf("initialization cancelled")
			}
		}
	}

	// Determine project name
	var projectName string
	if len(args) > 0 {
		projectName = args[0]
	} else {
		projectName = filepath.Base(cwd)
	}

	// Determine workspace name
	if workspaceName == "" {
		workspaceName = "main"
	}

	// Check for auth (optional)
	token, _ := auth.GetToken()
	hasAuth := token != ""

	var projectID, workspaceID string
	var cloudSynced bool

	if hasAuth {
		// Try to create in cloud
		client := api.NewClient(token)

		fmt.Printf("Creating project \"%s\" in cloud...\n", projectName)
		project, err := client.CreateProject(projectName)
		if err != nil {
			fmt.Printf("Warning: Could not create in cloud: %v\n", err)
			fmt.Println("Continuing with local-only mode...")
			projectID = generateProjectID()
			workspaceID = generateWorkspaceID()
		} else {
			projectID = project.ID
			cloudSynced = true

			// Create workspace in cloud
			fmt.Printf("Creating workspace \"%s\"...\n", workspaceName)
			machineID := config.GetMachineID()
			workspace, err := client.CreateWorkspace(project.ID, api.CreateWorkspaceRequest{
				Name:      workspaceName,
				MachineID: &machineID,
				LocalPath: &cwd,
			})
			if err != nil {
				fmt.Printf("Warning: Could not create workspace in cloud: %v\n", err)
				workspaceID = generateWorkspaceID()
			} else {
				workspaceID = workspace.ID
			}
		}
	} else {
		// Local-only mode
		fmt.Printf("Creating project \"%s\" (local)...\n", projectName)
		projectID = generateProjectID()
		workspaceID = generateWorkspaceID()
	}

	// Create .fst directory structure (main workspace)
	fstDir := filepath.Join(cwd, ".fst")
	if err := os.MkdirAll(fstDir, 0755); err != nil {
		return fmt.Errorf("failed to create .fst directory: %w", err)
	}

	// Create subdirectories including workspaces/ for linked workspaces
	for _, subdir := range []string{"cache", "cache/blobs", "cache/manifests", "workspaces"} {
		if err := os.MkdirAll(filepath.Join(fstDir, subdir), 0755); err != nil {
			return fmt.Errorf("failed to create %s: %w", subdir, err)
		}
	}

	// Create initial snapshot if not disabled
	var snapshotID string
	if !noSnapshot {
		fmt.Println("Creating initial snapshot...")

		m, err := manifest.Generate(cwd, false)
		if err != nil {
			return fmt.Errorf("failed to generate manifest: %w", err)
		}

		manifestHash, err := m.Hash()
		if err != nil {
			return fmt.Errorf("failed to hash manifest: %w", err)
		}

		snapshotID = "snap-" + manifestHash[:16]

		// Cache blobs
		blobDir := filepath.Join(fstDir, "cache", "blobs")
		for _, f := range m.Files {
			blobPath := filepath.Join(blobDir, f.Hash)
			if _, err := os.Stat(blobPath); err == nil {
				continue
			}
			srcPath := filepath.Join(cwd, f.Path)
			content, err := os.ReadFile(srcPath)
			if err != nil {
				continue
			}
			os.WriteFile(blobPath, content, 0644)
		}

		// Save manifest
		manifestJSON, err := m.ToJSON()
		if err != nil {
			return fmt.Errorf("failed to serialize manifest: %w", err)
		}

		manifestPath := filepath.Join(fstDir, "cache", "manifests", snapshotID+".json")
		if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
			return fmt.Errorf("failed to save manifest: %w", err)
		}

		// Save metadata
		metadataPath := filepath.Join(fstDir, "cache", "manifests", snapshotID+".meta.json")
		metadata := fmt.Sprintf(`{
  "id": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_id": "",
  "message": "Initial snapshot",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, manifestHash, time.Now().UTC().Format(time.RFC3339), m.FileCount(), m.TotalSize())

		if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
			return fmt.Errorf("failed to save metadata: %w", err)
		}

		fmt.Printf("Captured %d files.\n", m.FileCount())
	}

	// Write config (main workspace)
	configData := fmt.Sprintf(`{
  "project_id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "base_snapshot_id": "%s",
  "mode": "%s",
  "is_main": true
}`, projectID, workspaceID, workspaceName, snapshotID, modeString(cloudSynced))

	configPath := filepath.Join(fstDir, "config.json")
	if err := os.WriteFile(configPath, []byte(configData), 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Create .gitignore for .fst
	gitignore := `# Fastest local cache
cache/
workspaces/
*.log
`
	if err := os.WriteFile(filepath.Join(fstDir, ".gitignore"), []byte(gitignore), 0644); err != nil {
		return fmt.Errorf("failed to write .gitignore: %w", err)
	}

	// Register workspace in global registry
	if err := RegisterWorkspace(RegisteredWorkspace{
		ID:             workspaceID,
		ProjectID:      projectID,
		Name:           workspaceName,
		Path:           cwd,
		BaseSnapshotID: snapshotID,
		CreatedAt:      time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace: %v\n", err)
	}

	fmt.Println()
	fmt.Println("✓ Project initialized!")
	fmt.Println()
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  Workspace: %s (main)\n", workspaceName)
	fmt.Printf("  Directory: %s\n", cwd)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}
	if !cloudSynced {
		fmt.Println("  (local only - run 'fst login' to sync to cloud)")
	}
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  fst drift       # Check for changes")
	fmt.Println("  fst copy -n feature -t ../feature  # Create linked workspace")

	return nil
}

func generateProjectID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "proj-" + hex.EncodeToString(bytes)
}

func generateWorkspaceID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "ws-" + hex.EncodeToString(bytes)
}

func modeString(cloudSynced bool) string {
	if cloudSynced {
		return "cloud"
	}
	return "local"
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
