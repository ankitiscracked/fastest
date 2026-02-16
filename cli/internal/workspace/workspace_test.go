package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
)

// setupTestWorkspace creates a standalone workspace (no parent project config)
// with config.json and the given files in the working directory.
func setupTestWorkspace(t *testing.T, files map[string]string) (string, *Workspace) {
	t.Helper()
	root := t.TempDir()

	// Initialize workspace
	if err := config.InitAt(root, "proj-test", "ws-test", "test-ws", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}

	// Create .fstignore
	fstignore := filepath.Join(root, ".fstignore")
	if _, err := os.Stat(fstignore); os.IsNotExist(err) {
		os.WriteFile(fstignore, []byte(".fst/\n"), 0644)
	}

	// Write files
	for path, content := range files {
		full := filepath.Join(root, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write %s: %v", path, err)
		}
	}

	ws, err := OpenAt(root)
	if err != nil {
		t.Fatalf("OpenAt: %v", err)
	}
	t.Cleanup(func() { ws.Close() })

	return root, ws
}

func TestOpenAt(t *testing.T) {
	root, ws := setupTestWorkspace(t, nil)

	if ws.Root() != root {
		t.Fatalf("root mismatch: %s vs %s", ws.Root(), root)
	}
	if ws.ProjectID() != "proj-test" {
		t.Fatalf("project ID mismatch: %s", ws.ProjectID())
	}
	if ws.WorkspaceID() != "ws-test" {
		t.Fatalf("workspace ID mismatch: %s", ws.WorkspaceID())
	}
	if ws.WorkspaceName() != "test-ws" {
		t.Fatalf("workspace name mismatch: %s", ws.WorkspaceName())
	}
	if ws.Store() == nil {
		t.Fatalf("store is nil")
	}
	if ws.Config() == nil {
		t.Fatalf("config is nil")
	}
}

func TestOpenAtNotAWorkspace(t *testing.T) {
	root := t.TempDir()
	_, err := OpenAt(root)
	if err == nil {
		t.Fatalf("expected error for non-workspace directory")
	}
}

func TestSaveConfigAndSetCurrentSnapshotID(t *testing.T) {
	root, ws := setupTestWorkspace(t, nil)

	if err := ws.SetCurrentSnapshotID("snap-new"); err != nil {
		t.Fatalf("SetCurrentSnapshotID: %v", err)
	}

	// Close before reopening — only one workspace handle should be open at a time
	ws.Close()

	// Reload and verify
	reloaded, err := OpenAt(root)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	defer reloaded.Close()
	if reloaded.CurrentSnapshotID() != "snap-new" {
		t.Fatalf("expected snap-new, got %s", reloaded.CurrentSnapshotID())
	}
}

func TestStatCachePath(t *testing.T) {
	_, ws := setupTestWorkspace(t, nil)

	path := ws.StatCachePath()
	if path == "" {
		t.Fatalf("expected non-empty stat cache path")
	}
	if !filepath.IsAbs(path) {
		t.Fatalf("expected absolute path, got %s", path)
	}
}
