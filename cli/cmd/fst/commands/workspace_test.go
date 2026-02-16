package commands

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func TestWorkspaceInitRequiresProjectFolder(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "readme.md"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	SetDeps(Deps{})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "init"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected init to fail without a project folder")
	}
}

func TestWorkspaceCreateFromParent(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{})
	defer ResetDeps()

	// Create a project folder
	if err := config.SaveProjectConfigAt(parent, &config.ProjectConfig{
		ProjectID:   "proj-123",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	// Create a main workspace with a file and snapshot
	mainDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(mainDir, 0755); err != nil {
		t.Fatalf("mkdir main: %v", err)
	}
	if err := os.WriteFile(filepath.Join(mainDir, "readme.md"), []byte("hello"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	mainWSID := "ws-main-test"
	if err := config.InitAt(mainDir, "proj-123", mainWSID, "main", ""); err != nil {
		t.Fatalf("InitAt main: %v", err)
	}

	// Register main workspace in project-level registry
	s := store.OpenAt(parent)
	if err := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   mainWSID,
		WorkspaceName: "main",
		Path:          mainDir,
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	// Create a snapshot in main
	restoreCwd := chdir(t, mainDir)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "initial"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	restoreCwd()

	// Now test workspace create from project root
	restoreCwd = chdir(t, parent)
	defer restoreCwd()

	cmd = NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "dev"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create failed: %v", err)
	}

	workspaceDir := filepath.Join(parent, "dev")
	if _, err := os.Stat(filepath.Join(workspaceDir, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config to exist: %v", err)
	}

	// Verify files were copied
	if _, err := os.Stat(filepath.Join(workspaceDir, "readme.md")); err != nil {
		t.Fatalf("expected readme.md to be copied: %v", err)
	}

	// Verify config has correct fork snapshot
	cfg, err := config.LoadAt(workspaceDir)
	if err != nil {
		t.Fatalf("LoadAt dev: %v", err)
	}
	if cfg.BaseSnapshotID == "" {
		t.Fatalf("expected base_snapshot_id to be set")
	}
	if cfg.CurrentSnapshotID == "" {
		t.Fatalf("expected current_snapshot_id to be set")
	}
	if cfg.BaseSnapshotID != cfg.CurrentSnapshotID {
		t.Fatalf("expected base and current snapshot to match, got base=%s current=%s",
			cfg.BaseSnapshotID, cfg.CurrentSnapshotID)
	}
}
