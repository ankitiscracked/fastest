package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
)

// setupDriftWorkspaces creates two workspaces sharing a project store with a
// common ancestor snapshot, then applies divergent changes. It also sets the
// current directory to the "ours" workspace (required for conflict detection).
func setupDriftWorkspaces(t *testing.T, ourFiles, theirFiles map[string]string) (*Workspace, *Workspace) {
	t.Helper()

	projectRoot := t.TempDir()

	// Create project config
	os.MkdirAll(filepath.Join(projectRoot, ".fst"), 0755)
	os.WriteFile(filepath.Join(projectRoot, ".fst", "config.json"), []byte(`{"type":"project","project_id":"proj-test","project_name":"test-project"}`), 0644)

	// Create shared store directories
	for _, d := range []string{".fst/snapshots", ".fst/manifests", ".fst/blobs", ".fst/workspaces"} {
		os.MkdirAll(filepath.Join(projectRoot, d), 0755)
	}

	ourRoot := filepath.Join(projectRoot, "ws-ours")
	theirRoot := filepath.Join(projectRoot, "ws-theirs")

	// Initialize workspaces
	for _, ws := range []struct {
		root, id, name string
	}{
		{ourRoot, "ws-ours-id", "ws-ours"},
		{theirRoot, "ws-theirs-id", "ws-theirs"},
	} {
		if err := config.InitAt(ws.root, "proj-1", ws.id, ws.name, ""); err != nil {
			t.Fatalf("InitAt: %v", err)
		}
		// Write .fstignore
		os.WriteFile(filepath.Join(ws.root, ".fstignore"), []byte(".fst/\n"), 0644)
		// Write shared base file
		os.WriteFile(filepath.Join(ws.root, "base.txt"), []byte("base"), 0644)
	}

	// Open workspaces
	wsOurs, err := OpenAt(ourRoot)
	if err != nil {
		t.Fatalf("OpenAt ours: %v", err)
	}
	t.Cleanup(func() { wsOurs.Close() })

	wsTheirs, err := OpenAt(theirRoot)
	if err != nil {
		t.Fatalf("OpenAt theirs: %v", err)
	}
	t.Cleanup(func() { wsTheirs.Close() })

	author := &config.Author{Name: "T", Email: "t@t"}

	// Create base snapshots
	_, err = wsOurs.Snapshot(SnapshotOpts{Message: "base", Author: author})
	if err != nil {
		t.Fatalf("snapshot ours base: %v", err)
	}
	_, err = wsTheirs.Snapshot(SnapshotOpts{Message: "base", Author: author})
	if err != nil {
		t.Fatalf("snapshot theirs base: %v", err)
	}

	// Write divergent files
	for path, content := range ourFiles {
		full := filepath.Join(ourRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}
	for path, content := range theirFiles {
		full := filepath.Join(theirRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}

	// Take divergent snapshots
	_, err = wsOurs.Snapshot(SnapshotOpts{Message: "our changes", Author: author})
	if err != nil {
		t.Fatalf("snapshot ours changes: %v", err)
	}
	_, err = wsTheirs.Snapshot(SnapshotOpts{Message: "their changes", Author: author})
	if err != nil {
		t.Fatalf("snapshot theirs changes: %v", err)
	}

	// Set working directory to ours workspace (needed for config.GetBlobsDir())
	cwd, _ := os.Getwd()
	os.Chdir(ourRoot)
	t.Cleanup(func() { os.Chdir(cwd) })

	return wsOurs, wsTheirs
}

func TestDriftDetectsChanges(t *testing.T) {
	wsOurs, wsTheirs := setupDriftWorkspaces(t,
		map[string]string{"a.txt": "ours"},
		map[string]string{"b.txt": "theirs"},
	)

	result, err := wsOurs.Drift(DriftOpts{
		TargetName: wsTheirs.WorkspaceName(),
		NoDirty:    true,
	})
	if err != nil {
		t.Fatalf("Drift: %v", err)
	}

	if result.OurChanges == nil || result.TheirChanges == nil {
		t.Fatalf("expected non-nil change reports")
	}
	if result.CommonAncestorID == "" {
		t.Fatalf("expected common ancestor")
	}
}

func TestDriftNoConflictsDisjointFiles(t *testing.T) {
	wsOurs, wsTheirs := setupDriftWorkspaces(t,
		map[string]string{"a.txt": "ours"},
		map[string]string{"b.txt": "theirs"},
	)

	result, err := wsOurs.Drift(DriftOpts{
		TargetName: wsTheirs.WorkspaceName(),
		NoDirty:    true,
	})
	if err != nil {
		t.Fatalf("Drift: %v", err)
	}

	if len(result.OverlappingPaths) > 0 {
		t.Fatalf("expected no overlapping paths for disjoint files, got %v", result.OverlappingPaths)
	}
}

func TestDriftDetectsOverlap(t *testing.T) {
	wsOurs, wsTheirs := setupDriftWorkspaces(t,
		map[string]string{"shared.txt": "ours-version"},
		map[string]string{"shared.txt": "theirs-version"},
	)

	result, err := wsOurs.Drift(DriftOpts{
		TargetName: wsTheirs.WorkspaceName(),
		NoDirty:    true,
	})
	if err != nil {
		t.Fatalf("Drift: %v", err)
	}

	if len(result.OverlappingPaths) == 0 {
		t.Fatalf("expected overlapping paths for same file modifications")
	}

	found := false
	for _, p := range result.OverlappingPaths {
		if p == "shared.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected shared.txt in overlapping paths, got %v", result.OverlappingPaths)
	}
}

func TestDriftWorkspaceNotFound(t *testing.T) {
	wsOurs, _ := setupDriftWorkspaces(t,
		map[string]string{"a.txt": "a"},
		map[string]string{"b.txt": "b"},
	)

	_, err := wsOurs.Drift(DriftOpts{TargetName: "nonexistent"})
	if err == nil {
		t.Fatalf("expected error for nonexistent workspace")
	}
}

func TestDriftNoDirtyMode(t *testing.T) {
	wsOurs, wsTheirs := setupDriftWorkspaces(t,
		map[string]string{"a.txt": "ours"},
		map[string]string{"b.txt": "theirs"},
	)

	result, err := wsOurs.Drift(DriftOpts{
		TargetName: wsTheirs.WorkspaceName(),
		NoDirty:    true,
	})
	if err != nil {
		t.Fatalf("Drift: %v", err)
	}

	if result.DirtyConflicts != nil {
		t.Fatalf("expected nil dirty conflicts in no-dirty mode")
	}
}
