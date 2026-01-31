package index

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func setenv(t *testing.T, key, value string) {
	t.Helper()
	prev, ok := os.LookupEnv(key)
	if err := os.Setenv(key, value); err != nil {
		t.Fatalf("setenv %s: %v", key, err)
	}
	t.Cleanup(func() {
		if ok {
			_ = os.Setenv(key, prev)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func TestLoadLegacyWorkspaces(t *testing.T) {
	root := t.TempDir()
	setenv(t, "XDG_CONFIG_HOME", root)

	legacyPath := filepath.Join(root, "fst", legacyWorkspacesFile)
	if err := os.MkdirAll(filepath.Dir(legacyPath), 0700); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	legacy := legacyRegistry{
		Workspaces: []legacyWorkspace{
			{
				ID:        "ws-1",
				ProjectID: "proj-1",
				Name:      "main",
				Path:      "/tmp/demo",
			},
		},
	}
	data, err := json.MarshalIndent(legacy, "", "  ")
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(legacyPath, data, 0644); err != nil {
		t.Fatalf("write legacy: %v", err)
	}

	idx, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(idx.Workspaces) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(idx.Workspaces))
	}
	if idx.Workspaces[0].WorkspaceID != "ws-1" || idx.Workspaces[0].WorkspaceName != "main" {
		t.Fatalf("unexpected workspace data: %+v", idx.Workspaces[0])
	}
}

func TestUpsertWorkspaceReplacesOldPath(t *testing.T) {
	root := t.TempDir()
	setenv(t, "XDG_CONFIG_HOME", root)

	if err := UpsertWorkspace(WorkspaceEntry{
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
		ProjectID:     "proj-1",
		Path:          "/tmp/old",
		LocalOnly:     true,
	}, ""); err != nil {
		t.Fatalf("UpsertWorkspace: %v", err)
	}

	if err := UpsertWorkspace(WorkspaceEntry{
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
		ProjectID:     "proj-1",
		Path:          "/tmp/new",
		LocalOnly:     true,
	}, "/tmp/old"); err != nil {
		t.Fatalf("UpsertWorkspace move: %v", err)
	}

	idx, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if len(idx.Workspaces) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(idx.Workspaces))
	}
	if idx.Workspaces[0].Path != "/tmp/new" {
		t.Fatalf("expected new path, got %s", idx.Workspaces[0].Path)
	}
}
