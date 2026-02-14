package dag

import (
	"strings"
	"testing"
)

func TestRenderMergeDiagramUnicode(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "a1b2c3d4e5f6g7h8",
		SourceID:     "i9j0k1l2m3n4o5p6",
		MergeBaseID:  "q7r8s9t0u1v2w3x4",
		MergedID:     "y5z6a7b8c9d0e1f2",
		CurrentLabel: "my-workspace",
		SourceLabel:  "feature",
		Message:      "Merged feature",
	})

	lines := strings.Split(out, "\n")
	if len(lines) != 7 {
		t.Fatalf("expected 7 lines, got %d:\n%s", len(lines), out)
	}

	// Check labels are present
	if !strings.Contains(lines[0], "my-workspace") {
		t.Errorf("line 0 missing left label: %q", lines[0])
	}
	if !strings.Contains(lines[0], "feature") {
		t.Errorf("line 0 missing right label: %q", lines[0])
	}

	// Check vertical connectors
	if !strings.Contains(lines[1], "│") {
		t.Errorf("line 1 missing vertical connector: %q", lines[1])
	}

	// Check short IDs (truncated to 8)
	if !strings.Contains(lines[2], "a1b2c3d4") {
		t.Errorf("line 2 missing left short ID: %q", lines[2])
	}
	if !strings.Contains(lines[2], "i9j0k1l2") {
		t.Errorf("line 2 missing right short ID: %q", lines[2])
	}

	// Check connector has Unicode glyphs
	if !strings.Contains(lines[3], "╰") || !strings.Contains(lines[3], "╯") || !strings.Contains(lines[3], "┬") {
		t.Errorf("line 3 missing Unicode connector glyphs: %q", lines[3])
	}
	if !strings.Contains(lines[3], "─") {
		t.Errorf("line 3 missing horizontal connector: %q", lines[3])
	}

	// Check merged ID
	if !strings.Contains(lines[4], "y5z6a7b8") {
		t.Errorf("line 4 missing merged ID: %q", lines[4])
	}

	// Check message
	if !strings.Contains(lines[5], "Merged feature") {
		t.Errorf("line 5 missing message: %q", lines[5])
	}

	// Check base
	if !strings.Contains(lines[6], "(base: q7r8s9t0)") {
		t.Errorf("line 6 missing base: %q", lines[6])
	}
}

func TestRenderMergeDiagramASCII(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "a1b2c3d4e5f6g7h8",
		SourceID:     "i9j0k1l2m3n4o5p6",
		MergeBaseID:  "q7r8s9t0u1v2w3x4",
		MergedID:     "y5z6a7b8c9d0e1f2",
		CurrentLabel: "my-workspace",
		SourceLabel:  "feature",
		Message:      "Merged feature",
	})

	lines := strings.Split(out, "\n")
	if len(lines) != 7 {
		t.Fatalf("expected 7 lines, got %d:\n%s", len(lines), out)
	}

	// Check ASCII vertical
	if !strings.Contains(lines[1], "|") {
		t.Errorf("line 1 missing ASCII vertical: %q", lines[1])
	}

	// Check ASCII connector
	if !strings.Contains(lines[3], "\\") || !strings.Contains(lines[3], "/") || !strings.Contains(lines[3], "+") {
		t.Errorf("line 3 missing ASCII connector glyphs: %q", lines[3])
	}
	if !strings.Contains(lines[3], "-") {
		t.Errorf("line 3 missing ASCII horizontal: %q", lines[3])
	}
}

func TestRenderMergeDiagramDryRun(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "a1b2c3d4e5f6g7h8",
		SourceID:     "i9j0k1l2m3n4o5p6",
		MergeBaseID:  "q7r8s9t0u1v2w3x4",
		MergedID:     "", // dry-run: no merged ID
		CurrentLabel: "workspace-a",
		SourceLabel:  "workspace-b",
	})

	// Should show "merge?" placeholder
	if !strings.Contains(out, "merge?") {
		t.Errorf("dry-run diagram missing 'merge?' placeholder:\n%s", out)
	}

	// No message line (empty Message)
	lines := strings.Split(out, "\n")
	// labels, vertical, IDs, connector, mergedID, base = 6 lines
	if len(lines) != 6 {
		t.Fatalf("expected 6 lines (no message), got %d:\n%s", len(lines), out)
	}
}

func TestRenderMergeDiagramNoBase(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "a1b2c3d4e5f6g7h8",
		SourceID:     "i9j0k1l2m3n4o5p6",
		MergeBaseID:  "", // no base
		MergedID:     "y5z6a7b8c9d0e1f2",
		CurrentLabel: "local",
		SourceLabel:  "remote",
		Message:      "Sync merge",
	})

	// Should not contain "(base:"
	if strings.Contains(out, "(base:") {
		t.Errorf("diagram should not show base line when MergeBaseID is empty:\n%s", out)
	}

	lines := strings.Split(out, "\n")
	// labels, vertical, IDs, connector, mergedID, message = 6 lines
	if len(lines) != 6 {
		t.Fatalf("expected 6 lines (no base), got %d:\n%s", len(lines), out)
	}
}

func TestRenderMergeDiagramShortLabels(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "aaaa1111bbbb2222",
		SourceID:     "cccc3333dddd4444",
		MergeBaseID:  "eeee5555ffff6666",
		MergedID:     "7777888899990000",
		CurrentLabel: "a",
		SourceLabel:  "b",
		Message:      "Merged b",
	})

	lines := strings.Split(out, "\n")
	if len(lines) != 7 {
		t.Fatalf("expected 7 lines, got %d:\n%s", len(lines), out)
	}

	if !strings.Contains(lines[0], "a") && !strings.Contains(lines[0], "b") {
		t.Errorf("line 0 missing labels: %q", lines[0])
	}
	if !strings.Contains(lines[2], "aaaa1111") {
		t.Errorf("line 2 missing left ID: %q", lines[2])
	}
	if !strings.Contains(lines[2], "cccc3333") {
		t.Errorf("line 2 missing right ID: %q", lines[2])
	}
}

func TestRenderMergeDiagramLongLabels(t *testing.T) {
	SetUnicode(false)
	defer ResetUnicode()

	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "aaaa1111bbbb2222",
		SourceID:     "cccc3333dddd4444",
		MergeBaseID:  "eeee5555ffff6666",
		MergedID:     "7777888899990000",
		CurrentLabel: "very-long-workspace-name",
		SourceLabel:  "another-long-workspace",
		Message:      "Merged another-long-workspace",
	})

	lines := strings.Split(out, "\n")
	if len(lines) != 7 {
		t.Fatalf("expected 7 lines, got %d:\n%s", len(lines), out)
	}

	if !strings.Contains(lines[0], "very-long-workspace-name") {
		t.Errorf("line 0 missing left label: %q", lines[0])
	}
	if !strings.Contains(lines[0], "another-long-workspace") {
		t.Errorf("line 0 missing right label: %q", lines[0])
	}
}

func TestShortID(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"a1b2c3d4e5f6g7h8", "a1b2c3d4"},
		{"abcd", "abcd"},
		{"", ""},
		{"12345678", "12345678"},
		{"123456789", "12345678"},
	}

	for _, tt := range tests {
		got := shortID(tt.input)
		if got != tt.want {
			t.Errorf("shortID(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestConnectorSymmetry(t *testing.T) {
	SetUnicode(true)
	defer ResetUnicode()

	// With equal-length labels, the connector should be symmetric
	out := RenderMergeDiagram(MergeDiagramOpts{
		CurrentID:    "aaaa1111bbbb2222",
		SourceID:     "cccc3333dddd4444",
		MergedID:     "7777888899990000",
		CurrentLabel: "left",
		SourceLabel:  "right",
	})

	lines := strings.Split(out, "\n")
	connLine := lines[3]
	runes := []rune(connLine)

	// Find positions of ╰, ┬, ╯
	var leftPos, midPos, rightPos int
	for i, r := range runes {
		switch r {
		case '╰':
			leftPos = i
		case '┬':
			midPos = i
		case '╯':
			rightPos = i
		}
	}

	leftDist := midPos - leftPos
	rightDist := rightPos - midPos
	// With equal labels, distances should be equal
	if leftDist != rightDist {
		t.Errorf("connector not symmetric: left distance %d, right distance %d\n%s", leftDist, rightDist, out)
	}
}
