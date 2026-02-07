package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

type snapshotMeta struct {
	Message           string   `json:"message"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
}

func TestEditSnapshotMessage(t *testing.T) {
	root := setupWorkspace(t, "ws-edit", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)
	_ = baseID

	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	snapID := runSnapshotCmd(t, root, "second")

	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"edit", snapID, "--message", "updated"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("edit failed: %v", err)
	}
	restoreCwd()

	meta := readSnapshotMeta(t, root, snapID)
	if meta.Message != "updated" {
		t.Fatalf("expected updated message, got %q", meta.Message)
	}
}

func TestDropSnapshotRewiresChild(t *testing.T) {
	root := setupWorkspace(t, "ws-drop", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)
	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	s1 := runSnapshotCmd(t, root, "s1")
	writeFile(t, filepath.Join(root, "file.txt"), "v3")
	s2 := runSnapshotCmd(t, root, "s2")
	writeFile(t, filepath.Join(root, "file.txt"), "v4")
	s3 := runSnapshotCmd(t, root, "s3")

	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"drop", s2})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("drop failed: %v", err)
	}
	restoreCwd()

	// Old snapshots are preserved (immutable) — s2 still exists
	if _, err := os.Stat(snapshotMetaPath(root, s2)); err != nil {
		t.Fatalf("expected old snapshot %s to be preserved, got err: %v", s2, err)
	}

	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	// HEAD should have moved to a NEW snapshot (not s3)
	newHead := cfg.CurrentSnapshotID
	if newHead == s3 {
		t.Fatalf("expected HEAD to move to a new snapshot, but it stayed at %s", s3)
	}

	// The new HEAD's parent should be s1 (s2 was skipped)
	parents, err := config.SnapshotParentIDsAt(root, newHead)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt: %v", err)
	}
	// newHead is a copy of s3, and its parent should be a copy of s3's predecessor (which was dropped).
	// Since s2 was dropped, s3's copy should have parent = s1.
	if len(parents) != 1 || parents[0] != s1 {
		t.Fatalf("expected new HEAD parent to be %s, got %v", s1, parents)
	}

	if cfg.BaseSnapshotID != baseID {
		t.Fatalf("expected base snapshot %s, got %s", baseID, cfg.BaseSnapshotID)
	}
}

func TestSquashRangeCollapsesSnapshots(t *testing.T) {
	root := setupWorkspace(t, "ws-squash", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)
	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	s1 := runSnapshotCmd(t, root, "s1")
	writeFile(t, filepath.Join(root, "file.txt"), "v3")
	s2 := runSnapshotCmd(t, root, "s2")

	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"squash", s1 + ".." + s2, "--message", "squashed"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("squash failed: %v", err)
	}
	restoreCwd()

	// Old snapshots are preserved (immutable)
	if _, err := os.Stat(snapshotMetaPath(root, s1)); err != nil {
		t.Fatalf("expected s1 metadata to be preserved, got err: %v", err)
	}

	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	// HEAD should have moved to a new snapshot (not s2)
	newHead := cfg.CurrentSnapshotID
	if newHead == s2 {
		t.Fatalf("expected HEAD to move to a new snapshot, but it stayed at %s", s2)
	}

	// The new HEAD's parent should be baseID (s1 was squashed away)
	parents, err := config.SnapshotParentIDsAt(root, newHead)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt: %v", err)
	}
	if len(parents) != 1 || parents[0] != baseID {
		t.Fatalf("expected new HEAD parent to be %s, got %v", baseID, parents)
	}

	meta := readSnapshotMeta(t, root, newHead)
	if meta.Message != "squashed" {
		t.Fatalf("expected squashed message, got %q", meta.Message)
	}
}

func TestRebaseSkipsSegmentInChain(t *testing.T) {
	root := setupWorkspace(t, "ws-rebase", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	_ = createBaseSnapshot(t, root)
	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	s1 := runSnapshotCmd(t, root, "s1")
	writeFile(t, filepath.Join(root, "file.txt"), "v3")
	_ = runSnapshotCmd(t, root, "s2")
	writeFile(t, filepath.Join(root, "file.txt"), "v4")
	s3 := runSnapshotCmd(t, root, "s3")
	writeFile(t, filepath.Join(root, "file.txt"), "v5")
	s4 := runSnapshotCmd(t, root, "s4")

	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"rebase", s3 + ".." + s4, "--onto", s1})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("rebase failed: %v", err)
	}
	restoreCwd()

	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	// HEAD should have moved to a new snapshot (not s4)
	newHead := cfg.CurrentSnapshotID
	if newHead == s4 {
		t.Fatalf("expected HEAD to move to a new snapshot, but it stayed at %s", s4)
	}

	// The new HEAD's parent should be a new copy of s3
	newHeadParents, err := config.SnapshotParentIDsAt(root, newHead)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt for new HEAD: %v", err)
	}
	if len(newHeadParents) != 1 {
		t.Fatalf("expected new HEAD to have 1 parent, got %v", newHeadParents)
	}

	// The new s3 copy's parent should be s1 (the --onto target)
	newS3 := newHeadParents[0]
	newS3Parents, err := config.SnapshotParentIDsAt(root, newS3)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt for new s3: %v", err)
	}
	if len(newS3Parents) != 1 || newS3Parents[0] != s1 {
		t.Fatalf("expected new s3 parent to be %s, got %v", s1, newS3Parents)
	}

	// Old s3 and s4 should still exist with original parents (immutable)
	if _, err := os.Stat(snapshotMetaPath(root, s3)); err != nil {
		t.Fatalf("expected old s3 to be preserved: %v", err)
	}
	if _, err := os.Stat(snapshotMetaPath(root, s4)); err != nil {
		t.Fatalf("expected old s4 to be preserved: %v", err)
	}
}

func TestRebaseRejectsNonAncestor(t *testing.T) {
	root := setupWorkspace(t, "ws-rebase-fork", map[string]string{
		"file.txt": "v1",
	})
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	baseID := createBaseSnapshot(t, root)
	writeFile(t, filepath.Join(root, "file.txt"), "v2")
	_ = runSnapshotCmd(t, root, "s1")
	writeFile(t, filepath.Join(root, "file.txt"), "v3")
	s2 := runSnapshotCmd(t, root, "s2")
	writeFile(t, filepath.Join(root, "file.txt"), "v4")
	s3 := runSnapshotCmd(t, root, "s3")

	// Create a fork snapshot off the base
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	cfg.CurrentSnapshotID = baseID
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	writeFile(t, filepath.Join(root, "file.txt"), "fork")
	forkID := runSnapshotCmd(t, root, "fork")

	// Restore current snapshot to the original head
	cfg, err = config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	cfg.CurrentSnapshotID = s3
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"rebase", s2 + ".." + s3, "--onto", forkID})
	err = cmd.Execute()
	restoreCwd()
	if err == nil {
		t.Fatalf("expected rebase to fail for non-ancestor onto")
	}
	if !strings.Contains(err.Error(), "not an ancestor") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func createBaseSnapshot(t *testing.T, root string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	id, err := createInitialSnapshot(root, cfg.WorkspaceID, cfg.WorkspaceName, false)
	if err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}
	return id
}

func runSnapshotCmd(t *testing.T, root, message string) string {
	t.Helper()
	restoreCwd := chdir(t, root)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", message})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}
	restoreCwd()

	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	return cfg.CurrentSnapshotID
}

func readSnapshotMeta(t *testing.T, root, snapshotID string) snapshotMeta {
	t.Helper()
	data, err := os.ReadFile(snapshotMetaPath(root, snapshotID))
	if err != nil {
		t.Fatalf("read snapshot meta: %v", err)
	}
	var meta snapshotMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		t.Fatalf("parse snapshot meta: %v", err)
	}
	return meta
}

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
}
