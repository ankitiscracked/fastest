package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestSaveLoadAt(t *testing.T) {
	root := t.TempDir()
	cfg := &WorkspaceConfig{
		ProjectID:         "proj-1",
		WorkspaceID:       "ws-1",
		WorkspaceName:     "main",
		CurrentSnapshotID: "snap-1",
		Mode:              "local",
	}

	if err := SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	loaded, err := LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	if loaded.ProjectID != cfg.ProjectID || loaded.WorkspaceID != cfg.WorkspaceID || loaded.WorkspaceName != cfg.WorkspaceName {
		t.Fatalf("loaded config mismatch: %#v", loaded)
	}
	if loaded.CurrentSnapshotID != cfg.CurrentSnapshotID {
		t.Fatalf("current snapshot mismatch: %s", loaded.CurrentSnapshotID)
	}
}

func TestInitAtCreatesStructure(t *testing.T) {
	root := t.TempDir()
	if err := InitAt(root, "proj-2", "ws-2", "dev", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}

	if _, err := os.Stat(filepath.Join(root, ConfigDirName)); err != nil {
		t.Fatalf("config dir missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ConfigDirName, SnapshotsDirName)); err != nil {
		t.Fatalf("snapshots dir missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, ConfigDirName, ManifestsDirName)); err != nil {
		t.Fatalf("manifests dir missing: %v", err)
	}

	loaded, err := LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if loaded.ProjectID != "proj-2" || loaded.WorkspaceID != "ws-2" || loaded.Mode != "local" {
		t.Fatalf("loaded config mismatch: %#v", loaded)
	}
}

func TestFindWorkspaceRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ConfigDirName), 0755); err != nil {
		t.Fatalf("mkdir .fst: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigDirName, ConfigFileName), []byte(`{"type":"workspace"}`), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	nested := filepath.Join(root, "a", "b", "c")
	if err := os.MkdirAll(nested, 0755); err != nil {
		t.Fatalf("mkdir nested: %v", err)
	}

	cwd, _ := os.Getwd()
	defer func() {
		_ = os.Chdir(cwd)
	}()
	if err := os.Chdir(nested); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	found, err := FindWorkspaceRoot()
	if err != nil {
		t.Fatalf("FindWorkspaceRoot: %v", err)
	}
	foundEval, err := filepath.EvalSymlinks(found)
	if err != nil {
		t.Fatalf("EvalSymlinks(found): %v", err)
	}
	rootEval, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatalf("EvalSymlinks(root): %v", err)
	}
	if foundEval != rootEval {
		t.Fatalf("expected root %s, got %s", rootEval, foundEval)
	}
}

func TestManifestHashFromSnapshotIDAt(t *testing.T) {
	root := t.TempDir()
	snapshotsDir := GetSnapshotsDirAt(root)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}

	meta := SnapshotMeta{
		ID:           "snap-123",
		CreatedAt:    time.Now().UTC().Format(time.RFC3339),
		ManifestHash: "abc123",
	}
	data, _ := json.Marshal(meta)
	if err := os.WriteFile(filepath.Join(snapshotsDir, "snap-123.meta.json"), data, 0644); err != nil {
		t.Fatalf("write meta: %v", err)
	}

	hash, err := ManifestHashFromSnapshotIDAt(root, "snap-123")
	if err != nil {
		t.Fatalf("ManifestHashFromSnapshotIDAt: %v", err)
	}
	if hash != "abc123" {
		t.Fatalf("manifest hash mismatch: %s", hash)
	}

	legacy := "snap-" + strings.Repeat("a", 64)
	hash, err = ManifestHashFromSnapshotIDAt(root, legacy)
	if err != nil {
		t.Fatalf("legacy ManifestHashFromSnapshotIDAt: %v", err)
	}
	if hash != strings.Repeat("a", 64) {
		t.Fatalf("legacy manifest hash mismatch: %s", hash)
	}
}

func TestGetLatestSnapshotIDAt(t *testing.T) {
	root := t.TempDir()
	snapshotsDir := GetSnapshotsDirAt(root)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}

	meta1 := SnapshotMeta{ID: "snap-1", CreatedAt: "2024-01-01T00:00:00Z"}
	meta2 := SnapshotMeta{ID: "snap-2", CreatedAt: "2025-01-01T00:00:00Z"}

	data1, _ := json.Marshal(meta1)
	data2, _ := json.Marshal(meta2)

	if err := os.WriteFile(filepath.Join(snapshotsDir, "snap-1.meta.json"), data1, 0644); err != nil {
		t.Fatalf("write meta1: %v", err)
	}
	if err := os.WriteFile(filepath.Join(snapshotsDir, "snap-2.meta.json"), data2, 0644); err != nil {
		t.Fatalf("write meta2: %v", err)
	}

	latest, err := GetLatestSnapshotIDAt(root)
	if err != nil {
		t.Fatalf("GetLatestSnapshotIDAt: %v", err)
	}
	if latest != "snap-2" {
		t.Fatalf("latest mismatch: %s", latest)
	}
}
