package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const authorFileName = "author.json"

// Author represents the snapshot author identity
type Author struct {
	Name  string `json:"name"`
	Email string `json:"email"`
}

// IsEmpty returns true if both name and email are unset
func (a *Author) IsEmpty() bool {
	return a == nil || (a.Name == "" && a.Email == "")
}

// LoadAuthor resolves author identity: project-level overrides global.
func LoadAuthor() (*Author, error) {
	if a, err := LoadProjectAuthor(); err == nil && !a.IsEmpty() {
		return a, nil
	}
	return LoadGlobalAuthor()
}

// LoadGlobalAuthor reads author from ~/.config/fst/author.json
func LoadGlobalAuthor() (*Author, error) {
	configDir, err := GetGlobalConfigDir()
	if err != nil {
		return nil, err
	}
	return loadAuthorFrom(filepath.Join(configDir, authorFileName))
}

// LoadProjectAuthor reads author from .fst/author.json in the current project
func LoadProjectAuthor() (*Author, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return nil, err
	}
	return loadAuthorFrom(filepath.Join(root, ConfigDirName, authorFileName))
}

// SaveGlobalAuthor writes author to ~/.config/fst/author.json
func SaveGlobalAuthor(a *Author) error {
	configDir, err := GetGlobalConfigDir()
	if err != nil {
		return err
	}
	return saveAuthorTo(filepath.Join(configDir, authorFileName), a)
}

// SaveProjectAuthor writes author to .fst/author.json in the current project
func SaveProjectAuthor(a *Author) error {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return err
	}
	return saveAuthorTo(filepath.Join(root, ConfigDirName, authorFileName), a)
}

func loadAuthorFrom(path string) (*Author, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Author{}, nil
		}
		return nil, fmt.Errorf("failed to read author config: %w", err)
	}
	var a Author
	if err := json.Unmarshal(data, &a); err != nil {
		return nil, fmt.Errorf("failed to parse author config: %w", err)
	}
	return &a, nil
}

func saveAuthorTo(path string, a *Author) error {
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}
	data, err := json.MarshalIndent(a, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal author config: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write author config: %w", err)
	}
	return nil
}
