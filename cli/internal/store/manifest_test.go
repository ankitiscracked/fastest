package store

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadManifestJSON(t *testing.T) {
	s, _ := setupStore(t)

	// Write a fake manifest JSON file
	content := []byte(`{"files":[],"symlinks":[]}`)
	hash := "deadbeef"
	if err := os.WriteFile(filepath.Join(s.ManifestsDir(), hash+".json"), content, 0644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}

	data, err := s.LoadManifestJSON(hash)
	if err != nil {
		t.Fatalf("LoadManifestJSON: %v", err)
	}
	if string(data) != string(content) {
		t.Fatalf("content mismatch: %s", string(data))
	}
}

func TestLoadManifestJSONNotFound(t *testing.T) {
	s, _ := setupStore(t)
	_, err := s.LoadManifestJSON("missing")
	if err == nil {
		t.Fatalf("expected error for missing manifest")
	}
}

func TestLoadManifestJSONEmptyHash(t *testing.T) {
	s, _ := setupStore(t)
	_, err := s.LoadManifestJSON("")
	if err == nil {
		t.Fatalf("expected error for empty hash")
	}
}

func TestManifestExists(t *testing.T) {
	s, _ := setupStore(t)

	if s.ManifestExists("nope") {
		t.Fatalf("expected false for missing manifest")
	}

	os.WriteFile(filepath.Join(s.ManifestsDir(), "exists.json"), []byte("{}"), 0644)
	if !s.ManifestExists("exists") {
		t.Fatalf("expected true for existing manifest")
	}
}
