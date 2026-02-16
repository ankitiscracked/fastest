package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ankitiscracked/fastest/cli/internal/store"
)

const (
	ConfigTypeProject   = "project"
	ConfigTypeWorkspace = "workspace"
)

var ErrProjectNotFound = errors.New("parent config not found")

// BackendConfig configures the storage backend for a project.
type BackendConfig struct {
	Type   string `json:"type"`             // "github", "git", "cloud"
	Repo   string `json:"repo,omitempty"`   // "owner/repo" for github
	Remote string `json:"remote,omitempty"` // git remote name, default "origin"
}

type ProjectConfig struct {
	Type             string         `json:"type"`
	ProjectID        string         `json:"project_id"`
	ProjectName      string         `json:"project_name"`
	CreatedAt        string         `json:"created_at"`
	BaseSnapshotID   string         `json:"base_snapshot_id,omitempty"`
	BaseWorkspaceID  string         `json:"base_workspace_id,omitempty"`
	MainWorkspaceID  string         `json:"main_workspace_id,omitempty"`
	Backend          *BackendConfig `json:"backend,omitempty"`
}

// BackendType returns the configured backend type, or empty string if none.
func (p *ProjectConfig) BackendType() string {
	if p == nil || p.Backend == nil {
		return ""
	}
	return p.Backend.Type
}

func LoadProjectConfigAt(root string) (*ProjectConfig, error) {
	path := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}

	var cfg ProjectConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("failed to parse .fst/config.json: %w", err)
	}
	if cfg.Type != ConfigTypeProject {
		return nil, fmt.Errorf(".fst/config.json is not a project config (type=%q)", cfg.Type)
	}
	if cfg.ProjectID == "" || cfg.ProjectName == "" {
		return nil, fmt.Errorf(".fst/config.json missing project_id or project_name")
	}

	return &cfg, nil
}

func SaveProjectConfigAt(root string, cfg *ProjectConfig) error {
	if cfg == nil {
		return fmt.Errorf("parent config is nil")
	}
	if cfg.ProjectID == "" || cfg.ProjectName == "" {
		return fmt.Errorf("parent config missing project_id or project_name")
	}

	cfg.Type = ConfigTypeProject

	configDir := filepath.Join(root, ConfigDirName)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	path := filepath.Join(configDir, ConfigFileName)
	return store.AtomicWriteFile(path, data, 0644)
}

// isProjectRoot checks if dir contains a .fst/config.json with type "project".
func isProjectRoot(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, ConfigDirName, ConfigFileName))
	if err != nil {
		return false
	}
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return false
	}
	return header.Type == ConfigTypeProject
}

// FindProjectRootFrom walks up the tree to find a project root with .fst/config.json (type "project").
func FindProjectRootFrom(start string) (string, *ProjectConfig, error) {
	dir := start
	for {
		if isProjectRoot(dir) {
			cfg, err := LoadProjectConfigAt(dir)
			if err != nil {
				return "", nil, err
			}
			return dir, cfg, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", nil, ErrProjectNotFound
		}
		dir = parent
	}
}
