package commands

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
}

func newCreateCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "create [workspace-name]",
		Short: "Create a new workspace",
		Long: `Create a new workspace with its own .fst metadata.

When run inside a project folder (fst.json), the workspace is created under
that folder and linked to the project's ID.

By default, the workspace name matches the directory name. If no workspace
name is provided under a parent, one is generated from the project name.`,
		Args: cobra.MaximumNArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runCreate(args)
		},
	}

	return cmd
}

func runCreate(args []string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	if _, err := config.FindProjectRoot(); err == nil {
		return fmt.Errorf("already inside a workspace - use 'fst workspace copy' instead")
	}

	parentRoot, parentCfg, err := config.FindParentRootFrom(cwd)
	if err != nil && !errors.Is(err, config.ErrParentNotFound) {
		return err
	}
	if errors.Is(err, config.ErrParentNotFound) {
		return fmt.Errorf("no project folder found - run 'fst project init' first")
	}
	if err == nil {
		if cwd != parentRoot {
			return fmt.Errorf("run 'fst workspace create' from the project folder (%s)", parentRoot)
		}
		if len(args) > 1 {
			return fmt.Errorf("workspace name only when using a project folder")
		}

		workspaceName := ""
		if len(args) == 1 {
			workspaceName = args[0]
		} else {
			workspaceName = defaultWorkspaceName(parentCfg.ProjectName)
		}

		workspaceDir := filepath.Join(parentRoot, workspaceName)
		if _, err := os.Stat(workspaceDir); err == nil {
			return fmt.Errorf("target directory already exists: %s", workspaceDir)
		}
		if err := os.MkdirAll(workspaceDir, 0755); err != nil {
			return fmt.Errorf("failed to create workspace directory: %w", err)
		}

		workspaceID := generateWorkspaceID()
		baseSnapshotID := parentCfg.BaseSnapshotID
		if err := config.InitAt(workspaceDir, parentCfg.ProjectID, workspaceID, workspaceName, baseSnapshotID); err != nil {
			return fmt.Errorf("failed to initialize workspace: %w", err)
		}

		var snapshotID string
		if baseSnapshotID == "" {
			snapshotID, err = createInitialSnapshot(workspaceDir, workspaceID, workspaceName, false)
			if err != nil {
				return err
			}
			parentCfg.BaseSnapshotID = snapshotID
			parentCfg.BaseWorkspaceID = workspaceID
			if err := config.SaveParentConfigAt(parentRoot, parentCfg); err != nil {
				return fmt.Errorf("failed to save project base snapshot: %w", err)
			}
		} else {
			if err := copyBaseSnapshotToWorkspace(parentCfg, workspaceDir, baseSnapshotID); err != nil {
				return err
			}
			snapshotID = baseSnapshotID
			if cfg, err := config.LoadAt(workspaceDir); err == nil {
				cfg.BaseSnapshotID = baseSnapshotID
				cfg.CurrentSnapshotID = baseSnapshotID
				_ = config.SaveAt(workspaceDir, cfg)
			}
		}

		if err := RegisterWorkspace(RegisteredWorkspace{
			ID:             workspaceID,
			ProjectID:      parentCfg.ProjectID,
			Name:           workspaceName,
			Path:           workspaceDir,
			BaseSnapshotID: snapshotID,
			CreatedAt:      time.Now().UTC().Format(time.RFC3339),
		}); err != nil {
			fmt.Printf("Warning: Could not register workspace: %v\n", err)
		}

		printCreateSuccess(parentCfg.ProjectName, workspaceName, workspaceDir, snapshotID)
		return nil
	}

	return nil
}

func defaultWorkspaceName(projectName string) string {
	return fmt.Sprintf("%s-%s", projectName, randomSuffix(4))
}

func printCreateSuccess(projectName, workspaceName, workspaceDir, snapshotID string) {
	fmt.Println()
	fmt.Println("✓ Workspace created!")
	fmt.Println()
	fmt.Printf("  Project:   %s\n", projectName)
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Directory: %s\n", workspaceDir)
	if snapshotID != "" {
		fmt.Printf("  Snapshot:  %s\n", snapshotID)
	}
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  cd %s\n", workspaceDir)
	fmt.Println("  fst drift        # Check for changes")
}

func copyBaseSnapshotToWorkspace(parentCfg *config.ParentConfig, workspaceDir, baseSnapshotID string) error {
	if parentCfg == nil || baseSnapshotID == "" {
		return nil
	}

	registry, err := LoadRegistry()
	if err != nil {
		return fmt.Errorf("failed to load workspace registry: %w", err)
	}

	sourcePath := ""
	if parentCfg.BaseWorkspaceID != "" {
		for _, ws := range registry.Workspaces {
			if ws.ID == parentCfg.BaseWorkspaceID {
				sourcePath = ws.Path
				break
			}
		}
	}
	if sourcePath == "" {
		for _, ws := range registry.Workspaces {
			if ws.ProjectID != parentCfg.ProjectID {
				continue
			}
			metaPath := filepath.Join(config.GetSnapshotsDirAt(ws.Path), baseSnapshotID+".meta.json")
			if _, err := os.Stat(metaPath); err == nil {
				sourcePath = ws.Path
				break
			}
		}
	}
	if sourcePath == "" {
		return fmt.Errorf("base snapshot source workspace not found")
	}

	sourceSnapshots := config.GetSnapshotsDirAt(sourcePath)
	sourceManifests := config.GetManifestsDirAt(sourcePath)
	targetSnapshots := config.GetSnapshotsDirAt(workspaceDir)
	targetManifests := config.GetManifestsDirAt(workspaceDir)

	metaPath := filepath.Join(sourceSnapshots, baseSnapshotID+".meta.json")
	metaData, err := os.ReadFile(metaPath)
	if err != nil {
		return fmt.Errorf("failed to read base snapshot metadata: %w", err)
	}

	var meta struct {
		ManifestHash string `json:"manifest_hash"`
	}
	if err := json.Unmarshal(metaData, &meta); err != nil {
		return fmt.Errorf("failed to parse base snapshot metadata: %w", err)
	}
	if meta.ManifestHash == "" {
		return fmt.Errorf("base snapshot metadata missing manifest hash")
	}

	manifestPath := filepath.Join(sourceManifests, meta.ManifestHash+".json")
	manifestData, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("failed to read base manifest: %w", err)
	}

	if err := os.MkdirAll(targetSnapshots, 0755); err != nil {
		return fmt.Errorf("failed to create snapshots dir: %w", err)
	}
	if err := os.MkdirAll(targetManifests, 0755); err != nil {
		return fmt.Errorf("failed to create manifests dir: %w", err)
	}

	if _, err := os.Stat(filepath.Join(targetSnapshots, baseSnapshotID+".meta.json")); err != nil {
		if err := os.WriteFile(filepath.Join(targetSnapshots, baseSnapshotID+".meta.json"), metaData, 0644); err != nil {
			return fmt.Errorf("failed to write base snapshot metadata: %w", err)
		}
	}
	if _, err := os.Stat(filepath.Join(targetManifests, meta.ManifestHash+".json")); err != nil {
		if err := os.WriteFile(filepath.Join(targetManifests, meta.ManifestHash+".json"), manifestData, 0644); err != nil {
			return fmt.Errorf("failed to write base manifest: %w", err)
		}
	}

	return nil
}
