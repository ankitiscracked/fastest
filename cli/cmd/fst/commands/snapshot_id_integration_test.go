package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
)

// fullSnapshotMeta is the full metadata structure including author fields.
type fullSnapshotMeta struct {
	ID                string   `json:"id"`
	ManifestHash      string   `json:"manifest_hash"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	AuthorName        string   `json:"author_name"`
	AuthorEmail       string   `json:"author_email"`
	CreatedAt         string   `json:"created_at"`
	Message           string   `json:"message"`
	Files             int      `json:"files"`
	Size              int64    `json:"size"`
}

func readFullSnapshotMeta(t *testing.T, root, snapshotID string) fullSnapshotMeta {
	t.Helper()
	data, err := os.ReadFile(snapshotMetaPath(root, snapshotID))
	if err != nil {
		t.Fatalf("read snapshot meta %s: %v", snapshotID, err)
	}
	var meta fullSnapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("parse snapshot meta: %v", err)
	}
	return meta
}

func TestSnapshotIDIsContentAddressed(t *testing.T) {
	root := setupWorkspace(t, "ws-ca", map[string]string{
		"file.txt": "hello",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)

	// Verify it's a content-addressed ID (64 hex chars, no snap- prefix)
	if len(baseID) != 64 {
		t.Fatalf("expected 64-char content-addressed ID, got %d chars: %s", len(baseID), baseID)
	}
	if config.IsContentAddressedSnapshotID(baseID) != true {
		t.Fatalf("expected content-addressed ID, got: %s", baseID)
	}

	// Verify ID matches the computed hash
	meta := readFullSnapshotMeta(t, root, baseID)
	expected := config.ComputeSnapshotID(meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt)
	if meta.ID != expected {
		t.Fatalf("snapshot ID %s doesn't match computed ID %s", meta.ID, expected)
	}
}

func TestSnapshotMetadataContainsAuthorFields(t *testing.T) {
	root := setupWorkspace(t, "ws-author-meta", map[string]string{
		"file.txt": "hello",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))

	// Set up author config
	configDir := filepath.Join(root, "config")
	setenv(t, "XDG_CONFIG_HOME", configDir)
	if err := config.SaveGlobalAuthor(&config.Author{
		Name:  "Test User",
		Email: "test@example.com",
	}); err != nil {
		t.Fatalf("SaveGlobalAuthor: %v", err)
	}

	baseID := createBaseSnapshot(t, root)
	meta := readFullSnapshotMeta(t, root, baseID)

	if meta.AuthorName != "Test User" {
		t.Fatalf("expected author_name 'Test User', got %q", meta.AuthorName)
	}
	if meta.AuthorEmail != "test@example.com" {
		t.Fatalf("expected author_email 'test@example.com', got %q", meta.AuthorEmail)
	}
}

func TestSnapshotIntegrityVerification(t *testing.T) {
	root := setupWorkspace(t, "ws-integrity", map[string]string{
		"file.txt": "content",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)

	// Verify reading works normally
	hash, err := config.ManifestHashFromSnapshotIDAt(root, baseID)
	if err != nil {
		t.Fatalf("ManifestHashFromSnapshotIDAt: %v", err)
	}
	if hash == "" {
		t.Fatalf("expected non-empty manifest hash")
	}

	// Tamper with the metadata
	metaPath := snapshotMetaPath(root, baseID)
	data, err := os.ReadFile(metaPath)
	if err != nil {
		t.Fatalf("read meta: %v", err)
	}

	var meta map[string]interface{}
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("parse meta: %v", err)
	}

	// Tamper with parent_snapshot_ids
	meta["parent_snapshot_ids"] = []string{"fake-parent"}
	tampered, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(metaPath, tampered, 0644); err != nil {
		t.Fatalf("write tampered meta: %v", err)
	}

	// Reading should now fail integrity check
	_, err = config.ManifestHashFromSnapshotIDAt(root, baseID)
	if err == nil {
		t.Fatalf("expected integrity check to fail after tampering")
	}
	if !containsStr(err.Error(), "integrity check failed") {
		t.Fatalf("expected integrity error, got: %v", err)
	}
}

func TestSnapshotParentsIntegrityVerification(t *testing.T) {
	root := setupWorkspace(t, "ws-parents-integrity", map[string]string{
		"file.txt": "content",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)

	// Reading parents should work normally
	parents, err := config.SnapshotParentIDsAt(root, baseID)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt: %v", err)
	}
	if len(parents) != 0 {
		t.Fatalf("expected no parents for initial snapshot, got %v", parents)
	}

	// Tamper with manifest_hash
	metaPath := snapshotMetaPath(root, baseID)
	data, _ := os.ReadFile(metaPath)
	var meta map[string]interface{}
	json.Unmarshal(data, &meta)
	meta["manifest_hash"] = "tampered_hash"
	tampered, _ := json.MarshalIndent(meta, "", "  ")
	os.WriteFile(metaPath, tampered, 0644)

	// Reading parents should now fail integrity check
	_, err = config.SnapshotParentIDsAt(root, baseID)
	if err == nil {
		t.Fatalf("expected integrity check to fail after tampering manifest_hash")
	}
	if !containsStr(err.Error(), "integrity check failed") {
		t.Fatalf("expected integrity error, got: %v", err)
	}
}

func TestLegacySnapshotIDSkipsVerification(t *testing.T) {
	root := setupWorkspace(t, "ws-legacy", map[string]string{})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	// Create a snapshot with a legacy ID format (snap- prefix)
	snapshotsDir := filepath.Join(root, ".fst", "snapshots")
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	legacyID := "snap-abcdef1234567890"
	meta := map[string]interface{}{
		"id":                  legacyID,
		"manifest_hash":       "somehash",
		"parent_snapshot_ids": []string{},
		"created_at":          "2024-01-01T00:00:00Z",
	}
	data, _ := json.MarshalIndent(meta, "", "  ")
	if err := os.WriteFile(filepath.Join(snapshotsDir, legacyID+".meta.json"), data, 0644); err != nil {
		t.Fatalf("write meta: %v", err)
	}

	// Legacy ID should pass verification (skip check)
	hash, err := config.ManifestHashFromSnapshotIDAt(root, legacyID)
	if err != nil {
		t.Fatalf("expected legacy ID to pass: %v", err)
	}
	if hash != "somehash" {
		t.Fatalf("expected somehash, got %s", hash)
	}
}

func TestRewrittenSnapshotsAreContentAddressed(t *testing.T) {
	root := setupWorkspace(t, "ws-rewrite-ca", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)
	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	s1 := runSnapshotCmd(t, root, "s1")
	writeFile(t, filepath.Join(root, "file.txt"), "v3")
	s2 := runSnapshotCmd(t, root, "s2")

	// Squash s1..s2
	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"squash", s1 + ".." + s2, "--message", "squashed"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("squash failed: %v", err)
	}
	restoreCwd()

	cfg, _ := config.LoadAt(root)
	newHead := cfg.CurrentSnapshotID

	// The rewritten snapshot should be content-addressed
	if !config.IsContentAddressedSnapshotID(newHead) {
		t.Fatalf("expected rewritten snapshot to be content-addressed: %s", newHead)
	}

	// And should verify correctly
	meta := readFullSnapshotMeta(t, root, newHead)
	if !config.VerifySnapshotID(newHead, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
		t.Fatalf("rewritten snapshot ID doesn't verify: %s", newHead)
	}

	// Base snapshot should also be content-addressed
	if !config.IsContentAddressedSnapshotID(baseID) {
		t.Fatalf("expected base snapshot to be content-addressed: %s", baseID)
	}
}

func containsStr(s, sub string) bool {
	return len(s) >= len(sub) && searchStr(s, sub)
}

func searchStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
