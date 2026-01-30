package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newOverlapsCmd()) })
}

func newOverlapsCmd() *cobra.Command {
	var jsonOutput bool
	var includeAll bool

	cmd := &cobra.Command{
		Use:   "overlaps",
		Short: "Detect files modified by multiple workspaces",
		Long: `Detect which files are being modified by multiple workspaces.

This helps you catch potential merge conflicts early when running multiple
AI agents in parallel. If two agents are modifying the same file, you may
want to merge one before the other continues.

By default, only shows workspaces with changes. Use --all to include
workspaces with no drift.

Examples:
  fst overlaps              # Show overlapping files across all workspaces
  fst overlaps --json       # Output as JSON for scripting`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runOverlaps(jsonOutput, includeAll)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVarP(&includeAll, "all", "a", false, "Include workspaces with no changes")

	return cmd
}

// WorkspaceChanges tracks what files a workspace has modified
type WorkspaceChanges struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	Path     string   `json:"path"`
	Added    []string `json:"added"`
	Modified []string `json:"modified"`
	Deleted  []string `json:"deleted"`
}

// FileOverlap represents a file modified by multiple workspaces
type FileOverlap struct {
	Path       string   `json:"path"`
	Workspaces []string `json:"workspaces"` // workspace names
	Type       string   `json:"type"`       // "added", "modified", "deleted", "mixed"
}

// OverlapReport contains all detected overlaps
type OverlapReport struct {
	ProjectID    string             `json:"project_id"`
	Workspaces   []WorkspaceChanges `json:"workspaces"`
	Overlaps     []FileOverlap      `json:"overlaps"`
	TotalFiles   int                `json:"total_files_changed"`
	OverlapCount int                `json:"overlap_count"`
}

func runOverlaps(jsonOutput, includeAll bool) error {
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

	// Collect changes for each workspace
	var allChanges []WorkspaceChanges
	fileToWorkspaces := make(map[string][]string)      // file path -> workspace names
	fileChangeType := make(map[string]map[string]bool) // file path -> change types

	for _, ws := range projectWorkspaces {
		// Skip if workspace doesn't exist
		if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); os.IsNotExist(err) {
			continue
		}

		// Compute drift from base for this workspace
		changes, err := getWorkspaceChanges(ws)
		if err != nil {
			// Skip workspaces we can't analyze
			continue
		}

		// Skip workspaces with no changes unless --all
		hasChanges := len(changes.FilesAdded) > 0 || len(changes.FilesModified) > 0 || len(changes.FilesDeleted) > 0
		if !includeAll && !hasChanges {
			continue
		}

		allChanges = append(allChanges, reportToWorkspaceChanges(changes, ws))

		// Track which workspaces touch which files
		for _, f := range changes.FilesAdded {
			fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			if fileChangeType[f] == nil {
				fileChangeType[f] = make(map[string]bool)
			}
			fileChangeType[f]["added"] = true
		}
		for _, f := range changes.FilesModified {
			fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			if fileChangeType[f] == nil {
				fileChangeType[f] = make(map[string]bool)
			}
			fileChangeType[f]["modified"] = true
		}
		for _, f := range changes.FilesDeleted {
			fileToWorkspaces[f] = append(fileToWorkspaces[f], ws.Name)
			if fileChangeType[f] == nil {
				fileChangeType[f] = make(map[string]bool)
			}
			fileChangeType[f]["deleted"] = true
		}
	}

	// Find overlaps (files touched by 2+ workspaces)
	var overlaps []FileOverlap
	for file, workspaces := range fileToWorkspaces {
		if len(workspaces) >= 2 {
			changeType := determineChangeType(fileChangeType[file])
			overlaps = append(overlaps, FileOverlap{
				Path:       file,
				Workspaces: workspaces,
				Type:       changeType,
			})
		}
	}

	// Sort overlaps by number of workspaces (most contested first), then by path
	sort.Slice(overlaps, func(i, j int) bool {
		if len(overlaps[i].Workspaces) != len(overlaps[j].Workspaces) {
			return len(overlaps[i].Workspaces) > len(overlaps[j].Workspaces)
		}
		return overlaps[i].Path < overlaps[j].Path
	})

	report := OverlapReport{
		ProjectID:    cfg.ProjectID,
		Workspaces:   allChanges,
		Overlaps:     overlaps,
		TotalFiles:   len(fileToWorkspaces),
		OverlapCount: len(overlaps),
	}

	if jsonOutput {
		return printOverlapsJSON(report)
	}

	return printOverlapsHuman(report, cfg.WorkspaceName)
}

func getWorkspaceChanges(ws RegisteredWorkspace) (*drift.Report, error) {
	wsCfg, err := config.LoadAt(ws.Path)
	if err != nil {
		return nil, err
	}

	if wsCfg.ForkSnapshotID == "" {
		return &drift.Report{}, nil
	}

	// Load base manifest
	manifestHash, err := config.ManifestHashFromSnapshotIDAt(ws.Path, wsCfg.ForkSnapshotID)
	if err != nil {
		return nil, fmt.Errorf("invalid fork snapshot id: %w", err)
	}

	manifestsDir := config.GetManifestsDirAt(ws.Path)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, err
	}

	baseManifest, err := manifest.FromJSON(manifestData)
	if err != nil {
		return nil, err
	}

	// Generate current manifest
	currentManifest, err := manifest.Generate(ws.Path, false)
	if err != nil {
		return nil, err
	}

	// Compute diff
	added, modified, deleted := manifest.Diff(baseManifest, currentManifest)

	return &drift.Report{
		ForkSnapshotID: wsCfg.ForkSnapshotID,
		FilesAdded:     added,
		FilesModified:  modified,
		FilesDeleted:   deleted,
	}, nil
}

func reportToWorkspaceChanges(r *drift.Report, ws RegisteredWorkspace) WorkspaceChanges {
	return WorkspaceChanges{
		ID:       ws.ID,
		Name:     ws.Name,
		Path:     ws.Path,
		Added:    r.FilesAdded,
		Modified: r.FilesModified,
		Deleted:  r.FilesDeleted,
	}
}

func determineChangeType(types map[string]bool) string {
	count := 0
	var singleType string
	for t := range types {
		count++
		singleType = t
	}
	if count == 1 {
		return singleType
	}
	return "mixed"
}

func printOverlapsJSON(report OverlapReport) error {
	// Simple JSON output
	fmt.Println("{")
	fmt.Printf("  \"project_id\": %q,\n", report.ProjectID)
	fmt.Printf("  \"total_files_changed\": %d,\n", report.TotalFiles)
	fmt.Printf("  \"overlap_count\": %d,\n", report.OverlapCount)
	fmt.Println("  \"overlaps\": [")
	for i, o := range report.Overlaps {
		fmt.Printf("    {\"path\": %q, \"workspaces\": [", o.Path)
		for j, w := range o.Workspaces {
			fmt.Printf("%q", w)
			if j < len(o.Workspaces)-1 {
				fmt.Print(", ")
			}
		}
		fmt.Printf("], \"type\": %q}", o.Type)
		if i < len(report.Overlaps)-1 {
			fmt.Println(",")
		} else {
			fmt.Println()
		}
	}
	fmt.Println("  ]")
	fmt.Println("}")
	return nil
}

func printOverlapsHuman(report OverlapReport, currentWorkspace string) error {
	if len(report.Workspaces) == 0 {
		fmt.Println("No workspaces with changes found.")
		return nil
	}

	// Summary header
	fmt.Printf("Workspaces with changes: %d\n", len(report.Workspaces))
	fmt.Printf("Total files changed: %d\n", report.TotalFiles)
	fmt.Println()

	// Show each workspace's changes briefly
	fmt.Println("Changes by workspace:")
	for _, ws := range report.Workspaces {
		indicator := "  "
		if ws.Name == currentWorkspace {
			indicator = "* "
		}
		total := len(ws.Added) + len(ws.Modified) + len(ws.Deleted)
		fmt.Printf("%s%-20s  +%d ~%d -%d  (%d files)\n",
			indicator, ws.Name,
			len(ws.Added), len(ws.Modified), len(ws.Deleted),
			total)
	}
	fmt.Println()

	// Show overlaps
	if len(report.Overlaps) == 0 {
		fmt.Println("\033[32m✓ No overlapping files - safe to merge in any order\033[0m")
		return nil
	}

	fmt.Printf("\033[33m⚠ %d overlapping files detected:\033[0m\n", len(report.Overlaps))
	fmt.Println()

	for _, o := range report.Overlaps {
		// Color based on severity (more workspaces = worse)
		color := "\033[33m" // yellow for 2
		if len(o.Workspaces) >= 3 {
			color = "\033[31m" // red for 3+
		}

		fmt.Printf("%s  %s\033[0m\n", color, o.Path)
		fmt.Printf("    Modified by: %s\n", formatWorkspaceList(o.Workspaces))
		if o.Type == "mixed" {
			fmt.Printf("    \033[90m(mixed changes: some add, some modify, some delete)\033[0m\n")
		}
	}

	fmt.Println()
	fmt.Println("Recommendations:")
	fmt.Println("  1. Merge workspaces with overlapping files first")
	fmt.Println("  2. Use 'fst diff <workspace>' to see actual changes")
	fmt.Println("  3. Use 'fst merge <workspace> --dry-run' to preview merge")

	return nil
}

func formatWorkspaceList(workspaces []string) string {
	if len(workspaces) <= 3 {
		result := ""
		for i, w := range workspaces {
			if i > 0 {
				result += ", "
			}
			result += w
		}
		return result
	}
	return fmt.Sprintf("%s, %s, and %d more", workspaces[0], workspaces[1], len(workspaces)-2)
}
