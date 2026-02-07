package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveLoadGlobalAuthor(t *testing.T) {
	configDir := t.TempDir()
	t.Setenv("XDG_CONFIG_HOME", configDir)

	author := &Author{Name: "John Doe", Email: "john@example.com"}
	if err := SaveGlobalAuthor(author); err != nil {
		t.Fatalf("SaveGlobalAuthor: %v", err)
	}

	loaded, err := LoadGlobalAuthor()
	if err != nil {
		t.Fatalf("LoadGlobalAuthor: %v", err)
	}
	if loaded.Name != "John Doe" || loaded.Email != "john@example.com" {
		t.Fatalf("loaded author mismatch: %+v", loaded)
	}
}

func TestSaveLoadProjectAuthor(t *testing.T) {
	root := t.TempDir()

	// Set up a workspace so FindProjectRoot works
	if err := os.MkdirAll(filepath.Join(root, ConfigDirName), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigDirName, ConfigFileName), []byte("{}"), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cwd, _ := os.Getwd()
	defer func() { _ = os.Chdir(cwd) }()
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	author := &Author{Name: "Jane Smith", Email: "jane@example.com"}
	if err := SaveProjectAuthor(author); err != nil {
		t.Fatalf("SaveProjectAuthor: %v", err)
	}

	loaded, err := LoadProjectAuthor()
	if err != nil {
		t.Fatalf("LoadProjectAuthor: %v", err)
	}
	if loaded.Name != "Jane Smith" || loaded.Email != "jane@example.com" {
		t.Fatalf("loaded author mismatch: %+v", loaded)
	}
}

func TestLoadAuthorProjectOverridesGlobal(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configDir)

	// Set up workspace
	if err := os.MkdirAll(filepath.Join(root, ConfigDirName), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigDirName, ConfigFileName), []byte("{}"), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cwd, _ := os.Getwd()
	defer func() { _ = os.Chdir(cwd) }()
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	// Save global author
	if err := SaveGlobalAuthor(&Author{Name: "Global", Email: "global@example.com"}); err != nil {
		t.Fatalf("SaveGlobalAuthor: %v", err)
	}

	// Save project author
	if err := SaveProjectAuthor(&Author{Name: "Project", Email: "project@example.com"}); err != nil {
		t.Fatalf("SaveProjectAuthor: %v", err)
	}

	// LoadAuthor should return project-level
	author, err := LoadAuthor()
	if err != nil {
		t.Fatalf("LoadAuthor: %v", err)
	}
	if author.Name != "Project" || author.Email != "project@example.com" {
		t.Fatalf("expected project author, got %+v", author)
	}
}

func TestLoadAuthorFallsBackToGlobal(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configDir)

	// Set up workspace with no project author
	if err := os.MkdirAll(filepath.Join(root, ConfigDirName), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigDirName, ConfigFileName), []byte("{}"), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cwd, _ := os.Getwd()
	defer func() { _ = os.Chdir(cwd) }()
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	// Save only global author
	if err := SaveGlobalAuthor(&Author{Name: "Global", Email: "global@example.com"}); err != nil {
		t.Fatalf("SaveGlobalAuthor: %v", err)
	}

	author, err := LoadAuthor()
	if err != nil {
		t.Fatalf("LoadAuthor: %v", err)
	}
	if author.Name != "Global" || author.Email != "global@example.com" {
		t.Fatalf("expected global author, got %+v", author)
	}
}

func TestAuthorIsEmpty(t *testing.T) {
	if !(&Author{}).IsEmpty() {
		t.Fatalf("empty author should be empty")
	}
	if !(&Author{Name: "", Email: ""}).IsEmpty() {
		t.Fatalf("blank author should be empty")
	}
	if (&Author{Name: "John"}).IsEmpty() {
		t.Fatalf("author with name should not be empty")
	}
	if (&Author{Email: "j@e.com"}).IsEmpty() {
		t.Fatalf("author with email should not be empty")
	}
	var nilAuthor *Author
	if !nilAuthor.IsEmpty() {
		t.Fatalf("nil author should be empty")
	}
}

func TestLoadAuthorReturnsEmptyWhenNotConfigured(t *testing.T) {
	root := t.TempDir()
	configDir := filepath.Join(root, "config")
	t.Setenv("XDG_CONFIG_HOME", configDir)

	// Set up workspace
	if err := os.MkdirAll(filepath.Join(root, ConfigDirName), 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, ConfigDirName, ConfigFileName), []byte("{}"), 0644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	cwd, _ := os.Getwd()
	defer func() { _ = os.Chdir(cwd) }()
	if err := os.Chdir(root); err != nil {
		t.Fatalf("chdir: %v", err)
	}

	author, err := LoadAuthor()
	if err != nil {
		t.Fatalf("LoadAuthor: %v", err)
	}
	if !author.IsEmpty() {
		t.Fatalf("expected empty author when not configured, got %+v", author)
	}
}
