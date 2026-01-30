package ignore

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMatchPatternsBasics(t *testing.T) {
	m := NewMatcher([]string{
		"foo*",
		"*bar",
		"*baz*",
		"exact",
		"dir/",
	})

	cases := []struct {
		path  string
		isDir bool
		want  bool
	}{
		{path: "foo.txt", want: false},
		{path: "foo", want: true},
		{path: "foo/bar.txt", want: true},
		{path: "quxbar", want: true},
		{path: "aaabazbbb", want: true},
		{path: "exact", want: true},
		{path: "dir", isDir: true, want: true},
		{path: "dir/file.txt", isDir: false, want: false}, // dir-only pattern
		{path: "nope", want: false},
	}

	for _, c := range cases {
		if got := m.Match(c.path, c.isDir); got != c.want {
			t.Fatalf("Match(%q, %v) = %v, want %v", c.path, c.isDir, got, c.want)
		}
	}
}

func TestMatchNegation(t *testing.T) {
	m := NewMatcher([]string{
		"*.log",
		"!keep.log",
	})

	if got := m.Match("error.log", false); got != true {
		t.Fatalf("expected error.log to be ignored")
	}
	if got := m.Match("keep.log", false); got != false {
		t.Fatalf("expected keep.log to be included due to negation")
	}
}

func TestPathNormalization(t *testing.T) {
	m := NewMatcher([]string{"dir"})
	path := filepath.Join("dir", "file.txt")
	if got := m.Match(path, false); got != true {
		t.Fatalf("expected joined path to match after normalization")
	}
}

func TestLoadFromFileIncludesDefaults(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, ".fstignore")
	if err := os.WriteFile(path, []byte("# comment\ncustom.log\n"), 0644); err != nil {
		t.Fatalf("write .fstignore: %v", err)
	}

	m, err := LoadFromFile(path)
	if err != nil {
		t.Fatalf("LoadFromFile: %v", err)
	}

	if got := m.Match("node_modules", true); got != true {
		t.Fatalf("expected default pattern to match node_modules dir")
	}
	if got := m.Match("custom.log", false); got != true {
		t.Fatalf("expected custom pattern to match")
	}
}
