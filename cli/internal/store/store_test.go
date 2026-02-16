package store

import (
	"os"
	"path/filepath"
	"testing"
)

func setupStore(t *testing.T) (*Store, string) {
	t.Helper()
	root := t.TempDir()
	s := OpenAt(root)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}
	return s, root
}

func TestOpenAt(t *testing.T) {
	root := t.TempDir()
	s := OpenAt(root)

	if s.Root() != root {
		t.Fatalf("expected root %s, got %s", root, s.Root())
	}
	if s.SnapshotsDir() != filepath.Join(root, ".fst", "snapshots") {
		t.Fatalf("unexpected snapshots dir: %s", s.SnapshotsDir())
	}
	if s.ManifestsDir() != filepath.Join(root, ".fst", "manifests") {
		t.Fatalf("unexpected manifests dir: %s", s.ManifestsDir())
	}
	if s.BlobsDir() != filepath.Join(root, ".fst", "blobs") {
		t.Fatalf("unexpected blobs dir: %s", s.BlobsDir())
	}
}

func TestOpenFromWorkspaceStandalone(t *testing.T) {
	// No project config above — standalone mode, uses workspace root as project root
	root := t.TempDir()
	s := OpenFromWorkspace(root)

	if s.Root() != root {
		t.Fatalf("expected standalone root %s, got %s", root, s.Root())
	}
}

func TestOpenFromWorkspaceWithProject(t *testing.T) {
	// Create project root with .fst/config.json (type "project")
	projectRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(projectRoot, ".fst"), 0755); err != nil {
		t.Fatalf("mkdir .fst: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, ".fst", "config.json"), []byte(`{"type":"project","project_id":"p1","project_name":"test"}`), 0644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}

	// Create workspace dir under project
	wsRoot := filepath.Join(projectRoot, "ws1")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("mkdir ws: %v", err)
	}

	s := OpenFromWorkspace(wsRoot)
	if s.Root() != projectRoot {
		t.Fatalf("expected project root %s, got %s", projectRoot, s.Root())
	}
}

func TestEnsureDirs(t *testing.T) {
	root := t.TempDir()
	s := OpenAt(root)

	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	for _, dir := range []string{s.SnapshotsDir(), s.ManifestsDir(), s.BlobsDir()} {
		info, err := os.Stat(dir)
		if err != nil {
			t.Fatalf("dir %s missing: %v", dir, err)
		}
		if !info.IsDir() {
			t.Fatalf("expected %s to be a directory", dir)
		}
	}
}
