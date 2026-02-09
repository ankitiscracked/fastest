package workspace

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

func TestRollbackRestoresFiles(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "original",
	})

	// Create snapshot
	r, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Modify file
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("modified"), 0644)

	result, err := ws.Rollback(RollbackOpts{
		SnapshotID: r.SnapshotID,
		Force:      true,
	})
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if result.Restored == 0 {
		t.Fatalf("expected at least 1 restored file")
	}

	// Verify content restored
	content, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(content) != "original" {
		t.Fatalf("expected 'original', got %q", string(content))
	}
}

func TestRollbackDryRun(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "original",
	})

	r, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Modify file
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("modified"), 0644)

	result, err := ws.Rollback(RollbackOpts{
		SnapshotID: r.SnapshotID,
		DryRun:     true,
	})
	if err != nil {
		t.Fatalf("Rollback dry-run: %v", err)
	}
	if result.Restored != 0 {
		t.Fatalf("dry-run should not restore, got %d", result.Restored)
	}

	// Verify file NOT restored
	content, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(content) != "modified" {
		t.Fatalf("dry-run should not modify files")
	}
}

func TestRollbackBlocksWithoutForce(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "original",
	})

	r, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Modify file
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("modified"), 0644)

	_, err = ws.Rollback(RollbackOpts{
		SnapshotID: r.SnapshotID,
		Force:      false,
	})
	if err == nil {
		t.Fatalf("expected error for local changes without --force")
	}
}

func TestRollbackDeletesExtraFiles(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "original",
	})

	r, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Add extra file
	os.WriteFile(filepath.Join(root, "extra.txt"), []byte("extra"), 0644)

	result, err := ws.Rollback(RollbackOpts{
		SnapshotID: r.SnapshotID,
		Force:      true,
	})
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if result.Deleted == 0 {
		t.Fatalf("expected extra file to be deleted")
	}

	// Verify extra file removed
	if _, err := os.Stat(filepath.Join(root, "extra.txt")); err == nil {
		t.Fatalf("extra.txt should have been deleted")
	}
}

func TestRollbackSpecificFiles(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"a.txt": "a-content",
		"b.txt": "b-content",
	})

	r, err := ws.Snapshot(SnapshotOpts{
		Message: "v1",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot: %v", err)
	}

	// Modify both files
	os.WriteFile(filepath.Join(root, "a.txt"), []byte("a-modified"), 0644)
	os.WriteFile(filepath.Join(root, "b.txt"), []byte("b-modified"), 0644)

	result, err := ws.Rollback(RollbackOpts{
		SnapshotID: r.SnapshotID,
		Files:      []string{"a.txt"},
		Force:      true,
	})
	if err != nil {
		t.Fatalf("Rollback: %v", err)
	}
	if result.Restored != 1 {
		t.Fatalf("expected 1 restored, got %d", result.Restored)
	}

	// a.txt restored, b.txt still modified
	contentA, _ := os.ReadFile(filepath.Join(root, "a.txt"))
	if string(contentA) != "a-content" {
		t.Fatalf("a.txt not restored")
	}
	contentB, _ := os.ReadFile(filepath.Join(root, "b.txt"))
	if string(contentB) != "b-modified" {
		t.Fatalf("b.txt should not be restored")
	}
}

func TestRollbackToBase(t *testing.T) {
	root, ws := setupTestWorkspace(t, map[string]string{
		"file.txt": "base-content",
	})

	// Create base snapshot
	r1, err := ws.Snapshot(SnapshotOpts{
		Message: "base",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot base: %v", err)
	}

	// Set as base
	ws.cfg.BaseSnapshotID = r1.SnapshotID
	ws.SaveConfig()

	// Modify and create another snapshot
	os.WriteFile(filepath.Join(root, "file.txt"), []byte("later"), 0644)
	_, err = ws.Snapshot(SnapshotOpts{
		Message: "later",
		Author:  &config.Author{Name: "T", Email: "t@t"},
	})
	if err != nil {
		t.Fatalf("Snapshot later: %v", err)
	}

	result, err := ws.Rollback(RollbackOpts{
		ToBase: true,
		Force:  true,
	})
	if err != nil {
		t.Fatalf("Rollback to base: %v", err)
	}
	if result.TargetSnapshotID != r1.SnapshotID {
		t.Fatalf("expected target %s, got %s", r1.SnapshotID, result.TargetSnapshotID)
	}

	content, _ := os.ReadFile(filepath.Join(root, "file.txt"))
	if string(content) != "base-content" {
		t.Fatalf("expected 'base-content', got %q", string(content))
	}
}
