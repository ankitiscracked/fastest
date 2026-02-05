package commands

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
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

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "init"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected init to fail without a project folder")
	}
}

func TestWorkspaceCreateFromParent(t *testing.T) {
	parent := t.TempDir()
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-123",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "dev"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create failed: %v", err)
	}

	workspaceDir := filepath.Join(parent, "dev")
	if _, err := os.Stat(filepath.Join(workspaceDir, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config to exist: %v", err)
	}
}
