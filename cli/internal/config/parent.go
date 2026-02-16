package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ankitiscracked/fastest/cli/internal/store"
)

const ParentConfigFileName = "fst.json"

var ErrParentNotFound = errors.New("parent config not found")

// BackendConfig configures the storage backend for a project.
type BackendConfig struct {
	Type   string `json:"type"`             // "github", "git", "cloud"
	Repo   string `json:"repo,omitempty"`   // "owner/repo" for github
	Remote string `json:"remote,omitempty"` // git remote name, default "origin"
}

type ParentConfig struct {
	ProjectID        string         `json:"project_id"`
	ProjectName      string         `json:"project_name"`
	CreatedAt        string         `json:"created_at"`
	BaseSnapshotID   string         `json:"base_snapshot_id,omitempty"`
	BaseWorkspaceID  string         `json:"base_workspace_id,omitempty"`
	MainWorkspaceID  string         `json:"main_workspace_id,omitempty"`
	Backend          *BackendConfig `json:"backend,omitempty"`
}

// BackendType returns the configured backend type, or empty string if none.
func (p *ParentConfig) BackendType() string {
	if p == nil || p.Backend == nil {
		return ""
	}
	return p.Backend.Type
}

func LoadParentConfigAt(root string) (*ParentConfig, error) {
	path := filepath.Join(root, ParentConfigFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg ParentConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse %s: %w", ParentConfigFileName, err)
	}
	if cfg.ProjectID == "" || cfg.ProjectName == "" {
		return nil, fmt.Errorf("%s missing project_id or project_name", ParentConfigFileName)
	}

	return &cfg, nil
}

func SaveParentConfigAt(root string, cfg *ParentConfig) error {
	if cfg == nil {
		return fmt.Errorf("parent config is nil")
	}
	if cfg.ProjectID == "" || cfg.ProjectName == "" {
		return fmt.Errorf("parent config missing project_id or project_name")
	}

	if err := os.MkdirAll(root, 0755); err != nil {
		return fmt.Errorf("failed to create parent directory: %w", err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal %s: %w", ParentConfigFileName, err)
	}

	path := filepath.Join(root, ParentConfigFileName)
	return store.AtomicWriteFile(path, data, 0644)
}

// FindParentRootFrom walks up the tree to find a parent container with fst.json.
func FindParentRootFrom(start string) (string, *ParentConfig, error) {
	dir := start
	for {
		path := filepath.Join(dir, ParentConfigFileName)
		if info, err := os.Stat(path); err == nil && !info.IsDir() {
			cfg, err := LoadParentConfigAt(dir)
			if err != nil {
				return "", nil, err
			}
			return dir, cfg, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil, ErrParentNotFound
		}
		dir = parent
	}
}
