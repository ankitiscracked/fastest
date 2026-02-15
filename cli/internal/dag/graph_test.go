package dag

import (
	"strings"
	"testing"
)

// buildSnaps is a test helper that creates a SnapshotInfo map.
func buildSnaps(entries ...SnapshotInfo) map[string]*SnapshotInfo {
	m := make(map[string]*SnapshotInfo, len(entries))
	for i := range entries {
		m[entries[i].ID] = &entries[i]
	}
	return m
}

func TestTopoSortLinear(t *testing.T) {
	snaps := buildSnaps(
		SnapshotInfo{ID: "A", ParentIDs: []string{"B"}, CreatedAt: "2025-01-03T00:00:00Z"},
		SnapshotInfo{ID: "B", ParentIDs: []string{"C"}, CreatedAt: "2025-01-02T00:00:00Z"},
		SnapshotInfo{ID: "C", ParentIDs: nil, CreatedAt: "2025-01-01T00:00:00Z"},
	)

	result := TopoSort([]string{"A"}, snaps)
	if len(result) != 3 {
		t.Fatalf("expected 3 snapshots, got %d", len(result))
	}

	ids := make([]string, len(result))
	for i, s := range result {
		ids[i] = s.ID
	}
	expected := "A,B,C"
	got := strings.Join(ids, ",")
	if got != expected {
		t.Errorf("expected order %s, got %s", expected, got)
	}
}

func TestTopoSortMerge(t *testing.T) {
	// M merges A and B; both A and B have parent C
	snaps := buildSnaps(
		SnapshotInfo{ID: "M", ParentIDs: []string{"A", "B"}, CreatedAt: "2025-01-04T00:00:00Z"},
		SnapshotInfo{ID: "A", ParentIDs: []string{"C"}, CreatedAt: "2025-01-03T00:00:00Z"},
		SnapshotInfo{ID: "B", ParentIDs: []string{"C"}, CreatedAt: "2025-01-02T00:00:00Z"},
		SnapshotInfo{ID: "C", ParentIDs: nil, CreatedAt: "2025-01-01T00:00:00Z"},
	)

	result := TopoSort([]string{"M"}, snaps)
	if len(result) != 4 {
		t.Fatalf("expected 4 snapshots, got %d", len(result))
	}

	// M must be first, C must be last
	if result[0].ID != "M" {
		t.Errorf("expected M first, got %s", result[0].ID)
	}
	if result[len(result)-1].ID != "C" {
		t.Errorf("expected C last, got %s", result[len(result)-1].ID)
	}

	// A must come before C, B must come before C
	idxA, idxB, idxC := -1, -1, -1
	for i, s := range result {
		switch s.ID {
		case "A":
			idxA = i
		case "B":
			idxB = i
		case "C":
			idxC = i
		}
	}
	if idxA > idxC {
		t.Errorf("A (idx %d) should come before C (idx %d)", idxA, idxC)
	}
	if idxB > idxC {
		t.Errorf("B (idx %d) should come before C (idx %d)", idxB, idxC)
	}
}

func TestGraphRendererLinearASCII(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	r := NewGraphRenderer()

	row1 := r.NextRow("A", []string{"B"})
	row2 := r.NextRow("B", []string{"C"})
	row3 := r.NextRow("C", nil)

	// Linear chain: each node line should just be "*"
	if !strings.Contains(row1.NodeLine, "*") {
		t.Errorf("row1 node line missing *: %q", row1.NodeLine)
	}
	if !strings.Contains(row2.NodeLine, "*") {
		t.Errorf("row2 node line missing *: %q", row2.NodeLine)
	}
	if !strings.Contains(row3.NodeLine, "*") {
		t.Errorf("row3 node line missing *: %q", row3.NodeLine)
	}

	// No merge-in or fork-out for linear chain
	if len(row1.PreLines) != 0 {
		t.Errorf("row1 should have no pre-lines, got %d", len(row1.PreLines))
	}
	if len(row1.PostLines) != 0 {
		t.Errorf("row1 should have no post-lines, got %d", len(row1.PostLines))
	}
}

func TestGraphRendererLinearUnicode(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	r := NewGraphRenderer()

	row1 := r.NextRow("A", []string{"B"})
	row2 := r.NextRow("B", []string{"C"})
	row3 := r.NextRow("C", nil)

	if !strings.Contains(row1.NodeLine, "●") {
		t.Errorf("row1 node line missing ●: %q", row1.NodeLine)
	}
	if !strings.Contains(row2.NodeLine, "●") {
		t.Errorf("row2 node line missing ●: %q", row2.NodeLine)
	}
	if !strings.Contains(row3.NodeLine, "●") {
		t.Errorf("row3 node line missing ●: %q", row3.NodeLine)
	}
}

func TestGraphRendererMergeCommit(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	r := NewGraphRenderer()

	// M is a merge of A and B
	rowM := r.NextRow("M", []string{"A", "B"})

	// M should be at column 0, and have a fork-out line
	if !strings.Contains(rowM.NodeLine, "*") {
		t.Errorf("merge node missing *: %q", rowM.NodeLine)
	}
	if len(rowM.PostLines) != 1 {
		t.Fatalf("merge should have 1 post-line (fork), got %d", len(rowM.PostLines))
	}
	// Fork line should contain both | and \
	fork := rowM.PostLines[0]
	if !strings.Contains(fork, "|") || !strings.Contains(fork, "\\") {
		t.Errorf("fork line missing | or \\: %q", fork)
	}

	// Now render B (at column 1) and A (at column 0)
	rowB := r.NextRow("B", []string{"C"})
	if !strings.Contains(rowB.NodeLine, "*") {
		t.Errorf("B node missing *: %q", rowB.NodeLine)
	}

	rowA := r.NextRow("A", []string{"C"})
	if !strings.Contains(rowA.NodeLine, "*") {
		t.Errorf("A node missing *: %q", rowA.NodeLine)
	}
}

func TestGraphRendererForkAndRejoin(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	r := NewGraphRenderer()

	// M merges A and B; both have parent C
	// Topo order: M, A, B, C (A newer than B)
	rowM := r.NextRow("M", []string{"A", "B"})
	_ = rowM // fork out: A continues col 0, B gets col 1

	rowA := r.NextRow("A", []string{"C"})
	_ = rowA // A at col 0, parent C continues

	rowB := r.NextRow("B", []string{"C"})
	// B at col 1; B's parent is C which is already in col 0
	// This should show a merge-in or the column should collapse
	_ = rowB

	rowC := r.NextRow("C", nil)
	if !strings.Contains(rowC.NodeLine, "*") {
		t.Errorf("C node missing *: %q", rowC.NodeLine)
	}
}

func TestGraphRendererUnicodeMerge(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	r := NewGraphRenderer()

	rowM := r.NextRow("M", []string{"A", "B"})

	if !strings.Contains(rowM.NodeLine, "●") {
		t.Errorf("merge node missing ●: %q", rowM.NodeLine)
	}
	if len(rowM.PostLines) != 1 {
		t.Fatalf("merge should have 1 post-line (fork), got %d", len(rowM.PostLines))
	}
	fork := rowM.PostLines[0]
	if !strings.Contains(fork, "├") || !strings.Contains(fork, "╮") {
		t.Errorf("Unicode fork line missing ├ or ╮: %q", fork)
	}
}

func TestCollectReachable(t *testing.T) {
	snaps := buildSnaps(
		SnapshotInfo{ID: "A", ParentIDs: []string{"B"}},
		SnapshotInfo{ID: "B", ParentIDs: []string{"C"}},
		SnapshotInfo{ID: "C", ParentIDs: nil},
		SnapshotInfo{ID: "D", ParentIDs: nil}, // unreachable from A
	)

	reachable := CollectReachable([]string{"A"}, snaps)
	if len(reachable) != 3 {
		t.Errorf("expected 3 reachable, got %d", len(reachable))
	}
	if _, ok := reachable["D"]; ok {
		t.Error("D should not be reachable from A")
	}
}

func TestGraphRendererFullOutput(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	// Build a diamond: M merges A and B, both parent C
	snaps := buildSnaps(
		SnapshotInfo{ID: "M", ParentIDs: []string{"A", "B"}, CreatedAt: "2025-01-04T00:00:00Z"},
		SnapshotInfo{ID: "A", ParentIDs: []string{"C"}, CreatedAt: "2025-01-03T00:00:00Z"},
		SnapshotInfo{ID: "B", ParentIDs: []string{"C"}, CreatedAt: "2025-01-02T00:00:00Z"},
		SnapshotInfo{ID: "C", ParentIDs: nil, CreatedAt: "2025-01-01T00:00:00Z"},
	)

	sorted := TopoSort([]string{"M"}, snaps)
	r := NewGraphRenderer()

	var lines []string
	for _, snap := range sorted {
		row := r.NextRow(snap.ID, snap.ParentIDs)
		for _, pre := range row.PreLines {
			lines = append(lines, pre)
		}
		lines = append(lines, row.NodeLine+"  "+snap.ID)
		for _, post := range row.PostLines {
			lines = append(lines, post)
		}
	}

	output := strings.Join(lines, "\n")
	t.Logf("Full graph output:\n%s", output)

	// Verify all nodes are present
	for _, id := range []string{"M", "A", "B", "C"} {
		if !strings.Contains(output, id) {
			t.Errorf("output missing snapshot %s", id)
		}
	}
}
