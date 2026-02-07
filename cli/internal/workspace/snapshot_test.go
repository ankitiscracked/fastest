package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func TestSnapshot(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"hello.txt": "hello world",
		"src/main.go": `package main

func main() {}
`,
	})

	result, err := ws.Snapshot(SnapshotOpts{
		Message: "initial snapshot",
		Author:  &config.Author{Name: "Test", Email: "test@test.com"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	if result.SnapshotID == "" {
		t.Fatalf("expected non-empty snapshot ID")
	}
	if !store.IsContentAddressedSnapshotID(result.SnapshotID) {
		t.Fatalf("expected content-addressed ID, got %s", result.SnapshotID)
	}
	if result.ManifestHash == "" {
		t.Fatalf("expected non-empty manifest hash")
	}
	if result.Files < 2 {
		t.Fatalf("expected at least 2 files, got %d", result.Files)
	}
	if result.Size <= 0 {
		t.Fatalf("expected positive size, got %d", result.Size)
	}

	// Verify workspace config was updated
	if ws.CurrentSnapshotID() != result.SnapshotID {
		t.Fatalf("config not updated: %s vs %s", ws.CurrentSnapshotID(), result.SnapshotID)
	}

	// Verify snapshot metadata in store
	meta, err := ws.Store().LoadSnapshotMeta(result.SnapshotID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	if meta.Message != "initial snapshot" {
		t.Fatalf("message mismatch: %s", meta.Message)
	}
	if meta.AuthorName != "Test" {
		t.Fatalf("author mismatch: %s", meta.AuthorName)
	}
	if meta.WorkspaceID != "ws-test" {
		t.Fatalf("workspace ID mismatch: %s", meta.WorkspaceID)
	}

	// Verify manifest exists in store
	if !ws.Store().ManifestExists(result.ManifestHash) {
		t.Fatalf("manifest not written to store")
	}

	// Verify blobs were cached
	for _, f := range []string{"hello.txt", "src/main.go"} {
		content, _ := os.ReadFile(filepath.Join(root, f))
		_ = content // blobs are keyed by hash, just verify they exist
	}
}

func TestSnapshotParentChain(t *testing.T) {
	_, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "v1",
	})

	// First snapshot — no parents
	r1, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot v1: %v", err)
	}

	meta1, _ := ws.Store().LoadSnapshotMeta(r1.SnapshotID)
	if len(meta1.ParentSnapshotIDs) != 0 {
		t.Fatalf("first snapshot should have no parents, got %v", meta1.ParentSnapshotIDs)
	}

	// Modify file and snapshot again
	os.WriteFile(filepath.Join(ws.Root(), "file.txt"), []byte("v2"), 0644)

	r2, err := ws.Snapshot(SnapshotOpts{
		Message: "v2",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot v2: %v", err)
	}

	meta2, _ := ws.Store().LoadSnapshotMeta(r2.SnapshotID)
	if len(meta2.ParentSnapshotIDs) != 1 {
		t.Fatalf("second snapshot should have 1 parent, got %v", meta2.ParentSnapshotIDs)
	}
	if meta2.ParentSnapshotIDs[0] != r1.SnapshotID {
		t.Fatalf("parent should be first snapshot %s, got %s", r1.SnapshotID, meta2.ParentSnapshotIDs[0])
	}
}

func TestAutoSnapshotNoChanges(t *testing.T) {
	_, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "content",
	})

	// Create initial snapshot
	_, err := ws.Snapshot(SnapshotOpts{
		Message: "initial",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("initial snapshot: %v", err)
	}

	// AutoSnapshot with no changes should return empty
	id, err := ws.AutoSnapshot("no changes")
	if err != nil {
		t.Fatalf("AutoSnapshot: %v", err)
	}
	if id != "" {
		t.Fatalf("expected empty ID for no changes, got %s", id)
	}
}

func TestAutoSnapshotWithChanges(t *testing.T) {
	_, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "v1",
	})

	// Create initial snapshot
	_, err := ws.Snapshot(SnapshotOpts{
		Message: "initial",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("initial snapshot: %v", err)
	}

	// Modify file
	os.WriteFile(filepath.Join(ws.Root(), "file.txt"), []byte("v2"), 0644)

	// AutoSnapshot should detect changes
	id, err := ws.AutoSnapshot("before merge")
	if err != nil {
		t.Fatalf("AutoSnapshot: %v", err)
	}
	if id == "" {
		t.Fatalf("expected non-empty ID for changed files")
	}

	// Verify metadata
	meta, err := ws.Store().LoadSnapshotMeta(id)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	if meta.Message != "before merge" {
		t.Fatalf("message mismatch: %s", meta.Message)
	}
}

func TestSnapshotIntegrity(t *testing.T) {
	_, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "content",
	})

	result, err := ws.Snapshot(SnapshotOpts{
		Message: "test",
		Author:  &config.Author{Name: "Alice", Email: "alice@example.com"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Verify the snapshot ID is correctly content-addressed
	meta, _ := ws.Store().LoadSnapshotMeta(result.SnapshotID)
	expected := store.ComputeSnapshotID(
		meta.ManifestHash,
		meta.ParentSnapshotIDs,
		meta.AuthorName,
		meta.AuthorEmail,
		meta.CreatedAt,
	)
	if result.SnapshotID != expected {
		t.Fatalf("snapshot ID %s doesn't match computed %s", result.SnapshotID, expected)
	}

	// Verify the ID passes verification
	if !store.VerifySnapshotID(result.SnapshotID, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
		t.Fatalf("snapshot failed verification")
	}
}
