package workspace

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

// setupMergeTest creates a workspace with divergent snapshots for merge testing.
// Returns the current workspace and the source snapshot ID.
func setupMergeTest(t *testing.T, baseFiles, currentChanges, sourceChanges map[string]string) (*Workspace, string) {
	t.Helper()

	root, ws := setupTestWorkspace(t, baseFiles)
	author := &config.Author{Name: "Test", Email: "t@t"}

	// Base snapshot (shared ancestor)
	baseResult, err := ws.Snapshot(SnapshotOpts{
		Message: "base",
		Author:  author,
	})
	if err != nil {
		t.Fatalf("base snapshot: %v", err)
	}

	// Apply current changes and snapshot
	for path, content := range currentChanges {
		full := filepath.Join(root, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}

	if _, err := ws.Snapshot(SnapshotOpts{
		Message: "current changes",
		Author:  author,
	}); err != nil {
		t.Fatalf("current snapshot: %v", err)
	}

	// Build source snapshot in the same store
	sourceFiles := make(map[string]string)
	for k, v := range baseFiles {
		sourceFiles[k] = v
	}
	for k, v := range sourceChanges {
		sourceFiles[k] = v
	}

	sourceSnapshotID := seedSourceSnapshot(t, ws.store, []string{baseResult.SnapshotID}, sourceFiles)
	return ws, sourceSnapshotID
}

func seedSourceSnapshot(t *testing.T, s *store.Store, parentIDs []string, files map[string]string) string {
	t.Helper()

	// Write blobs
	type entry struct {
		path string
		hash string
		size int64
	}
	var entries []entry
	for path, content := range files {
		h := sha256Hex([]byte(content))
		s.WriteBlob(h, []byte(content))
		entries = append(entries, entry{path, h, int64(len(content))})
	}

	// Build manifest JSON
	var b strings.Builder
	b.WriteString(`{"version":"1","files":[`)
	for i, e := range entries {
		if i > 0 {
			b.WriteString(",")
		}
		fmt.Fprintf(&b, `{"type":"file","path":%q,"hash":"%s","size":%d,"mode":420}`, e.path, e.hash, e.size)
	}
	b.WriteString(`],"symlinks":[]}`)
	manifestJSON := []byte(b.String())

	manifestHash := sha256Hex(manifestJSON)

	// Write manifest
	manifestDir := filepath.Join(s.Root(), ".fst", "manifests")
	os.MkdirAll(manifestDir, 0755)
	os.WriteFile(filepath.Join(manifestDir, manifestHash+".json"), manifestJSON, 0644)

	// Write snapshot metadata
	id := "snap-source-" + manifestHash[:8]
	meta := &store.SnapshotMeta{
		ID:                id,
		ManifestHash:      manifestHash,
		ParentSnapshotIDs: parentIDs,
		CreatedAt:         "2025-01-02T00:00:00Z",
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

func TestApplyMerge_Apply(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"base.txt": "base"},       // base
		map[string]string{},                          // current: no changes
		map[string]string{"new.txt": "from-source"},  // source: adds file
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeManual,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	if len(result.Applied) != 1 || result.Applied[0] != "new.txt" {
		t.Fatalf("expected [new.txt] applied, got %v", result.Applied)
	}

	// Verify file on disk
	content, err := os.ReadFile(filepath.Join(ws.Root(), "new.txt"))
	if err != nil {
		t.Fatalf("read new.txt: %v", err)
	}
	if string(content) != "from-source" {
		t.Fatalf("expected 'from-source', got %q", string(content))
	}
}

func TestApplyMerge_ConflictTheirs(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"shared.txt": "original"},
		map[string]string{"shared.txt": "current-version"},
		map[string]string{"shared.txt": "source-version"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeTheirs,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	if len(result.Applied) != 1 {
		t.Fatalf("expected 1 applied, got %d", len(result.Applied))
	}

	content, err := os.ReadFile(filepath.Join(ws.Root(), "shared.txt"))
	if err != nil {
		t.Fatalf("read shared.txt: %v", err)
	}
	if string(content) != "source-version" {
		t.Fatalf("expected source-version, got %q", string(content))
	}
}

func TestApplyMerge_ConflictOurs(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"shared.txt": "original"},
		map[string]string{"shared.txt": "current-version"},
		map[string]string{"shared.txt": "source-version"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeOurs,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	if len(result.Applied) != 1 {
		t.Fatalf("expected 1 applied, got %d", len(result.Applied))
	}

	content, err := os.ReadFile(filepath.Join(ws.Root(), "shared.txt"))
	if err != nil {
		t.Fatalf("read shared.txt: %v", err)
	}
	if string(content) != "current-version" {
		t.Fatalf("expected current-version, got %q", string(content))
	}
}

func TestApplyMerge_ConflictManual(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"shared.txt": "original"},
		map[string]string{"shared.txt": "current-version"},
		map[string]string{"shared.txt": "source-version"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeManual,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	if len(result.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict, got %d", len(result.Conflicts))
	}

	content, err := os.ReadFile(filepath.Join(ws.Root(), "shared.txt"))
	if err != nil {
		t.Fatalf("read shared.txt: %v", err)
	}
	if !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("expected conflict markers, got %q", string(content))
	}
	if !strings.Contains(string(content), "current-version") {
		t.Fatalf("expected current-version in markers")
	}
	if !strings.Contains(string(content), "source-version") {
		t.Fatalf("expected source-version in markers")
	}
}

func TestApplyMerge_Resolver(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"shared.txt": "original"},
		map[string]string{"shared.txt": "current"},
		map[string]string{"shared.txt": "source"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	// Custom resolver concatenates both versions
	resolver := func(path string, current, source, base []byte) ([]byte, error) {
		return []byte(string(current) + "+" + string(source)), nil
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan:     plan,
		Mode:     ConflictModeManual,
		Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	if len(result.Applied) != 1 {
		t.Fatalf("expected 1 applied, got %d (conflicts: %d)", len(result.Applied), len(result.Conflicts))
	}

	content, err := os.ReadFile(filepath.Join(ws.Root(), "shared.txt"))
	if err != nil {
		t.Fatalf("read shared.txt: %v", err)
	}
	if string(content) != "current+source" {
		t.Fatalf("expected 'current+source', got %q", string(content))
	}
}

func TestApplyMerge_ResolverFallback(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"shared.txt": "original"},
		map[string]string{"shared.txt": "current"},
		map[string]string{"shared.txt": "source"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	// Resolver that always fails
	resolver := func(path string, current, source, base []byte) ([]byte, error) {
		return nil, fmt.Errorf("resolver failed")
	}

	result, err := ws.ApplyMerge(ApplyMergeOpts{
		Plan:     plan,
		Mode:     ConflictModeManual,
		Resolver: resolver,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	// Should fall back to manual markers
	if len(result.Conflicts) != 1 {
		t.Fatalf("expected 1 conflict (fallback to markers), got %d", len(result.Conflicts))
	}
}

func TestApplyMerge_DirtyOverlapAborts(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"file.txt": "original"},
		map[string]string{},                            // current: no snapshot changes
		map[string]string{"file.txt": "source-change"}, // source: modifies file
	)

	// Make working tree dirty on the same file
	os.WriteFile(filepath.Join(ws.Root(), "file.txt"), []byte("dirty-local"), 0644)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	_, err = ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeTheirs,
	})
	if err == nil {
		t.Fatalf("expected error for dirty overlap")
	}
	if !strings.Contains(err.Error(), "overwrite local changes") {
		t.Fatalf("expected 'overwrite local changes' error, got: %v", err)
	}
}

func TestApplyMerge_RecordsMergeParents(t *testing.T) {
	ws, sourceID := setupMergeTest(t,
		map[string]string{"base.txt": "base"},
		map[string]string{},
		map[string]string{"new.txt": "source"},
	)

	plan, err := ws.store.PlanMerge(ws.CurrentSnapshotID(), sourceID, false)
	if err != nil {
		t.Fatalf("PlanMerge: %v", err)
	}

	_, err = ws.ApplyMerge(ApplyMergeOpts{
		Plan: plan,
		Mode: ConflictModeManual,
	})
	if err != nil {
		t.Fatalf("ApplyMerge: %v", err)
	}

	// Verify merge parents file was written
	parents, err := config.ReadPendingMergeParentsAt(ws.Root())
	if err != nil {
		t.Fatalf("ReadPendingMergeParents: %v", err)
	}
	if len(parents) != 2 {
		t.Fatalf("expected 2 merge parents, got %d", len(parents))
	}
	if parents[0] != ws.CurrentSnapshotID() {
		t.Fatalf("expected current snapshot as first parent")
	}
	if parents[1] != sourceID {
		t.Fatalf("expected source snapshot as second parent")
	}
}

func TestMergeAbort(t *testing.T) {
	_, ws := setupTestWorkspace(t, nil)

	// Write some merge parents
	config.WritePendingMergeParentsAt(ws.Root(), []string{"snap-a", "snap-b"})

	// Verify they exist
	parents, _ := config.ReadPendingMergeParentsAt(ws.Root())
	if len(parents) == 0 {
		t.Fatalf("expected merge parents to exist before abort")
	}

	// Abort
	if err := ws.MergeAbort(); err != nil {
		t.Fatalf("MergeAbort: %v", err)
	}

	// Verify cleaned up
	parents, _ = config.ReadPendingMergeParentsAt(ws.Root())
	if len(parents) != 0 {
		t.Fatalf("expected empty merge parents after abort, got %v", parents)
	}
}
