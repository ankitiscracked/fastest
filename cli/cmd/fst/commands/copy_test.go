package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

func TestCopyRejectsWithoutProjectFolder(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	cfg := &config.ProjectConfig{
		ProjectID:     "proj-copy",
		WorkspaceID:   "ws-copy-id",
		WorkspaceName: "ws-copy",
		Mode:          "local",
	}
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	if err := os.MkdirAll(filepath.Join(root, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(root, "ws-copy-id", "ws-copy", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "no project folder found") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCopyRejectsInProjectFolder(t *testing.T) {
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

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "project folder") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCopyRejectsTargetOutsideProjectFolder(t *testing.T) {
	parent := t.TempDir()
	workspace := filepath.Join(parent, "main")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	cfg := &config.ProjectConfig{
		ProjectID:     "proj-copy",
		WorkspaceID:   "ws-copy-id",
		WorkspaceName: "main",
		Mode:          "local",
	}
	if err := config.SaveAt(workspace, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(workspace, "ws-copy-id", "main", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	restoreCwd := chdir(t, workspace)
	defer restoreCwd()

	outside := t.TempDir()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature", "--to", filepath.Join(outside, "feature")})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "direct child of project folder") {
		t.Fatalf("expected target directory error, got: %v", err)
	}
}
