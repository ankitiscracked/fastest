package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectInitRejectsHome(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "HOME", root)
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "init", "demo"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Fatalf("expected home directory error, got: %v", err)
	}
}

func TestProjectCreateCreatesMainWorkspace(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "create", "demo"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("project create failed: %v", err)
	}

	projectPath := filepath.Join(root, "demo")
	workspacePath := filepath.Join(projectPath, "main")

	if _, err := os.Stat(filepath.Join(projectPath, "fst.json")); err != nil {
		t.Fatalf("expected fst.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspacePath, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config: %v", err)
	}
}

func TestProjectCreateRejectsHome(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "HOME", root)
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "create", "demo"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Fatalf("expected home directory error, got: %v", err)
	}
}
