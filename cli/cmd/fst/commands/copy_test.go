package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func TestCreateRejectsWithoutProjectFolder(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "project folder") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCreateRejectsWhenNoSourceWorkspace(t *testing.T) {
	parent := t.TempDir()
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "no main workspace found") {
		t.Fatalf("expected no main workspace error, got: %v", err)
	}
}

func TestCreateRejectsTargetAlreadyExists(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Create main workspace with snapshot
	mainDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(mainDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(mainDir, "f.txt"), []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := config.InitAt(mainDir, "proj-copy", "ws-main", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	s := store.OpenAt(parent)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   "ws-main",
		WorkspaceName: "main",
		Path:          mainDir,
	})

	restoreCwd := chdir(t, mainDir)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restoreCwd()

	// Create target directory so it already exists
	featureDir := filepath.Join(parent, "feature")
	if err := os.MkdirAll(featureDir, 0755); err != nil {
		t.Fatalf("mkdir feature: %v", err)
	}

	restoreCwd = chdir(t, parent)
	defer restoreCwd()

	cmd = NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected already exists error, got: %v", err)
	}
}
