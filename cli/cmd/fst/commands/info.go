package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/index"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newInfoCmd()) })
}

func newInfoCmd() *cobra.Command {
	var jsonOutput bool
	var listWorkspaces bool

	cmd := &cobra.Command{
		Use:   "info",
		Short: "Show project/workspace info",
		Long: `Show info about the current workspace or project.

Run inside a workspace to see workspace info.
Run inside a project folder (fst.json) to see project info.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runInfo(jsonOutput, listWorkspaces)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&listWorkspaces, "list", false, "List workspaces when run in a project folder")

	return cmd
}

func runInfo(jsonOutput, listWorkspaces bool) error {
	if cfg, err := config.Load(); err == nil {
		return printWorkspaceInfo(cfg, jsonOutput)
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}
	parentRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err == nil && parentRoot == cwd {
		return printProjectInfo(parentRoot, parentCfg, jsonOutput, listWorkspaces)
	}

	return fmt.Errorf("not in a workspace or project folder")
}

func printWorkspaceInfo(cfg *config.ProjectConfig, jsonOutput bool) error {
	root, err := config.FindProjectRoot()
	if err != nil {
		return err
	}

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

	fmt.Printf("Workspace: %s\n", cfg.WorkspaceName)
	fmt.Printf("  ID:      %s\n", cfg.WorkspaceID)
	fmt.Printf("  Path:    %s\n", root)
	fmt.Printf("  Mode:    %s\n", cfg.Mode)
	if isMain {
		fmt.Printf("  Role:    main\n")
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
			fmt.Printf(" (%s)", baseTime)
		}
		fmt.Println()
	}
	if cfg.CurrentSnapshotID != "" {
		fmt.Printf("  Current: %s", cfg.CurrentSnapshotID)
		if currentTime != "" {
			fmt.Printf(" (%s)", currentTime)
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

func printProjectInfo(parentRoot string, parentCfg *config.ParentConfig, jsonOutput bool, listWorkspaces bool) error {
	if parentCfg == nil {
		return fmt.Errorf("failed to load project config")
	}

	var workspaces []index.WorkspaceEntry
	mainID, mainName := lookupMainWorkspace(parentCfg.ProjectID)
	if listWorkspaces {
		if idx, err := index.Load(); err == nil {
			for _, ws := range idx.Workspaces {
				if ws.ProjectID == parentCfg.ProjectID {
					workspaces = append(workspaces, ws)
				}
			}
		}
	}

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
			"workspaces":          workspaces,
		}
		if !listWorkspaces {
			delete(payload, "workspaces")
		}
		enc, _ := json.MarshalIndent(payload, "", "  ")
		fmt.Println(string(enc))
		return nil
	}

	fmt.Printf("Project: %s\n", parentCfg.ProjectName)
	fmt.Printf("  ID:    %s\n", parentCfg.ProjectID)
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
	if listWorkspaces {
		fmt.Println()
		fmt.Printf("Workspaces (%d):\n", len(workspaces))
		for _, ws := range workspaces {
			role := ""
			if ws.WorkspaceID == mainID {
				role = " (main)"
			}
			fmt.Printf("  %s  %s  %s%s\n", ws.WorkspaceID, ws.WorkspaceName, ws.Path, role)
		}
	}
	return nil
}

func lookupMainWorkspace(projectID string) (string, string) {
	if projectID == "" {
		return "", ""
	}
	mainID, err := index.GetProjectMainWorkspaceID(projectID)
	if err != nil {
		return "", ""
	}
	if mainID == "" {
		return "", ""
	}
	idx, err := index.Load()
	if err != nil {
		return mainID, ""
	}
	for _, ws := range idx.Workspaces {
		if ws.WorkspaceID == mainID {
			return mainID, ws.WorkspaceName
		}
	}
	return mainID, ""
}
