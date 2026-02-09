package store

import (
	"os"
	"path/filepath"
	"testing"
)

func setupTestStore(t *testing.T) *Store {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".fst"), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	return OpenAt(root)
}

func TestListWorkspacesEmpty(t *testing.T) {
	s := setupTestStore(t)
	list, err := s.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(list) != 0 {
		t.Fatalf("expected empty list, got %d entries", len(list))
	}
}

func TestRegisterAndFindByName(t *testing.T) {
	s := setupTestStore(t)

	err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		Path:              "/tmp/main",
		CurrentSnapshotID: "snap-1",
		BaseSnapshotID:    "snap-0",
		CreatedAt:         "2025-01-01T00:00:00Z",
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	found, err := s.FindWorkspaceByName("main")
	if err != nil {
		t.Fatalf("FindWorkspaceByName: %v", err)
	}
	if found.WorkspaceID != "ws-1" {
		t.Fatalf("expected ws-1, got %s", found.WorkspaceID)
	}
	if found.CurrentSnapshotID != "snap-1" {
		t.Fatalf("expected snap-1, got %s", found.CurrentSnapshotID)
	}
	if found.BaseSnapshotID != "snap-0" {
		t.Fatalf("expected snap-0, got %s", found.BaseSnapshotID)
	}
}

func TestRegisterAndFindByID(t *testing.T) {
	s := setupTestStore(t)

	err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:   "ws-abc",
		WorkspaceName: "feature",
		Path:          "/tmp/feature",
	})
	if err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	found, err := s.FindWorkspaceByID("ws-abc")
	if err != nil {
		t.Fatalf("FindWorkspaceByID: %v", err)
	}
	if found.WorkspaceName != "feature" {
		t.Fatalf("expected feature, got %s", found.WorkspaceName)
	}
}

func TestFindNotFound(t *testing.T) {
	s := setupTestStore(t)

	_, err := s.FindWorkspaceByName("nope")
	if err == nil {
		t.Fatalf("expected error for missing workspace")
	}

	_, err = s.FindWorkspaceByID("nope")
	if err == nil {
		t.Fatalf("expected error for missing workspace ID")
	}
}

func TestRegisterUpsert(t *testing.T) {
	s := setupTestStore(t)

	// Register initial
	if err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		Path:              "/tmp/main",
		CurrentSnapshotID: "snap-1",
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	// Upsert with all fields (new semantics: full overwrite)
	if err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		Path:              "/tmp/main",
		CurrentSnapshotID: "snap-2",
	}); err != nil {
		t.Fatalf("RegisterWorkspace upsert: %v", err)
	}

	found, err := s.FindWorkspaceByID("ws-1")
	if err != nil {
		t.Fatalf("FindWorkspaceByID: %v", err)
	}
	if found.CurrentSnapshotID != "snap-2" {
		t.Fatalf("expected snap-2, got %s", found.CurrentSnapshotID)
	}
	if found.WorkspaceName != "main" {
		t.Fatalf("expected main, got %s", found.WorkspaceName)
	}
	if found.Path != "/tmp/main" {
		t.Fatalf("expected /tmp/main, got %s", found.Path)
	}

	// Upsert can clear fields
	if err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
		Path:          "/tmp/main",
	}); err != nil {
		t.Fatalf("RegisterWorkspace clear: %v", err)
	}
	found, err = s.FindWorkspaceByID("ws-1")
	if err != nil {
		t.Fatalf("FindWorkspaceByID: %v", err)
	}
	if found.CurrentSnapshotID != "" {
		t.Fatalf("expected empty CurrentSnapshotID, got %s", found.CurrentSnapshotID)
	}
}

func TestUpdateWorkspaceHead(t *testing.T) {
	s := setupTestStore(t)

	if err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: "snap-1",
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	if err := s.UpdateWorkspaceHead("ws-1", "snap-99"); err != nil {
		t.Fatalf("UpdateWorkspaceHead: %v", err)
	}

	found, err := s.FindWorkspaceByID("ws-1")
	if err != nil {
		t.Fatalf("FindWorkspaceByID: %v", err)
	}
	if found.CurrentSnapshotID != "snap-99" {
		t.Fatalf("expected snap-99, got %s", found.CurrentSnapshotID)
	}
}

func TestUpdateWorkspaceHeadNotFound(t *testing.T) {
	s := setupTestStore(t)

	err := s.UpdateWorkspaceHead("ws-missing", "snap-1")
	if err == nil {
		t.Fatalf("expected error for missing workspace")
	}
}

func TestListWorkspaces(t *testing.T) {
	s := setupTestStore(t)

	for _, name := range []string{"main", "feature-a", "feature-b"} {
		if err := s.RegisterWorkspace(WorkspaceInfo{
			WorkspaceID:   "ws-" + name,
			WorkspaceName: name,
		}); err != nil {
			t.Fatalf("RegisterWorkspace %s: %v", name, err)
		}
	}

	list, err := s.ListWorkspaces()
	if err != nil {
		t.Fatalf("ListWorkspaces: %v", err)
	}
	if len(list) != 3 {
		t.Fatalf("expected 3 workspaces, got %d", len(list))
	}
}

func TestRegistryPersistence(t *testing.T) {
	s := setupTestStore(t)

	if err := s.RegisterWorkspace(WorkspaceInfo{
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	// Open a new store at the same root
	s2 := OpenAt(s.Root())
	found, err := s2.FindWorkspaceByName("main")
	if err != nil {
		t.Fatalf("FindWorkspaceByName from new store: %v", err)
	}
	if found.WorkspaceID != "ws-1" {
		t.Fatalf("expected ws-1, got %s", found.WorkspaceID)
	}
}
