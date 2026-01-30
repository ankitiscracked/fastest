package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
)

// wsStatus tracks status info for a workspace
type wsStatus struct {
	ws       RegisteredWorkspace
	exists   bool
	added    int
	modified int
	deleted  int
	total    int
}

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newStatusCmd()) })
}

func newStatusCmd() *cobra.Command {
	var showAll bool
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show workspace status",
		Long: `Show the current workspace status, or all workspaces with --all.

Without flags, shows detailed status of the current workspace:
- Workspace name and path
- Fork snapshot info
- Upstream workspace (if any)
- Current drift (files changed since base)

With --all, shows a summary of all workspaces in the project:
- Each workspace's drift status
- Highlights the current workspace
- Shows overlapping files if any

Examples:
  fst status          # Current workspace status
  fst status --all    # All workspaces overview`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if showAll {
				return runStatusAll(jsonOutput)
			}
			return runStatus(jsonOutput)
		},
	}

	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show all workspaces in the project")
	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")

	return cmd
}

func runStatus(jsonOutput bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Get drift from base
	var driftReport *drift.Report
	if cfg.ForkSnapshotID != "" {
		driftReport, err = drift.ComputeFromCache(root)
		if err != nil {
			// Non-fatal, just won't show drift
			driftReport = nil
		}
	}

	// Get upstream info
	upstreamID, upstreamName, _ := drift.GetUpstreamWorkspace(root)

	// Get fork snapshot time
	var baseTime string
	if cfg.ForkSnapshotID != "" {
		snapshotsDir, _ := config.GetSnapshotsDir()
		metaPath := filepath.Join(snapshotsDir, cfg.ForkSnapshotID+".meta.json")
		if info, err := os.Stat(metaPath); err == nil {
			baseTime = formatTimeAgo(info.ModTime())
		}
	}

	if jsonOutput {
		return printStatusJSON(cfg, root, driftReport, upstreamName, baseTime)
	}

	return printStatusHuman(cfg, root, driftReport, upstreamID, upstreamName, baseTime)
}

func printStatusHuman(cfg *config.ProjectConfig, root string, driftReport *drift.Report, upstreamID, upstreamName, baseTime string) error {
	fmt.Printf("Workspace: \033[1m%s\033[0m\n", cfg.WorkspaceName)
	fmt.Printf("Path:      %s\n", root)
	fmt.Println()

	// Fork snapshot
	if cfg.ForkSnapshotID != "" {
		fmt.Printf("Fork:      %s", cfg.ForkSnapshotID)
		if baseTime != "" {
			fmt.Printf(" (%s)", baseTime)
		}
		fmt.Println()
	} else {
		fmt.Println("Fork:      (none)")
	}

	// Upstream
	if upstreamName != "" {
		fmt.Printf("Upstream:  %s\n", upstreamName)
	}

	fmt.Println()

	// Drift
	if driftReport == nil {
		fmt.Println("Drift:     (unable to compute)")
	} else if !driftReport.HasChanges() {
		fmt.Println("\033[32m✓ No changes from fork snapshot\033[0m")
	} else {
		added := len(driftReport.FilesAdded)
		modified := len(driftReport.FilesModified)
		deleted := len(driftReport.FilesDeleted)
		total := added + modified + deleted

		fmt.Printf("Drift:     \033[33m%d files changed\033[0m (+%d ~%d -%d)\n",
			total, added, modified, deleted)
		fmt.Println()

		// Show files (limited)
		maxShow := 10
		shown := 0

		if added > 0 {
			fmt.Println("  Added:")
			for i, f := range driftReport.FilesAdded {
				if shown >= maxShow {
					fmt.Printf("    ... and %d more\n", total-shown)
					break
				}
				fmt.Printf("    \033[32m+ %s\033[0m\n", f)
				shown++
				if i >= 4 && added > 5 {
					fmt.Printf("    ... and %d more added\n", added-i-1)
					shown += added - i - 1
					break
				}
			}
		}

		if modified > 0 && shown < maxShow {
			fmt.Println("  Modified:")
			for i, f := range driftReport.FilesModified {
				if shown >= maxShow {
					fmt.Printf("    ... and %d more\n", total-shown)
					break
				}
				fmt.Printf("    \033[33m~ %s\033[0m\n", f)
				shown++
				if i >= 4 && modified > 5 {
					fmt.Printf("    ... and %d more modified\n", modified-i-1)
					shown += modified - i - 1
					break
				}
			}
		}

		if deleted > 0 && shown < maxShow {
			fmt.Println("  Deleted:")
			for i, f := range driftReport.FilesDeleted {
				if shown >= maxShow {
					fmt.Printf("    ... and %d more\n", total-shown)
					break
				}
				fmt.Printf("    \033[31m- %s\033[0m\n", f)
				shown++
				if i >= 4 && deleted > 5 {
					fmt.Printf("    ... and %d more deleted\n", deleted-i-1)
					shown += deleted - i - 1
					break
				}
			}
		}
	}

	return nil
}

func printStatusJSON(cfg *config.ProjectConfig, root string, driftReport *drift.Report, upstreamName, baseTime string) error {
	fmt.Println("{")
	fmt.Printf("  \"workspace_name\": %q,\n", cfg.WorkspaceName)
	fmt.Printf("  \"workspace_id\": %q,\n", cfg.WorkspaceID)
	fmt.Printf("  \"path\": %q,\n", root)
	fmt.Printf("  \"fork_snapshot_id\": %q,\n", cfg.ForkSnapshotID)
	if upstreamName != "" {
		fmt.Printf("  \"upstream\": %q,\n", upstreamName)
	}

	if driftReport != nil {
		fmt.Printf("  \"files_added\": %d,\n", len(driftReport.FilesAdded))
		fmt.Printf("  \"files_modified\": %d,\n", len(driftReport.FilesModified))
		fmt.Printf("  \"files_deleted\": %d\n", len(driftReport.FilesDeleted))
	} else {
		fmt.Printf("  \"files_added\": 0,\n")
		fmt.Printf("  \"files_modified\": 0,\n")
		fmt.Printf("  \"files_deleted\": 0\n")
	}
	fmt.Println("}")
	return nil
}

func runStatusAll(jsonOutput bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	// Load workspace registry
	registry, err := LoadRegistry()
	if err != nil {
		return fmt.Errorf("failed to load workspace registry: %w", err)
	}

	// Filter to workspaces in this project
	var projectWorkspaces []RegisteredWorkspace
	for _, ws := range registry.Workspaces {
		if ws.ProjectID == cfg.ProjectID {
			projectWorkspaces = append(projectWorkspaces, ws)
		}
	}

	if len(projectWorkspaces) == 0 {
		fmt.Println("No workspaces found for this project.")
		return nil
	}

	// Collect status for each workspace
	var statuses []wsStatus
	fileToWorkspaces := make(map[string][]string)

	for _, ws := range projectWorkspaces {
		status := wsStatus{ws: ws}

		// Check if workspace exists
		if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); os.IsNotExist(err) {
			status.exists = false
			statuses = append(statuses, status)
			continue
		}
		status.exists = true

		// Get drift
		changes, err := getWorkspaceChanges(ws)
		if err == nil {
			status.added = len(changes.FilesAdded)
			status.modified = len(changes.FilesModified)
			status.deleted = len(changes.FilesDeleted)
			status.total = status.added + status.modified + status.deleted

			// Track file overlaps
			for _, f := range changes.FilesAdded {
				fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			}
			for _, f := range changes.FilesModified {
				fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			}
			for _, f := range changes.FilesDeleted {
				fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			}
		}

		statuses = append(statuses, status)
	}

	// Count overlaps
	var overlaps []string
	for file, workspaces := range fileToWorkspaces {
		if len(workspaces) >= 2 {
			overlaps = append(overlaps, file)
		}
	}

	if jsonOutput {
		return printStatusAllJSON(cfg, statuses, overlaps)
	}

	return printStatusAllHuman(cfg, statuses, overlaps, fileToWorkspaces)
}

func printStatusAllHuman(cfg *config.ProjectConfig, statuses []wsStatus, overlaps []string, fileToWorkspaces map[string][]string) error {
	// Header
	fmt.Printf("Project: \033[1m%s\033[0m\n", cfg.ProjectID)
	fmt.Printf("Workspaces: %d\n", len(statuses))
	fmt.Println()

	// Table header
	fmt.Printf("  %-3s %-20s %6s %6s %6s  %s\n", "", "WORKSPACE", "ADDED", "MOD", "DEL", "STATUS")
	fmt.Printf("  %-3s %-20s %6s %6s %6s  %s\n", "", "─────────", "─────", "───", "───", "──────")

	// Each workspace
	for _, s := range statuses {
		indicator := "  "
		if s.ws.Name == cfg.WorkspaceName {
			indicator = "▶ "
		}

		name := s.ws.Name
		if len(name) > 20 {
			name = name[:17] + "..."
		}

		if !s.exists {
			fmt.Printf("  %s%-20s %6s %6s %6s  \033[90m(not found)\033[0m\n",
				indicator, name, "-", "-", "-")
			continue
		}

		statusText := "\033[32m✓ clean\033[0m"
		if s.total > 0 {
			statusText = fmt.Sprintf("\033[33m%d changed\033[0m", s.total)
		}

		fmt.Printf("  %s%-20s %6d %6d %6d  %s\n",
			indicator, name, s.added, s.modified, s.deleted, statusText)
	}

	fmt.Println()

	// Overlaps summary
	if len(overlaps) == 0 {
		fmt.Println("\033[32m✓ No overlapping files\033[0m")
	} else {
		fmt.Printf("\033[33m⚠ %d overlapping files:\033[0m\n", len(overlaps))
		maxShow := 5
		for i, f := range overlaps {
			if i >= maxShow {
				fmt.Printf("  ... and %d more (run 'fst overlaps' for details)\n", len(overlaps)-maxShow)
				break
			}
			workspaces := fileToWorkspaces[f]
			fmt.Printf("  %s \033[90m(%s)\033[0m\n", f, formatWorkspaceList(workspaces))
		}
	}

	return nil
}

func printStatusAllJSON(cfg *config.ProjectConfig, statuses []wsStatus, overlaps []string) error {
	fmt.Println("{")
	fmt.Printf("  \"project_id\": %q,\n", cfg.ProjectID)
	fmt.Printf("  \"current_workspace\": %q,\n", cfg.WorkspaceName)
	fmt.Printf("  \"overlap_count\": %d,\n", len(overlaps))
	fmt.Println("  \"workspaces\": [")

	for i, s := range statuses {
		fmt.Printf("    {\"name\": %q, \"exists\": %t, \"added\": %d, \"modified\": %d, \"deleted\": %d}",
			s.ws.Name, s.exists, s.added, s.modified, s.deleted)
		if i < len(statuses)-1 {
			fmt.Println(",")
		} else {
			fmt.Println()
		}
	}

	fmt.Println("  ]")
	fmt.Println("}")
	return nil
}

func formatTimeAgo(t time.Time) string {
	diff := time.Since(t)

	switch {
	case diff < time.Minute:
		return "just now"
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins == 1 {
			return "1 min ago"
		}
		return fmt.Sprintf("%d mins ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		if hours == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		if days == 1 {
			return "yesterday"
		}
		return fmt.Sprintf("%d days ago", days)
	default:
		return t.Format("Jan 2")
	}
}
