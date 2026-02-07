package store

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLoadWriteSnapshotMeta(t *testing.T) {
	s, _ := setupStore(t)

	meta := &SnapshotMeta{
		ID:                "snap-test1",
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		ManifestHash:      "abc123",
		ParentSnapshotIDs: []string{"snap-parent1"},
		AuthorName:        "Test",
		AuthorEmail:       "test@example.com",
		CreatedAt:         "2024-01-01T00:00:00Z",
		Files:             5,
		Size:              1024,
	}

	if err := s.WriteSnapshotMeta(meta); err != nil {
		t.Fatalf("WriteSnapshotMeta: %v", err)
	}

	loaded, err := s.LoadSnapshotMeta("snap-test1")
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}

	if loaded.ID != meta.ID {
		t.Fatalf("ID mismatch: %s vs %s", loaded.ID, meta.ID)
	}
	if loaded.ManifestHash != meta.ManifestHash {
		t.Fatalf("ManifestHash mismatch: %s vs %s", loaded.ManifestHash, meta.ManifestHash)
	}
	if loaded.WorkspaceName != "main" {
		t.Fatalf("WorkspaceName mismatch: %s", loaded.WorkspaceName)
	}
	if loaded.AuthorName != "Test" {
		t.Fatalf("AuthorName mismatch: %s", loaded.AuthorName)
	}
	if len(loaded.ParentSnapshotIDs) != 1 || loaded.ParentSnapshotIDs[0] != "snap-parent1" {
		t.Fatalf("ParentSnapshotIDs mismatch: %v", loaded.ParentSnapshotIDs)
	}
}

func TestLoadSnapshotMetaNotFound(t *testing.T) {
	s, _ := setupStore(t)

	_, err := s.LoadSnapshotMeta("nonexistent")
	if err == nil {
		t.Fatalf("expected error for missing snapshot")
	}
}

func TestLoadSnapshotMetaEmptyID(t *testing.T) {
	s, _ := setupStore(t)

	_, err := s.LoadSnapshotMeta("")
	if err == nil {
		t.Fatalf("expected error for empty ID")
	}
}

func TestSnapshotExists(t *testing.T) {
	s, _ := setupStore(t)

	if s.SnapshotExists("snap-x") {
		t.Fatalf("expected false for nonexistent snapshot")
	}

	if err := s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-x", CreatedAt: "2024-01-01T00:00:00Z"}); err != nil {
		t.Fatalf("WriteSnapshotMeta: %v", err)
	}

	if !s.SnapshotExists("snap-x") {
		t.Fatalf("expected true for existing snapshot")
	}
}

func TestDeleteSnapshot(t *testing.T) {
	s, _ := setupStore(t)

	if err := s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-del", CreatedAt: "2024-01-01T00:00:00Z"}); err != nil {
		t.Fatalf("write: %v", err)
	}
	if !s.SnapshotExists("snap-del") {
		t.Fatalf("snapshot should exist after write")
	}

	if err := s.DeleteSnapshot("snap-del"); err != nil {
		t.Fatalf("DeleteSnapshot: %v", err)
	}
	if s.SnapshotExists("snap-del") {
		t.Fatalf("snapshot should not exist after delete")
	}
}

func TestResolveSnapshotID(t *testing.T) {
	s, _ := setupStore(t)

	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-abc123", CreatedAt: "2024-01-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-abc456", CreatedAt: "2024-01-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-xyz789", CreatedAt: "2024-01-01T00:00:00Z"})

	// Unique prefix
	id, err := s.ResolveSnapshotID("snap-xyz")
	if err != nil {
		t.Fatalf("ResolveSnapshotID: %v", err)
	}
	if id != "snap-xyz789" {
		t.Fatalf("expected snap-xyz789, got %s", id)
	}

	// Ambiguous prefix
	_, err = s.ResolveSnapshotID("snap-abc")
	if err == nil {
		t.Fatalf("expected ambiguous error")
	}

	// Full ID
	id, err = s.ResolveSnapshotID("snap-abc123")
	if err != nil {
		t.Fatalf("ResolveSnapshotID full: %v", err)
	}
	if id != "snap-abc123" {
		t.Fatalf("expected snap-abc123, got %s", id)
	}

	// Not found
	_, err = s.ResolveSnapshotID("snap-zzz")
	if err == nil {
		t.Fatalf("expected not-found error")
	}
}

func TestGetLatestSnapshotID(t *testing.T) {
	s, _ := setupStore(t)

	// Empty store
	id, err := s.GetLatestSnapshotID()
	if err != nil {
		t.Fatalf("GetLatestSnapshotID on empty: %v", err)
	}
	if id != "" {
		t.Fatalf("expected empty ID for empty store, got %s", id)
	}

	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-old", CreatedAt: "2024-01-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-new", CreatedAt: "2025-06-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "snap-mid", CreatedAt: "2024-06-01T00:00:00Z"})

	id, err = s.GetLatestSnapshotID()
	if err != nil {
		t.Fatalf("GetLatestSnapshotID: %v", err)
	}
	if id != "snap-new" {
		t.Fatalf("expected snap-new, got %s", id)
	}
}

func TestGetLatestSnapshotIDForWorkspace(t *testing.T) {
	s, _ := setupStore(t)

	s.WriteSnapshotMeta(&SnapshotMeta{ID: "s1", WorkspaceID: "ws-a", CreatedAt: "2024-01-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "s2", WorkspaceID: "ws-b", CreatedAt: "2025-01-01T00:00:00Z"})
	s.WriteSnapshotMeta(&SnapshotMeta{ID: "s3", WorkspaceID: "ws-a", CreatedAt: "2024-06-01T00:00:00Z"})

	id, err := s.GetLatestSnapshotIDForWorkspace("ws-a")
	if err != nil {
		t.Fatalf("GetLatestSnapshotIDForWorkspace: %v", err)
	}
	if id != "s3" {
		t.Fatalf("expected s3, got %s", id)
	}

	id, err = s.GetLatestSnapshotIDForWorkspace("ws-b")
	if err != nil {
		t.Fatalf("GetLatestSnapshotIDForWorkspace ws-b: %v", err)
	}
	if id != "s2" {
		t.Fatalf("expected s2, got %s", id)
	}

	// Empty workspace ID falls back to global latest
	id, err = s.GetLatestSnapshotIDForWorkspace("")
	if err != nil {
		t.Fatalf("GetLatestSnapshotIDForWorkspace empty: %v", err)
	}
	if id != "s2" {
		t.Fatalf("expected s2, got %s", id)
	}
}

func TestManifestHashFromSnapshotID(t *testing.T) {
	s, _ := setupStore(t)

	s.WriteSnapshotMeta(&SnapshotMeta{
		ID:           "snap-hash1",
		ManifestHash: "mhash-abc",
		CreatedAt:    "2024-01-01T00:00:00Z",
	})

	hash, err := s.ManifestHashFromSnapshotID("snap-hash1")
	if err != nil {
		t.Fatalf("ManifestHashFromSnapshotID: %v", err)
	}
	if hash != "mhash-abc" {
		t.Fatalf("expected mhash-abc, got %s", hash)
	}
}

func TestManifestHashFromSnapshotIDContentAddressedVerifies(t *testing.T) {
	s, _ := setupStore(t)

	mhash := "abc123"
	parents := []string{"p1"}
	name := "John"
	email := "john@example.com"
	ts := "2024-01-01T00:00:00Z"
	id := ComputeSnapshotID(mhash, parents, name, email, ts)

	s.WriteSnapshotMeta(&SnapshotMeta{
		ID:                id,
		ManifestHash:      mhash,
		ParentSnapshotIDs: parents,
		AuthorName:        name,
		AuthorEmail:       email,
		CreatedAt:         ts,
	})

	hash, err := s.ManifestHashFromSnapshotID(id)
	if err != nil {
		t.Fatalf("ManifestHashFromSnapshotID: %v", err)
	}
	if hash != mhash {
		t.Fatalf("expected %s, got %s", mhash, hash)
	}

	// Tamper with the stored metadata
	metaPath := filepath.Join(s.snapshotsDir, id+".meta.json")
	data, _ := os.ReadFile(metaPath)
	var raw map[string]interface{}
	json.Unmarshal(data, &raw)
	raw["parent_snapshot_ids"] = []string{"tampered"}
	tampered, _ := json.MarshalIndent(raw, "", "  ")
	os.WriteFile(metaPath, tampered, 0644)

	_, err = s.ManifestHashFromSnapshotID(id)
	if err == nil {
		t.Fatalf("expected integrity check failure after tampering")
	}
}

func TestManifestHashFromSnapshotIDLegacyEmbedded(t *testing.T) {
	s, _ := setupStore(t)

	// Legacy format: snap- followed by 64-char hash IS the manifest hash
	legacyID := "snap-" + "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	hash, err := s.ManifestHashFromSnapshotID(legacyID)
	if err != nil {
		t.Fatalf("expected legacy embedded hash to resolve: %v", err)
	}
	expected := "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	if hash != expected {
		t.Fatalf("expected %s, got %s", expected, hash)
	}
}

func TestSnapshotParentIDs(t *testing.T) {
	s, _ := setupStore(t)

	s.WriteSnapshotMeta(&SnapshotMeta{
		ID:                "snap-p1",
		ParentSnapshotIDs: []string{"snap-a", "snap-b", "snap-a", ""}, // duplicates and empty
		CreatedAt:         "2024-01-01T00:00:00Z",
	})

	parents, err := s.SnapshotParentIDs("snap-p1")
	if err != nil {
		t.Fatalf("SnapshotParentIDs: %v", err)
	}
	if len(parents) != 2 {
		t.Fatalf("expected 2 unique parents, got %d: %v", len(parents), parents)
	}
	if parents[0] != "snap-a" || parents[1] != "snap-b" {
		t.Fatalf("unexpected parents: %v", parents)
	}
}

func TestSnapshotPrimaryParentID(t *testing.T) {
	s, _ := setupStore(t)

	// With parents
	s.WriteSnapshotMeta(&SnapshotMeta{
		ID:                "snap-pp1",
		ParentSnapshotIDs: []string{"snap-first", "snap-second"},
		CreatedAt:         "2024-01-01T00:00:00Z",
	})

	primary, err := s.SnapshotPrimaryParentID("snap-pp1")
	if err != nil {
		t.Fatalf("SnapshotPrimaryParentID: %v", err)
	}
	if primary != "snap-first" {
		t.Fatalf("expected snap-first, got %s", primary)
	}

	// No parents
	s.WriteSnapshotMeta(&SnapshotMeta{
		ID:        "snap-root",
		CreatedAt: "2024-01-01T00:00:00Z",
	})

	primary, err = s.SnapshotPrimaryParentID("snap-root")
	if err != nil {
		t.Fatalf("SnapshotPrimaryParentID (no parents): %v", err)
	}
	if primary != "" {
		t.Fatalf("expected empty for no parents, got %s", primary)
	}
}
