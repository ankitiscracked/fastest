package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	ConfigDirName  = ".fst"
	ConfigFileName = "config.json"
)

// ProjectConfig represents the local project configuration stored in .fst/config.json
type ProjectConfig struct {
	ProjectID       string `json:"project_id"`
	WorkspaceID     string `json:"workspace_id,omitempty"`
	WorkspaceName   string `json:"workspace_name,omitempty"`
	BaseSnapshotID  string `json:"base_snapshot_id,omitempty"`
	APIURL          string `json:"api_url,omitempty"`
	Mode            string `json:"mode,omitempty"` // "cloud" or "local"
}

// FindProjectRoot walks up the directory tree to find .fst/config.json
func FindProjectRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		configPath := filepath.Join(dir, ConfigDirName, ConfigFileName)
		if _, err := os.Stat(configPath); err == nil {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached root
			return "", fmt.Errorf("not in a fst project (no .fst/config.json found)")
		}
		dir = parent
	}
}

// GetConfigDir returns the .fst directory path for the current project
func GetConfigDir() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, ConfigDirName), nil
}

// Load reads the project configuration from .fst/config.json
func Load() (*ProjectConfig, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return nil, err
	}

	configPath := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var config ProjectConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	return &config, nil
}

// Save writes the project configuration to .fst/config.json
func Save(config *ProjectConfig) error {
	root, err := FindProjectRoot()
	if err != nil {
		// If no project root, try current directory
		root, err = os.Getwd()
		if err != nil {
			return err
		}
	}

	configDir := filepath.Join(root, ConfigDirName)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, ConfigFileName)
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// Init creates a new .fst directory and config in the current directory
func Init(projectID, projectName, workspaceID, workspaceName string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}

	configDir := filepath.Join(cwd, ConfigDirName)

	// Check if already initialized
	if _, err := os.Stat(configDir); err == nil {
		return fmt.Errorf("already initialized: %s exists", configDir)
	}

	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Create subdirectories
	for _, subdir := range []string{"cache", "cache/blobs", "cache/manifests"} {
		if err := os.MkdirAll(filepath.Join(configDir, subdir), 0755); err != nil {
			return fmt.Errorf("failed to create %s: %w", subdir, err)
		}
	}

	config := &ProjectConfig{
		ProjectID:     projectID,
		WorkspaceID:   workspaceID,
		WorkspaceName: workspaceName,
		Mode:          "cloud",
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, ConfigFileName)
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Create .gitignore for .fst directory
	gitignore := `# Fastest local cache
cache/
*.log
`
	gitignorePath := filepath.Join(configDir, ".gitignore")
	if err := os.WriteFile(gitignorePath, []byte(gitignore), 0644); err != nil {
		return fmt.Errorf("failed to write .gitignore: %w", err)
	}

	return nil
}

// GetProjectID returns the project ID from the current project's config
func GetProjectID() (string, error) {
	config, err := Load()
	if err != nil {
		return "", err
	}
	return config.ProjectID, nil
}

// GetWorkspaceID returns the workspace ID from the current project's config
func GetWorkspaceID() (string, error) {
	config, err := Load()
	if err != nil {
		return "", err
	}
	return config.WorkspaceID, nil
}

// IsInitialized checks if the current directory is a fst project
func IsInitialized() bool {
	_, err := FindProjectRoot()
	return err == nil
}

// GetMachineID returns a unique identifier for this machine
func GetMachineID() string {
	hostname, err := os.Hostname()
	if err != nil {
		hostname = "unknown"
	}
	return hostname
}
