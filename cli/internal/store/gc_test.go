package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestGC_NothingToCollect(t *testing.T) {
	s, _ := setupStore(t)

	// Create a chain: base → current, register workspace pointing to current
	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "hello",
	})
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": "world",
	})

	s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: current,
	})

	result, err := s.GC(GCOpts{DryRun: true})
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if len(result.UnreachableSnapshots) != 0 {
		t.Fatalf("expected 0 unreachable, got %d", len(result.UnreachableSnapshots))
	}
}

func TestGC_DeletesUnreachable(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "hello",
	})
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": "world",
	})
	// Orphan: not in any workspace's ancestry
	orphan := seedSnapshot(t, s, "snap-orphan", nil, map[string]string{
		"orphan.txt": "orphan-content",
	})

	s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: current,
	})

	result, err := s.GC(GCOpts{})
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if result.DeletedSnapshots != 1 {
		t.Fatalf("expected 1 deleted snapshot, got %d", result.DeletedSnapshots)
	}

	// Verify orphan is gone
	if s.SnapshotExists(orphan) {
		t.Fatalf("orphan snapshot should have been deleted")
	}
	// Verify reachable still exist
	if !s.SnapshotExists(base) {
		t.Fatalf("base snapshot should still exist")
	}
	if !s.SnapshotExists(current) {
		t.Fatalf("current snapshot should still exist")
	}
}

func TestGC_DryRunDoesNotDelete(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "hello",
	})
	orphan := seedSnapshot(t, s, "snap-orphan", nil, map[string]string{
		"orphan.txt": "data",
	})

	s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: base,
	})

	result, err := s.GC(GCOpts{DryRun: true})
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if len(result.UnreachableSnapshots) != 1 {
		t.Fatalf("expected 1 unreachable, got %d", len(result.UnreachableSnapshots))
	}
	if result.DeletedSnapshots != 0 {
		t.Fatalf("dry run should not delete, got %d deleted", result.DeletedSnapshots)
	}
	// Orphan should still exist
	if !s.SnapshotExists(orphan) {
		t.Fatalf("orphan should still exist after dry run")
	}
}

func TestGC_DeletesOrphanedBlobs(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "hello",
	})

	s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: base,
	})

	// Write an orphaned blob
	orphanBlobHash := "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
	os.WriteFile(filepath.Join(s.BlobsDir(), orphanBlobHash), []byte("orphan"), 0644)

	result, err := s.GC(GCOpts{})
	if err != nil {
		t.Fatalf("GC: %v", err)
	}
	if result.DeletedBlobs != 1 {
		t.Fatalf("expected 1 deleted blob, got %d", result.DeletedBlobs)
	}

	// Verify orphan blob is gone
	if _, err := os.Stat(filepath.Join(s.BlobsDir(), orphanBlobHash)); err == nil {
		t.Fatalf("orphan blob should have been deleted")
	}
}

func TestBuildReachableSet(t *testing.T) {
	s, _ := setupStore(t)

	// Chain: a → b → c, plus d (disconnected)
	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})
	seedSnapshot(t, s, "snap-d", nil, map[string]string{"d.txt": "d"})

	reachable := s.BuildReachableSet([]string{c})

	if _, ok := reachable[a]; !ok {
		t.Fatalf("expected a to be reachable")
	}
	if _, ok := reachable[b]; !ok {
		t.Fatalf("expected b to be reachable")
	}
	if _, ok := reachable[c]; !ok {
		t.Fatalf("expected c to be reachable")
	}
	if _, ok := reachable["snap-d"]; ok {
		t.Fatalf("expected d to NOT be reachable")
	}
}

func TestLoadAllSnapshotMetas(t *testing.T) {
	s, _ := setupStore(t)

	seedSnapshot(t, s, "snap-1", nil, map[string]string{"a.txt": "a"})
	seedSnapshot(t, s, "snap-2", nil, map[string]string{"b.txt": "b"})

	metas, err := s.LoadAllSnapshotMetas()
	if err != nil {
		t.Fatalf("LoadAllSnapshotMetas: %v", err)
	}
	if len(metas) != 2 {
		t.Fatalf("expected 2 metas, got %d", len(metas))
	}
}
