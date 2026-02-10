package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/store"
	"github.com/anthropics/fastest/cli/internal/ui"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newInfoCmd()) })
}

func newInfoCmd() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "info",
		Short: "Show project/workspace info",
		Long: `Show info about the current workspace or project.

Run inside a workspace to see workspace info.
Run inside a project folder (fst.json) to see project info.

Subcommands:
  workspaces    List all workspaces for the current project
  workspace     Show details for a specific workspace
  project       Show current project details`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInfo(jsonOutput)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")

	cmd.AddCommand(newInfoWorkspacesCmd())
	cmd.AddCommand(newInfoWorkspaceCmd())
	cmd.AddCommand(newInfoProjectCmd())

	return cmd
}

func runInfo(jsonOutput bool) error {
	if cfg, err := config.Load(); err == nil {
		return printWorkspaceInfo(cfg, jsonOutput)
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}
	parentRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err == nil && parentRoot == cwd {
		return printProjectInfo(parentRoot, parentCfg, jsonOutput)
	}

	return fmt.Errorf("not in a workspace or project folder")
}

// --- info workspaces ---

func newInfoWorkspacesCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "workspaces",
		Aliases: []string{"ws"},
		Short:   "List workspaces for the current project",
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInfoWorkspaces()
		},
	}
}

func runInfoWorkspaces() error {
	parentRoot, parentCfg, err := findProjectContext()
	if err != nil {
		return err
	}

	s := store.OpenAt(parentRoot)
	wsList, err := s.ListWorkspaces()
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}

	if len(wsList) == 0 {
		fmt.Println("No workspaces found.")
		fmt.Println()
		fmt.Println("Create one with: fst workspace create <name>")
		return nil
	}

	mainWorkspaceID := ""
	if parentCfg != nil {
		mainWorkspaceID = parentCfg.MainWorkspaceID
	}

	// Get current workspace path for highlighting
	currentPath := ""
	if root, findErr := config.FindProjectRoot(); findErr == nil {
		currentPath = root
	}

	sort.Slice(wsList, func(i, j int) bool {
		return strings.ToLower(wsList[i].WorkspaceName) < strings.ToLower(wsList[j].WorkspaceName)
	})

	fmt.Printf("Workspaces (%d):\n\n", len(wsList))
	fmt.Printf("  %-15s  %-35s  %-6s  %s\n", "NAME", "PATH", "ROLE", "DRIFT")
	fmt.Printf("  %-15s  %-35s  %-6s  %s\n",
		strings.Repeat("-", 15),
		strings.Repeat("-", 35),
		strings.Repeat("-", 6),
		strings.Repeat("-", 15))

	for _, ws := range wsList {
		isCurrent := ws.Path != "" && ws.Path == currentPath
		indicator := " "
		if isCurrent {
			indicator = ui.Bold("*")
		}

		name := ws.WorkspaceName
		if len(name) > 15 {
			name = name[:12] + "..."
		}

		displayPath := ws.Path
		if displayPath == "" {
			displayPath = "-"
		}
		if len(displayPath) > 35 {
			displayPath = "..." + displayPath[len(displayPath)-32:]
		}

		// Pad raw text first, then apply color (ANSI codes break %-Ns formatting)
		roleText := "-"
		if ws.WorkspaceID == mainWorkspaceID {
			roleText = "main"
		}
		rolePad := 6 - len(roleText)
		if rolePad < 0 {
			rolePad = 0
		}
		roleStr := roleText + strings.Repeat(" ", rolePad)
		if ws.WorkspaceID == mainWorkspaceID {
			roleStr = ui.Cyan("main") + strings.Repeat(" ", rolePad)
		}

		driftStr := "-"
		if ws.Path != "" {
			if _, statErr := os.Stat(filepath.Join(ws.Path, ".fst")); statErr == nil {
				report, driftErr := drift.ComputeFromCache(ws.Path)
				if driftErr == nil && report.HasChanges() {
					parts := []string{}
					if len(report.FilesAdded) > 0 {
						parts = append(parts, ui.Green(fmt.Sprintf("+%d", len(report.FilesAdded))))
					}
					if len(report.FilesModified) > 0 {
						parts = append(parts, ui.Yellow(fmt.Sprintf("~%d", len(report.FilesModified))))
					}
					if len(report.FilesDeleted) > 0 {
						parts = append(parts, ui.Red(fmt.Sprintf("-%d", len(report.FilesDeleted))))
					}
					driftStr = strings.Join(parts, " ")
				} else if driftErr == nil {
					driftStr = ui.Green("clean")
				}
			}
		}

		fmt.Printf("%s %-15s  %-35s  %s  %s\n", indicator, name, displayPath, roleStr, driftStr)
	}

	return nil
}

// --- info workspace [name/id] ---

func newInfoWorkspaceCmd() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "workspace [name|id]",
		Short: "Show details for a specific workspace",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				// No arg — show current workspace
				cfg, err := config.Load()
				if err != nil {
					return fmt.Errorf("not in a workspace - provide a workspace name or ID")
				}
				return printWorkspaceInfo(cfg, jsonOutput)
			}
			return runInfoWorkspace(args[0], jsonOutput)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")

	return cmd
}

func runInfoWorkspace(nameOrID string, jsonOutput bool) error {
	parentRoot, _, err := findProjectContext()
	if err != nil {
		return err
	}

	s := store.OpenAt(parentRoot)

	// Try by name first, then by ID
	wsInfo, findErr := s.FindWorkspaceByName(nameOrID)
	if findErr != nil {
		wsInfo, findErr = s.FindWorkspaceByID(nameOrID)
		if findErr != nil {
			return fmt.Errorf("workspace %q not found", nameOrID)
		}
	}

	if wsInfo.Path == "" {
		return fmt.Errorf("workspace %q has no local path", nameOrID)
	}

	cfg, err := config.LoadAt(wsInfo.Path)
	if err != nil {
		return fmt.Errorf("failed to load workspace config at %s: %w", wsInfo.Path, err)
	}

	return printWorkspaceInfoAt(cfg, wsInfo.Path, jsonOutput)
}

// --- info project ---

func newInfoProjectCmd() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "project",
		Short: "Show current project details",
		RunE: func(cmd *cobra.Command, args []string) error {
			parentRoot, parentCfg, err := findProjectContext()
			if err != nil {
				return err
			}
			return printProjectInfo(parentRoot, parentCfg, jsonOutput)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")

	return cmd
}

// --- shared display functions ---

func printWorkspaceInfo(cfg *config.ProjectConfig, jsonOutput bool) error {
	root, err := config.FindProjectRoot()
	if err != nil {
		return err
	}
	return printWorkspaceInfoAt(cfg, root, jsonOutput)
}

func printWorkspaceInfoAt(cfg *config.ProjectConfig, root string, jsonOutput bool) error {
	parentRoot, parentCfg, _ := config.FindParentRootFrom(root)
	mainID, mainName := lookupMainWorkspace(cfg.ProjectID)
	isMain := mainID != "" && mainID == cfg.WorkspaceID
	snapshotsDir := config.GetSnapshotsDirAt(root)
	baseTime := ""
	if cfg.BaseSnapshotID != "" {
		metaPath := filepath.Join(snapshotsDir, cfg.BaseSnapshotID+".meta.json")
		if info, err := os.Stat(metaPath); err == nil {
			baseTime = info.ModTime().UTC().Format(time.RFC3339)
		}
	}

	currentTime := ""
	if cfg.CurrentSnapshotID != "" {
		metaPath := filepath.Join(snapshotsDir, cfg.CurrentSnapshotID+".meta.json")
		if info, err := os.Stat(metaPath); err == nil {
			currentTime = info.ModTime().UTC().Format(time.RFC3339)
		}
	}

	upstreamID, upstreamName, _ := drift.GetUpstreamWorkspace(root)

	if jsonOutput {
		payload := map[string]any{
			"mode":                  "workspace",
			"workspace_id":          cfg.WorkspaceID,
			"workspace_name":        cfg.WorkspaceName,
			"project_id":            cfg.ProjectID,
			"project_name":          "",
			"path":                  root,
			"base_snapshot_id":      cfg.BaseSnapshotID,
			"base_snapshot_time":    baseTime,
			"current_snapshot_id":   cfg.CurrentSnapshotID,
			"current_snapshot_time": currentTime,
			"workspace_mode":        cfg.Mode,
			"upstream_id":           upstreamID,
			"upstream_name":         upstreamName,
			"is_main":               isMain,
			"main_workspace_id":     mainID,
			"main_workspace_name":   mainName,
		}
		if parentCfg != nil && parentRoot != "" {
			payload["project_name"] = parentCfg.ProjectName
			payload["project_path"] = parentRoot
		}
		enc, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(enc))
		return nil
	}

	fmt.Printf("Workspace: %s\n", ui.Bold(cfg.WorkspaceName))
	fmt.Printf("  ID:      %s\n", ui.Dim(cfg.WorkspaceID))
	fmt.Printf("  Path:    %s\n", root)
	fmt.Printf("  Mode:    %s\n", cfg.Mode)
	if isMain {
		fmt.Printf("  Role:    %s\n", ui.Cyan("main"))
	}
	fmt.Println()
	fmt.Printf("Project:   %s\n", cfg.ProjectID)
	if parentCfg != nil {
		fmt.Printf("  Name:    %s\n", parentCfg.ProjectName)
		fmt.Printf("  Path:    %s\n", parentRoot)
	}
	if !isMain && mainID != "" {
		displayMain := mainID
		if mainName != "" {
			displayMain = fmt.Sprintf("%s (%s)", mainName, mainID)
		}
		fmt.Printf("  Main:    %s\n", displayMain)
	} else if mainID == "" {
		fmt.Printf("  Main:    (not set)  Run: fst workspace set-main <workspace>\n")
	}
	if cfg.BaseSnapshotID != "" {
		fmt.Printf("  Base:    %s", cfg.BaseSnapshotID)
		if baseTime != "" {
			fmt.Printf(" %s", ui.Dim("("+baseTime+")"))
		}
		fmt.Println()
	}
	if cfg.CurrentSnapshotID != "" {
		fmt.Printf("  Current: %s", cfg.CurrentSnapshotID)
		if currentTime != "" {
			fmt.Printf(" %s", ui.Dim("("+currentTime+")"))
		}
		fmt.Println()
	}
	if upstreamName != "" {
		fmt.Printf("  Upstream: %s\n", upstreamName)
		if upstreamID != "" {
			fmt.Printf("  Upstream ID: %s\n", upstreamID)
		}
	}
	return nil
}

func printProjectInfo(parentRoot string, parentCfg *config.ParentConfig, jsonOutput bool) error {
	if parentCfg == nil {
		return fmt.Errorf("failed to load project config")
	}

	mainID, mainName := lookupMainWorkspace(parentCfg.ProjectID)
	s := store.OpenAt(parentRoot)
	workspaces, _ := s.ListWorkspaces()

	if jsonOutput {
		payload := map[string]any{
			"mode":                "project",
			"project_id":          parentCfg.ProjectID,
			"project_name":        parentCfg.ProjectName,
			"project_path":        parentRoot,
			"base_snapshot_id":    parentCfg.BaseSnapshotID,
			"base_workspace_id":   parentCfg.BaseWorkspaceID,
			"main_workspace_id":   mainID,
			"main_workspace_name": mainName,
			"workspace_count":     len(workspaces),
		}
		enc, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(enc))
		return nil
	}

	fmt.Printf("Project: %s\n", ui.Bold(parentCfg.ProjectName))
	fmt.Printf("  ID:    %s\n", ui.Dim(parentCfg.ProjectID))
	fmt.Printf("  Path:  %s\n", parentRoot)
	if parentCfg.BaseSnapshotID != "" {
		fmt.Printf("  Base:  %s\n", parentCfg.BaseSnapshotID)
	}
	if parentCfg.BaseWorkspaceID != "" {
		fmt.Printf("  Base Workspace: %s\n", parentCfg.BaseWorkspaceID)
	}
	if mainID != "" {
		displayMain := mainID
		if mainName != "" {
			displayMain = fmt.Sprintf("%s (%s)", mainName, mainID)
		}
		fmt.Printf("  Main Workspace: %s\n", displayMain)
	} else {
		fmt.Printf("  Main Workspace: (not set)  Run: fst workspace set-main <workspace>\n")
	}
	fmt.Printf("  Workspaces: %d  (run 'fst info workspaces' to list)\n", len(workspaces))
	return nil
}

// --- helpers ---

func findProjectContext() (string, *config.ParentConfig, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", nil, fmt.Errorf("failed to get current directory: %w", err)
	}

	// Try from workspace first
	if wsRoot, findErr := config.FindProjectRoot(); findErr == nil {
		if pr, pc, parentErr := config.FindParentRootFrom(wsRoot); parentErr == nil {
			return pr, pc, nil
		}
	}

	// Try from current directory (might be project root)
	if pr, pc, parentErr := config.FindParentRootFrom(cwd); parentErr == nil {
		return pr, pc, nil
	}

	return "", nil, fmt.Errorf("not in a workspace or project directory")
}

func lookupMainWorkspace(projectID string) (string, string) {
	if projectID == "" {
		return "", ""
	}
	cwd, err := os.Getwd()
	if err != nil {
		return "", ""
	}
	var parentRoot string
	var parentCfg *config.ParentConfig
	if wsRoot, findErr := config.FindProjectRoot(); findErr == nil {
		parentRoot, parentCfg, _ = config.FindParentRootFrom(wsRoot)
	} else {
		parentRoot, parentCfg, _ = config.FindParentRootFrom(cwd)
	}
	if parentCfg == nil || parentCfg.MainWorkspaceID == "" {
		return "", ""
	}
	mainID := parentCfg.MainWorkspaceID
	if parentRoot == "" {
		return mainID, ""
	}
	s := store.OpenAt(parentRoot)
	wsInfo, lookupErr := s.FindWorkspaceByID(mainID)
	if lookupErr != nil {
		return mainID, ""
	}
	return mainID, wsInfo.WorkspaceName
}
