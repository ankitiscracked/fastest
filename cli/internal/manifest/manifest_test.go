package manifest

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestGenerateDeterministic(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "a.txt"), []byte("hello"), 0644); err != nil {
		t.Fatalf("write a.txt: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(root, "dir"), 0755); err != nil {
		t.Fatalf("mkdir dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "dir", "b.txt"), []byte("world"), 0644); err != nil {
		t.Fatalf("write b.txt: %v", err)
	}

	m1, err := Generate(root, false)
	if err != nil {
		t.Fatalf("Generate #1: %v", err)
	}
	m2, err := Generate(root, false)
	if err != nil {
		t.Fatalf("Generate #2: %v", err)
	}

	j1, err := m1.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON #1: %v", err)
	}
	j2, err := m2.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON #2: %v", err)
	}
	if string(j1) != string(j2) {
		t.Fatalf("manifest JSON not deterministic")
	}

	h1, err := m1.Hash()
	if err != nil {
		t.Fatalf("Hash #1: %v", err)
	}
	h2, err := m2.Hash()
	if err != nil {
		t.Fatalf("Hash #2: %v", err)
	}
	if h1 != h2 {
		t.Fatalf("manifest hash not deterministic")
	}
}

func TestGenerateIgnoresAndModes(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0755); err != nil {
		t.Fatalf("mkdir .git: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "config"), []byte("x"), 0644); err != nil {
		t.Fatalf("write .git/config: %v", err)
	}

	runPath := filepath.Join(root, "run.sh")
	if err := os.WriteFile(runPath, []byte("#!/bin/sh\n"), 0755); err != nil {
		t.Fatalf("write run.sh: %v", err)
	}
	if err := os.Chmod(runPath, 0755); err != nil {
		t.Fatalf("chmod run.sh: %v", err)
	}

	linkPath := filepath.Join(root, "link.sh")
	if runtime.GOOS != "windows" {
		if err := os.Symlink(runPath, linkPath); err != nil {
			t.Fatalf("symlink: %v", err)
		}
	}

	m, err := Generate(root, false)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	paths := make(map[string]FileEntry)
	for _, f := range m.Files {
		paths[f.Path] = f
	}

	if _, ok := paths[".git/config"]; ok {
		t.Fatalf("expected .git/config to be ignored")
	}
	if _, ok := paths["run.sh"]; !ok {
		t.Fatalf("expected run.sh to be included")
	}
	if paths["run.sh"].Mode != 0755 {
		t.Fatalf("expected run.sh mode 0755, got %o", paths["run.sh"].Mode)
	}

	if runtime.GOOS != "windows" {
		if _, ok := paths["link.sh"]; ok {
			t.Fatalf("expected symlink to be skipped")
		}
	}
}

func TestDiff(t *testing.T) {
	base := &Manifest{
		Version: "1",
		Files: []FileEntry{
			{Path: "a.txt", Hash: "h1"},
			{Path: "b.txt", Hash: "h2"},
		},
	}
	current := &Manifest{
		Version: "1",
		Files: []FileEntry{
			{Path: "a.txt", Hash: "h1"},
			{Path: "b.txt", Hash: "h3"},
			{Path: "c.txt", Hash: "h4"},
		},
	}

	added, modified, deleted := Diff(base, current)
	if strings.Join(added, ",") != "c.txt" {
		t.Fatalf("added mismatch: %v", added)
	}
	if strings.Join(modified, ",") != "b.txt" {
		t.Fatalf("modified mismatch: %v", modified)
	}
	if strings.Join(deleted, ",") != "" {
		t.Fatalf("deleted mismatch: %v", deleted)
	}
}
