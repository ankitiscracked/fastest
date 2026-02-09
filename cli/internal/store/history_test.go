package store

import (
	"testing"
)

func TestBuildWorkspaceChain(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})

	chain, err := s.BuildWorkspaceChain(c, a)
	if err != nil {
		t.Fatalf("BuildWorkspaceChain: %v", err)
	}
	if len(chain) != 3 {
		t.Fatalf("expected chain of 3, got %d: %v", len(chain), chain)
	}
	if chain[0] != a || chain[1] != b || chain[2] != c {
		t.Fatalf("unexpected chain order: %v", chain)
	}
}

func TestBuildWorkspaceChain_StopsAtStop(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})

	chain, err := s.BuildWorkspaceChain(c, b)
	if err != nil {
		t.Fatalf("BuildWorkspaceChain: %v", err)
	}
	if len(chain) != 2 {
		t.Fatalf("expected chain of 2, got %d: %v", len(chain), chain)
	}
	if chain[0] != b || chain[1] != c {
		t.Fatalf("unexpected chain: %v", chain)
	}
}

func TestIsAncestorOf(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})
	d := seedSnapshot(t, s, "snap-d", nil, map[string]string{"d.txt": "d"})

	if !s.IsAncestorOf(a, c) {
		t.Fatalf("expected a to be ancestor of c")
	}
	if !s.IsAncestorOf(b, c) {
		t.Fatalf("expected b to be ancestor of c")
	}
	if s.IsAncestorOf(c, a) {
		t.Fatalf("c should not be ancestor of a")
	}
	if s.IsAncestorOf(d, c) {
		t.Fatalf("d should not be ancestor of c")
	}
	if !s.IsAncestorOf(a, a) {
		t.Fatalf("a should be ancestor of itself")
	}
}

func TestIsDescendantOf(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})
	d := seedSnapshot(t, s, "snap-d", nil, map[string]string{"d.txt": "d"})

	if !s.IsDescendantOf(c, []string{a}) {
		t.Fatalf("expected c to be descendant of a")
	}
	if s.IsDescendantOf(d, []string{a, b, c}) {
		t.Fatalf("d should not be descendant of a,b,c")
	}
}

func TestRewriteChain(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})
	c := seedSnapshot(t, s, "snap-c", []string{b}, map[string]string{"c.txt": "c"})
	newBase := seedSnapshot(t, s, "snap-newbase", nil, map[string]string{"base.txt": "base"})

	result, err := s.RewriteChain([]string{b, c}, newBase, nil)
	if err != nil {
		t.Fatalf("RewriteChain: %v", err)
	}

	if len(result.IDMap) != 2 {
		t.Fatalf("expected 2 ID mappings, got %d", len(result.IDMap))
	}
	newB := result.IDMap[b]
	newC := result.IDMap[c]
	if newB == b {
		t.Fatalf("expected new ID for b, got same")
	}
	if newC == c {
		t.Fatalf("expected new ID for c, got same")
	}
	if result.NewHeadID != newC {
		t.Fatalf("expected NewHeadID=%s, got %s", newC, result.NewHeadID)
	}

	// Verify new b's parent is newBase
	newBMeta, err := s.LoadSnapshotMeta(newB)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta(%s): %v", newB, err)
	}
	if len(newBMeta.ParentSnapshotIDs) != 1 || newBMeta.ParentSnapshotIDs[0] != newBase {
		t.Fatalf("expected new b's parent to be newBase, got %v", newBMeta.ParentSnapshotIDs)
	}

	// Verify new c's parent is new b
	newCMeta, err := s.LoadSnapshotMeta(newC)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta(%s): %v", newC, err)
	}
	if len(newCMeta.ParentSnapshotIDs) != 1 || newCMeta.ParentSnapshotIDs[0] != newB {
		t.Fatalf("expected new c's parent to be new b, got %v", newCMeta.ParentSnapshotIDs)
	}
}

func TestRewriteChain_WithMessageOverrides(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})
	b := seedSnapshot(t, s, "snap-b", []string{a}, map[string]string{"b.txt": "b"})

	result, err := s.RewriteChain([]string{b}, a, map[string]string{b: "new message"})
	if err != nil {
		t.Fatalf("RewriteChain: %v", err)
	}

	newB := result.IDMap[b]
	meta, err := s.LoadSnapshotMeta(newB)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta(%s): %v", newB, err)
	}
	if meta.Message != "new message" {
		t.Fatalf("expected message 'new message', got %q", meta.Message)
	}
}

func TestEditSnapshotMessage(t *testing.T) {
	s, _ := setupStore(t)

	a := seedSnapshot(t, s, "snap-a", nil, map[string]string{"a.txt": "a"})

	if err := s.EditSnapshotMessage(a, "updated message"); err != nil {
		t.Fatalf("EditSnapshotMessage: %v", err)
	}

	meta, err := s.LoadSnapshotMeta(a)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	if meta.Message != "updated message" {
		t.Fatalf("expected 'updated message', got %q", meta.Message)
	}
}
