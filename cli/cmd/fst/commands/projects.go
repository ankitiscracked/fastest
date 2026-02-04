package commands

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/index"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newProjectsCmd()) })
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

	cmd.Flags().StringVarP(&workspaceName, "workspace", "w", "", "Name for this workspace (must match directory name)")
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

	// Check for project folder (fst.json)
	parentRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err != nil && !errors.Is(err, config.ErrParentNotFound) {
		return err
	}
	if errors.Is(err, config.ErrParentNotFound) {
		return fmt.Errorf("no project folder found - run 'fst project init' first")
	}
	if err == nil {
		if cwd == parentRoot {
			return fmt.Errorf("cannot initialize in project folder - create a workspace directory instead")
		}
		if filepath.Dir(cwd) != parentRoot {
			return fmt.Errorf("workspace must be a direct child of the project folder (%s)", parentRoot)
		}
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
	if parentCfg != nil {
		projectName = parentCfg.ProjectName
		if len(args) > 0 && args[0] != projectName {
			return fmt.Errorf("project name must match project folder name (%s)", projectName)
		}
	} else if len(args) > 0 {
		projectName = args[0]
	} else {
		projectName = filepath.Base(cwd)
	}

	// Determine workspace name
	defaultWorkspaceName := filepath.Base(cwd)
	if workspaceName == "" {
		workspaceName = defaultWorkspaceName
	} else if workspaceName != defaultWorkspaceName {
		return fmt.Errorf("workspace name must match directory name (%s)", defaultWorkspaceName)
	}

	// Check for auth (optional)
	token, err := deps.AuthGetToken()
	if err != nil {
		fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
	}
	hasAuth := token != ""

	var projectID, workspaceID string
	var cloudSynced bool

	if parentCfg != nil {
		projectID = parentCfg.ProjectID
		workspaceID = generateWorkspaceID()
		cloudSynced = false
	} else if hasAuth {
		// Try to create in cloud
		client := deps.NewAPIClient(token, nil)

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

	// Create .fst directory structure using config.InitAt
	if err := config.InitAt(cwd, projectID, workspaceID, workspaceName, ""); err != nil {
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}

	// Create initial snapshot if not disabled
	var snapshotID string
	if !noSnapshot {
		snapshotID, err = createInitialSnapshot(cwd, workspaceID, workspaceName, cloudSynced)
		if err != nil {
			return err
		}
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
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Directory: %s\n", cwd)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}
	if !cloudSynced {
		fmt.Println("  (local only - run 'fst login' to sync to cloud)")
	}
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Println("  fst drift                       # Check for changes")
	fmt.Println("  fst workspace copy -n feature   # Create a workspace copy")

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
	cmd := &cobra.Command{
		Use:     "projects",
		Aliases: []string{"ps"},
		Short:   "List your projects",
		RunE:    runProjects,
	}
	cmd.AddCommand(newProjectCmd())
	return cmd
}

func runProjects(cmd *cobra.Command, args []string) error {
	var cloudProjects []api.Project

	idx, err := index.Load()
	if err != nil {
		return fmt.Errorf("failed to load local index: %w", err)
	}

	token, err := deps.AuthGetToken()
	if err != nil {
		fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
	}
	if token != "" {
		client := deps.NewAPIClient(token, nil)
		projects, err := client.ListProjects()
		if err != nil {
			fmt.Printf("Warning: failed to list cloud projects: %v\n", err)
		} else {
			cloudProjects = projects
		}
	}

	merged := map[string]*mergedProject{}
	for _, p := range idx.Projects {
		merged[p.ProjectID] = &mergedProject{
			ID:          p.ProjectID,
			Name:        p.ProjectName,
			LocalPath:   p.ProjectPath,
			LocalSeenAt: p.LastSeenAt,
			Local:       true,
		}
	}
	for _, p := range cloudProjects {
		entry, ok := merged[p.ID]
		if !ok {
			entry = &mergedProject{ID: p.ID}
			merged[p.ID] = entry
		}
		entry.Name = p.Name
		entry.CloudUpdatedAt = p.UpdatedAt
		entry.Cloud = true
	}

	rows := make([]mergedProject, 0, len(merged))
	for _, p := range merged {
		p.LocationTag = locationTag(p.Local, p.Cloud)
		rows = append(rows, *p)
	}

	if len(rows) == 0 {
		fmt.Println("No projects found.")
		fmt.Println()
		fmt.Println("Create one with: fst project init [name]")
		return nil
	}

	sort.Slice(rows, func(i, j int) bool {
		return strings.ToLower(rows[i].Name) < strings.ToLower(rows[j].Name)
	})

	fmt.Println("Your projects:")
	fmt.Println()

	fmt.Printf("  %-12s  %-30s  %-10s  %s\n", "ID", "NAME", "LOC", "UPDATED")
	fmt.Printf("  %-12s  %-30s  %-10s  %s\n",
		strings.Repeat("-", 12),
		strings.Repeat("-", 30),
		strings.Repeat("-", 10),
		strings.Repeat("-", 20))

	ids := make([]string, 0, len(rows))
	for _, p := range rows {
		ids = append(ids, p.ID)
	}
	shortIDs := shortenIDs(ids, 12)

	for _, p := range rows {
		updatedAt := formatProjectUpdatedAt(p.CloudUpdatedAt, p.LocalSeenAt)
		shortID := shortIDs[p.ID]
		name := p.Name
		if len(name) > 30 {
			name = name[:27] + "..."
		}
		fmt.Printf("  %-12s  %-30s  %-10s  %s\n", shortID, name, p.LocationTag, updatedAt)
	}

	return nil
}

func newProjectCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "show [id|name]",
		Short: "Show project details",
		Long: `Show details for a specific project.

If no ID is provided and you're in a workspace directory, shows the current project.`,
		Args: cobra.MaximumNArgs(1),
		RunE: runProject,
	}
}

func runProject(cmd *cobra.Command, args []string) error {
	var projectArg string
	if len(args) > 0 {
		projectArg = args[0]
	}

	var projectID string
	if projectArg == "" {
		// Try to get from local config
		cfg, err := config.Load()
		if err != nil {
			return fmt.Errorf("no project ID provided and not in a workspace directory")
		}
		projectID = cfg.ProjectID
	}

	idx, err := index.Load()
	if err != nil {
		return fmt.Errorf("failed to load local index: %w", err)
	}

	var cloudProject *api.Project
	var cloudWorkspaces []api.Workspace
	var cloudProjects []api.Project

	token, err := deps.AuthGetToken()
	if err != nil {
		fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
	}
	if token != "" {
		client := deps.NewAPIClient(token, nil)
		projects, err := client.ListProjects()
		if err != nil {
			fmt.Printf("Warning: failed to list cloud projects: %v\n", err)
		} else {
			cloudProjects = projects
		}
		if projectArg != "" {
			resolvedID, err := resolveProjectID(projectArg, idx, cloudProjects)
			if err != nil {
				return err
			}
			projectID = resolvedID
		}
		project, workspaces, err := client.GetProject(projectID)
		if err != nil {
			fmt.Printf("Warning: failed to fetch project from cloud: %v\n", err)
		} else {
			cloudProject = project
			cloudWorkspaces = workspaces
		}
	} else if projectArg != "" {
		resolvedID, err := resolveProjectID(projectArg, idx, nil)
		if err != nil {
			return err
		}
		projectID = resolvedID
	}

	var localProject *index.ProjectEntry
	for i := range idx.Projects {
		if idx.Projects[i].ProjectID == projectID {
			localProject = &idx.Projects[i]
			break
		}
	}
	if cloudProject == nil && localProject == nil {
		return fmt.Errorf("project not found locally and not available from cloud")
	}

	projectName := projectID
	if cloudProject != nil && cloudProject.Name != "" {
		projectName = cloudProject.Name
	} else if localProject != nil && localProject.ProjectName != "" {
		projectName = localProject.ProjectName
	}

	fmt.Printf("Project: %s\n", projectName)
	fmt.Printf("ID: %s\n", projectID)
	fmt.Printf("Location: %s\n", locationTag(localProject != nil, cloudProject != nil))
	if cloudProject != nil {
		fmt.Printf("Created: %s\n", formatRelativeTime(cloudProject.CreatedAt))
		fmt.Printf("Updated: %s\n", formatRelativeTime(cloudProject.UpdatedAt))
		if cloudProject.LastSnapshotID != nil {
			fmt.Printf("Last Snapshot: %s\n", *cloudProject.LastSnapshotID)
		}
	}
	if localProject != nil {
		if localProject.ProjectPath != "" {
			fmt.Printf("Path: %s\n", localProject.ProjectPath)
		}
		if localProject.LastSeenAt != "" {
			fmt.Printf("Last Seen: %s\n", formatRelativeTime(localProject.LastSeenAt))
		}
	}

	fmt.Println()

	localWorkspaces := map[string]index.WorkspaceEntry{}
	for _, ws := range idx.Workspaces {
		if ws.ProjectID == projectID {
			localWorkspaces[ws.WorkspaceID] = ws
		}
	}

	merged := map[string]*mergedWorkspace{}
	for _, ws := range localWorkspaces {
		merged[ws.WorkspaceID] = &mergedWorkspace{
			ID:          ws.WorkspaceID,
			Name:        ws.WorkspaceName,
			Path:        ws.Path,
			ProjectID:   ws.ProjectID,
			Local:       true,
			LocationTag: "local",
		}
	}
	for _, ws := range cloudWorkspaces {
		entry, ok := merged[ws.ID]
		if !ok {
			entry = &mergedWorkspace{
				ID:        ws.ID,
				Name:      ws.Name,
				ProjectID: ws.ProjectID,
			}
			merged[ws.ID] = entry
		}
		if entry.Name == "" {
			entry.Name = ws.Name
		}
		entry.Cloud = true
	}

	workspaces := make([]mergedWorkspace, 0, len(merged))
	for _, ws := range merged {
		ws.LocationTag = locationTag(ws.Local, ws.Cloud)
		workspaces = append(workspaces, *ws)
	}

	if len(workspaces) == 0 {
		fmt.Println("No workspaces.")
		return nil
	}

	sort.Slice(workspaces, func(i, j int) bool {
		return strings.ToLower(workspaces[i].Name) < strings.ToLower(workspaces[j].Name)
	})

	fmt.Printf("Workspaces (%d):\n", len(workspaces))
	fmt.Println()
	fmt.Printf("  %-12s  %-10s  %-20s  %-35s  %s\n", "ID", "LOC", "NAME", "PATH", "LAST SEEN")
	fmt.Printf("  %-12s  %-10s  %-20s  %-35s  %s\n",
		strings.Repeat("-", 12),
		strings.Repeat("-", 10),
		strings.Repeat("-", 20),
		strings.Repeat("-", 35),
		strings.Repeat("-", 15))

	workspaceIDs := make([]string, 0, len(workspaces))
	for _, w := range workspaces {
		workspaceIDs = append(workspaceIDs, w.ID)
	}
	shortWorkspaceIDs := shortenIDs(workspaceIDs, 12)

	for _, w := range workspaces {
		shortID := shortWorkspaceIDs[w.ID]
		name := w.Name
		if len(name) > 20 {
			name = name[:17] + "..."
		}
		displayPath := w.Path
		if displayPath == "" {
			displayPath = "-"
		}
		if len(displayPath) > 35 {
			displayPath = "..." + displayPath[len(displayPath)-32:]
		}
		lastSeen := "-"
		if w.Local {
			if local, ok := localWorkspaces[w.ID]; ok && local.LastSeenAt != "" {
				lastSeen = formatRelativeTime(local.LastSeenAt)
			}
		}
		fmt.Printf("  %-12s  %-10s  %-20s  %-35s  %s\n", shortID, w.LocationTag, name, displayPath, lastSeen)
	}

	return nil
}

type mergedProject struct {
	ID             string
	Name           string
	LocalPath      string
	LocalSeenAt    string
	CloudUpdatedAt string
	Local          bool
	Cloud          bool
	LocationTag    string
}

func locationTag(local, cloud bool) string {
	switch {
	case local && cloud:
		return "local+cloud"
	case local:
		return "local"
	case cloud:
		return "cloud"
	default:
		return "-"
	}
}

func formatProjectUpdatedAt(cloudUpdatedAt, localSeenAt string) string {
	if cloudUpdatedAt != "" {
		return formatRelativeTime(cloudUpdatedAt)
	}
	if localSeenAt != "" {
		return formatRelativeTime(localSeenAt)
	}
	return "-"
}

func resolveProjectID(input string, idx *index.Index, cloudProjects []api.Project) (string, error) {
	if input == "" {
		return "", fmt.Errorf("project name or ID is required")
	}

	for _, p := range cloudProjects {
		if p.ID == input {
			return p.ID, nil
		}
	}
	if idx != nil {
		for _, p := range idx.Projects {
			if p.ProjectID == input {
				return p.ProjectID, nil
			}
		}
	}

	if strings.HasPrefix(input, "proj-") {
		localCount := 0
		if idx != nil {
			localCount = len(idx.Projects)
		}
		ids := make([]string, 0, len(cloudProjects)+localCount)
		for _, p := range cloudProjects {
			ids = append(ids, p.ID)
		}
		if idx != nil {
			for _, p := range idx.Projects {
				ids = append(ids, p.ProjectID)
			}
		}
		if resolved, err := resolveIDPrefix(input, ids, "project"); err == nil {
			return resolved, nil
		} else if !strings.Contains(err.Error(), "not found") {
			return "", err
		}
	}

	matches := map[string]bool{}
	for _, p := range cloudProjects {
		if p.Name == input {
			matches[p.ID] = true
		}
	}
	if idx != nil {
		for _, p := range idx.Projects {
			if p.ProjectName == input {
				matches[p.ProjectID] = true
			}
		}
	}

	if len(matches) == 1 {
		for id := range matches {
			return id, nil
		}
	}
	if len(matches) > 1 {
		ids := make([]string, 0, len(matches))
		for id := range matches {
			ids = append(ids, id)
		}
		sort.Strings(ids)
		return "", fmt.Errorf("multiple projects named %q: %s", input, strings.Join(ids, ", "))
	}

	return "", fmt.Errorf("project %q not found", input)
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
