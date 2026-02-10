package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func TestInfoBareInWorkspace(t *testing.T) {
	root := setupWorkspace(t, "ws-info", map[string]string{
		"file.txt": "ok",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info failed: %v", err)
	}

	if !strings.Contains(output, "ws-info") {
		t.Fatalf("expected workspace name in output, got: %s", output)
	}
	if !strings.Contains(output, "Workspace:") {
		t.Fatalf("expected 'Workspace:' label in output, got: %s", output)
	}
}

func TestInfoBareInProject(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-info-test",
		ProjectName: "demo-project",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info failed: %v", err)
	}

	if !strings.Contains(output, "demo-project") {
		t.Fatalf("expected project name in output, got: %s", output)
	}
	if !strings.Contains(output, "Project:") {
		t.Fatalf("expected 'Project:' label in output, got: %s", output)
	}
}

func TestInfoWorkspaceJSON(t *testing.T) {
	root := setupWorkspace(t, "ws-json-info", map[string]string{
		"file.txt": "ok",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info --json failed: %v", err)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil {
		t.Fatalf("invalid JSON: %v\noutput: %s", err, output)
	}
	if payload["workspace_name"] != "ws-json-info" {
		t.Fatalf("workspace_name mismatch: %v", payload["workspace_name"])
	}
	if payload["mode"] != "workspace" {
		t.Fatalf("expected mode=workspace, got: %v", payload["mode"])
	}
}

func TestInfoWorkspaces(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-ws-list",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Create and register two workspaces
	s := store.OpenAt(parent)
	for _, name := range []string{"alpha", "beta"} {
		wsDir := filepath.Join(parent, name)
		if err := os.MkdirAll(wsDir, 0755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
		if err := config.InitAt(wsDir, "proj-ws-list", "ws-"+name, name, ""); err != nil {
			t.Fatalf("InitAt %s: %v", name, err)
		}
		if err := s.RegisterWorkspace(store.WorkspaceInfo{
			WorkspaceID:   "ws-" + name,
			WorkspaceName: name,
			Path:          wsDir,
		}); err != nil {
			t.Fatalf("RegisterWorkspace %s: %v", name, err)
		}
	}

	// Run from inside a workspace so findProjectContext works
	restoreCwd := chdir(t, filepath.Join(parent, "alpha"))
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info", "workspaces"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info workspaces failed: %v", err)
	}

	if !strings.Contains(output, "alpha") {
		t.Fatalf("expected 'alpha' in output, got: %s", output)
	}
	if !strings.Contains(output, "beta") {
		t.Fatalf("expected 'beta' in output, got: %s", output)
	}
	if !strings.Contains(output, "Workspaces (2)") {
		t.Fatalf("expected workspace count in output, got: %s", output)
	}
}

func TestInfoProject(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-info-proj",
		ProjectName: "my-project",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Create a workspace so findProjectContext works
	wsDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := config.InitAt(wsDir, "proj-info-proj", "ws-main", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}

	restoreCwd := chdir(t, wsDir)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info", "project"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info project failed: %v", err)
	}

	if !strings.Contains(output, "my-project") {
		t.Fatalf("expected project name in output, got: %s", output)
	}
	if !strings.Contains(output, "proj-info-proj") {
		t.Fatalf("expected project ID in output, got: %s", output)
	}
}

func TestInfoProjectJSON(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-json-proj",
		ProjectName: "json-project",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	wsDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(wsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := config.InitAt(wsDir, "proj-json-proj", "ws-main", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}

	restoreCwd := chdir(t, wsDir)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"info", "project", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("info project --json failed: %v", err)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil {
		t.Fatalf("invalid JSON: %v\noutput: %s", err, output)
	}
	if payload["project_name"] != "json-project" {
		t.Fatalf("project_name mismatch: %v", payload["project_name"])
	}
	if payload["mode"] != "project" {
		t.Fatalf("expected mode=project, got: %v", payload["mode"])
	}
}
