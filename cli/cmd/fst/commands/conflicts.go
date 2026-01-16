package commands

import (
	"fmt"
	"sort"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
)

func init() {
	rootCmd.AddCommand(newConflictsCmd())
}

func newConflictsCmd() *cobra.Command {
	var showAll bool

	cmd := &cobra.Command{
		Use:   "conflicts",
		Short: "Show conflicts with other workspaces",
		Long: `Detect files that conflict with other workspaces.

A conflict occurs when the same file has been modified in multiple workspaces
since their common base snapshot. This helps you understand what needs to be
merged and where manual intervention may be required.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runConflicts(showAll)
		},
	}

	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show all workspaces, not just conflicting ones")

	return cmd
}

// WorkspaceDrift holds drift info for a workspace
type WorkspaceDrift struct {
	ID            string
	Name          string
	FilesAdded    []string
	FilesModified []string
	FilesDeleted  []string
	Summary       string
}

func runConflicts(showAll bool) error {
	token, err := auth.GetToken()
	if err != nil || token == "" {
		return fmt.Errorf("not logged in - run 'fst login' first")
	}

	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Compute local drift
	localReport, err := drift.ComputeFromCache(root)
	if err != nil {
		return fmt.Errorf("failed to compute local drift: %w", err)
	}

	client := api.NewClient(token)

	// Fetch all workspaces for the project
	_, workspaces, err := client.GetProject(cfg.ProjectID)
	if err != nil {
		return fmt.Errorf("failed to fetch project: %w", err)
	}

	// Fetch drift for each workspace (except current)
	var otherDrifts []WorkspaceDrift
	for _, ws := range workspaces {
		if ws.ID == cfg.WorkspaceID {
			continue
		}

		// Get workspace drift from cloud
		wsDrift, err := client.GetWorkspaceDrift(ws.ID)
		if err != nil {
			// Skip if we can't get drift
			continue
		}

		if wsDrift != nil {
			otherDrifts = append(otherDrifts, WorkspaceDrift{
				ID:            ws.ID,
				Name:          ws.Name,
				FilesAdded:    wsDrift.FilesAdded,
				FilesModified: wsDrift.FilesModified,
				FilesDeleted:  wsDrift.FilesDeleted,
				Summary:       wsDrift.Summary,
			})
		}
	}

	// Build set of local modified files
	localModified := make(map[string]bool)
	for _, f := range localReport.FilesAdded {
		localModified[f] = true
	}
	for _, f := range localReport.FilesModified {
		localModified[f] = true
	}
	for _, f := range localReport.FilesDeleted {
		localModified[f] = true
	}

	// Find conflicts
	type Conflict struct {
		File       string
		LocalOp    string
		RemoteOp   string
		RemoteWS   string
		RemoteWSID string
	}

	var conflicts []Conflict

	for _, other := range otherDrifts {
		// Check added files
		for _, f := range other.FilesAdded {
			if localModified[f] {
				localOp := "added"
				if contains(localReport.FilesModified, f) {
					localOp = "modified"
				} else if contains(localReport.FilesDeleted, f) {
					localOp = "deleted"
				}
				conflicts = append(conflicts, Conflict{
					File:       f,
					LocalOp:    localOp,
					RemoteOp:   "added",
					RemoteWS:   other.Name,
					RemoteWSID: other.ID,
				})
			}
		}

		// Check modified files
		for _, f := range other.FilesModified {
			if localModified[f] {
				localOp := "modified"
				if contains(localReport.FilesAdded, f) {
					localOp = "added"
				} else if contains(localReport.FilesDeleted, f) {
					localOp = "deleted"
				}
				conflicts = append(conflicts, Conflict{
					File:       f,
					LocalOp:    localOp,
					RemoteOp:   "modified",
					RemoteWS:   other.Name,
					RemoteWSID: other.ID,
				})
			}
		}

		// Check deleted files
		for _, f := range other.FilesDeleted {
			if localModified[f] {
				localOp := "modified"
				if contains(localReport.FilesAdded, f) {
					localOp = "added"
				} else if contains(localReport.FilesDeleted, f) {
					localOp = "deleted" // Both deleted - not really a conflict
					continue
				}
				conflicts = append(conflicts, Conflict{
					File:       f,
					LocalOp:    localOp,
					RemoteOp:   "deleted",
					RemoteWS:   other.Name,
					RemoteWSID: other.ID,
				})
			}
		}
	}

	// Display results
	fmt.Printf("Current workspace: %s\n", cfg.WorkspaceName)
	fmt.Printf("Local changes: +%d ~%d -%d\n",
		len(localReport.FilesAdded),
		len(localReport.FilesModified),
		len(localReport.FilesDeleted))
	fmt.Println()

	if showAll || len(otherDrifts) > 0 {
		fmt.Printf("Other workspaces (%d):\n", len(otherDrifts))
		for _, other := range otherDrifts {
			total := len(other.FilesAdded) + len(other.FilesModified) + len(other.FilesDeleted)
			fmt.Printf("  %-20s +%d ~%d -%d",
				other.Name,
				len(other.FilesAdded),
				len(other.FilesModified),
				len(other.FilesDeleted))
			if other.Summary != "" {
				// Truncate summary
				summary := other.Summary
				if len(summary) > 50 {
					summary = summary[:47] + "..."
				}
				fmt.Printf("  \"%s\"", summary)
			}
			if total == 0 {
				fmt.Printf("  (no changes)")
			}
			fmt.Println()
		}
		fmt.Println()
	}

	if len(conflicts) == 0 {
		fmt.Println("✓ No conflicts detected")
		if len(otherDrifts) > 0 {
			fmt.Println()
			fmt.Println("You can safely merge changes from other workspaces:")
			for _, other := range otherDrifts {
				total := len(other.FilesAdded) + len(other.FilesModified) + len(other.FilesDeleted)
				if total > 0 {
					fmt.Printf("  fst merge %s\n", other.Name)
				}
			}
		}
		return nil
	}

	// Group conflicts by workspace
	conflictsByWS := make(map[string][]Conflict)
	for _, c := range conflicts {
		conflictsByWS[c.RemoteWS] = append(conflictsByWS[c.RemoteWS], c)
	}

	fmt.Printf("⚠ Found %d conflicting files:\n", len(conflicts))
	fmt.Println()

	// Sort workspace names
	var wsNames []string
	for name := range conflictsByWS {
		wsNames = append(wsNames, name)
	}
	sort.Strings(wsNames)

	for _, wsName := range wsNames {
		wsConflicts := conflictsByWS[wsName]
		fmt.Printf("Conflicts with %s:\n", wsName)
		for _, c := range wsConflicts {
			fmt.Printf("  %-40s  local: %-8s  remote: %s\n", c.File, c.LocalOp, c.RemoteOp)
		}
		fmt.Println()
	}

	fmt.Println("To resolve conflicts:")
	fmt.Println("  fst merge <workspace> --agent   # Let AI resolve")
	fmt.Println("  fst merge <workspace> --manual  # Resolve manually")

	return nil
}

func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
