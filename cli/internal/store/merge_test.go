package store

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/manifest"
)

// seedSnapshot creates a manifest with the given files, writes it and its blobs
// to the store, and writes snapshot metadata. Returns the snapshot ID.
func seedSnapshot(t *testing.T, s *Store, id string, parentIDs []string, files map[string]string) string {
	t.Helper()

	// Build manifest entries and write blobs
	var entries []manifest.FileEntry
	for path, content := range files {
		hash := sha256Hex([]byte(content))
		if err := s.WriteBlob(hash, []byte(content)); err != nil {
			t.Fatalf("WriteBlob %s: %v", path, err)
		}
		entries = append(entries, manifest.FileEntry{
			Type: "file",
			Path: path,
			Hash: hash,
			Size: int64(len(content)),
			Mode: 0644,
		})
	}

	m := &manifest.Manifest{
		Version: "1",
		Files:   entries,
	}

	manifestHash, err := s.WriteManifest(m)
	if err != nil {
		t.Fatalf("WriteManifest: %v", err)
	}

	meta := &SnapshotMeta{
		ID:                id,
		ManifestHash:      manifestHash,
		ParentSnapshotIDs: parentIDs,
		CreatedAt:         "2025-01-01T00:00:00Z",
	}
	if err := s.WriteSnapshotMeta(meta); err != nil {
		t.Fatalf("WriteSnapshotMeta: %v", err)
	}

	return id
}

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestPlanMerge_NoConflicts(t *testing.T) {
	s, _ := setupStore(t)

	// base: file-a.txt
	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file-a.txt": "hello",
	})

	// current: file-a unchanged, file-b added
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file-a.txt": "hello",
		"file-b.txt": "current-only",
	})

	// source: file-a unchanged, file-c added
	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"file-a.txt": "hello",
		"file-c.txt": "source-only",
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	if len(plan.ToApply) != 1 {
		t.Fatalf("expected 1 toApply, got %d", len(plan.ToApply))
	}
	if plan.ToApply[0].Path != "file-c.txt" {
		t.Fatalf("expected file-c.txt, got %s", plan.ToApply[0].Path)
	}
	if len(plan.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(plan.Conflicts))
	}
	if plan.MergeBaseID != base {
		t.Fatalf("expected merge base %s, got %s", base, plan.MergeBaseID)
	}
}

func TestPlanMerge_WithConflicts(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"shared.txt": "original",
	})

	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"shared.txt": "current-version",
	})

	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"shared.txt": "source-version",
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	if len(plan.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(plan.Conflicts))
	}
	if plan.Conflicts[0].Path != "shared.txt" {
		t.Fatalf("expected shared.txt, got %s", plan.Conflicts[0].Path)
	}
	if len(plan.ToApply) != 0 {
		t.Fatalf("expected 0 toApply, got %d", len(plan.ToApply))
	}
}

func TestPlanMerge_InSync(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "same",
	})

	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": "same",
	})

	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"file.txt": "same",
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	if len(plan.ToApply) != 0 {
		t.Fatalf("expected 0 toApply, got %d", len(plan.ToApply))
	}
	if len(plan.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(plan.Conflicts))
	}
	if plan.InSync < 1 {
		t.Fatalf("expected at least 1 inSync, got %d", plan.InSync)
	}
}

func TestPlanMerge_ForceNoBase(t *testing.T) {
	s, _ := setupStore(t)

	// Two unrelated snapshots (no shared ancestor)
	current := seedSnapshot(t, s, "snap-a", nil, map[string]string{
		"a.txt": "aaa",
	})

	source := seedSnapshot(t, s, "snap-b", nil, map[string]string{
		"b.txt": "bbb",
	})

	// Without force, should fail
	_, err := s.PlanMerge(current, source, false)
	if err == nil {
		t.Fatalf("expected error without force")
	}

	// With force, should succeed (two-way merge, all source files are additions)
	plan, err := s.PlanMerge(current, source, true)
	if err != nil {
		t.Fatalf("PlanMerge with force: %v", err)
	}

	if len(plan.ToApply) != 1 {
		t.Fatalf("expected 1 toApply, got %d", len(plan.ToApply))
	}
	if plan.ToApply[0].Path != "b.txt" {
		t.Fatalf("expected b.txt, got %s", plan.ToApply[0].Path)
	}
	if plan.MergeBaseID != "" {
		t.Fatalf("expected empty merge base, got %s", plan.MergeBaseID)
	}
}

func TestPlanMerge_OnlySourceChanged(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "original",
	})

	// Current unchanged
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": "original",
	})

	// Source modified
	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"file.txt": "modified",
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	if len(plan.ToApply) != 1 {
		t.Fatalf("expected 1 toApply, got %d", len(plan.ToApply))
	}
	if plan.ToApply[0].Path != "file.txt" {
		t.Fatalf("expected file.txt, got %s", plan.ToApply[0].Path)
	}
	if len(plan.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(plan.Conflicts))
	}
}

func TestPlanMerge_AutoMerge(t *testing.T) {
	s, _ := setupStore(t)

	// Base: multi-line file
	baseContent := "line1\nline2\nline3\nline4\nline5\n"
	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": baseContent,
	})

	// Current: change line 1 only
	currentContent := "CURRENT-LINE1\nline2\nline3\nline4\nline5\n"
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": currentContent,
	})

	// Source: change line 5 only (non-overlapping)
	sourceContent := "line1\nline2\nline3\nline4\nSOURCE-LINE5\n"
	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"file.txt": sourceContent,
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	// Non-overlapping changes should be auto-merged
	if len(plan.AutoMerged) != 1 {
		t.Fatalf("expected 1 auto-merged, got %d (conflicts: %d, toApply: %d)", len(plan.AutoMerged), len(plan.Conflicts), len(plan.ToApply))
	}
	if plan.AutoMerged[0].Path != "file.txt" {
		t.Fatalf("expected file.txt, got %s", plan.AutoMerged[0].Path)
	}

	merged := string(plan.AutoMerged[0].MergedContent)
	if !strings.Contains(merged, "CURRENT-LINE1") {
		t.Fatalf("merged content should contain CURRENT-LINE1, got %q", merged)
	}
	if !strings.Contains(merged, "SOURCE-LINE5") {
		t.Fatalf("merged content should contain SOURCE-LINE5, got %q", merged)
	}

	if len(plan.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(plan.Conflicts))
	}
}

func TestPlanMerge_OnlyCurrentChanged(t *testing.T) {
	s, _ := setupStore(t)

	base := seedSnapshot(t, s, "snap-base", nil, map[string]string{
		"file.txt": "original",
	})

	// Current modified
	current := seedSnapshot(t, s, "snap-current", []string{base}, map[string]string{
		"file.txt": "modified-by-current",
	})

	// Source unchanged
	source := seedSnapshot(t, s, "snap-source", []string{base}, map[string]string{
		"file.txt": "original",
	})

	plan, err := s.PlanMerge(current, source, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	// Only current changed → keep ours → in sync
	if len(plan.ToApply) != 0 {
		t.Fatalf("expected 0 toApply, got %d", len(plan.ToApply))
	}
	if len(plan.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %d", len(plan.Conflicts))
	}
	if plan.InSync < 1 {
		t.Fatalf("expected at least 1 inSync, got %d", plan.InSync)
	}
}
