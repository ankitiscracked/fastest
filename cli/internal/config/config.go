package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	ConfigDirName  = ".fst"
	ConfigFileName = "config.json"
	LinkFileName   = "link"
)

// ProjectConfig represents the local project configuration stored in .fst/config.json
type ProjectConfig struct {
	ProjectID      string `json:"project_id"`
	WorkspaceID    string `json:"workspace_id,omitempty"`
	WorkspaceName  string `json:"workspace_name,omitempty"`
	BaseSnapshotID string `json:"base_snapshot_id,omitempty"`
	APIURL         string `json:"api_url,omitempty"`
	Mode           string `json:"mode,omitempty"` // "cloud" or "local"
	IsMain         bool   `json:"is_main,omitempty"`
}

// FindProjectRoot walks up the directory tree to find .fst/ (directory or link file)
func FindProjectRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		fstPath := filepath.Join(dir, ConfigDirName)

		// Check if .fst exists (as directory or file)
		if info, err := os.Stat(fstPath); err == nil {
			if info.IsDir() {
				// Main workspace - .fst is a directory
				configPath := filepath.Join(fstPath, ConfigFileName)
				if _, err := os.Stat(configPath); err == nil {
					return dir, nil
				}
			} else {
				// Linked workspace - .fst is a file containing path to main
				return dir, nil
			}
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			// Reached root
			return "", fmt.Errorf("not in a fst project (no .fst found)")
		}
		dir = parent
	}
}

// IsLinkedWorkspace checks if the current workspace is linked to another
func IsLinkedWorkspace() (bool, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return false, err
	}

	fstPath := filepath.Join(root, ConfigDirName)
	info, err := os.Stat(fstPath)
	if err != nil {
		return false, err
	}

	// If .fst is a file (not directory), it's a linked workspace
	return !info.IsDir(), nil
}

// GetMainWorkspacePath returns the path to the main workspace
// For main workspaces, returns its own path
// For linked workspaces, reads the link and returns the main's path
func GetMainWorkspacePath() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}

	fstPath := filepath.Join(root, ConfigDirName)
	info, err := os.Stat(fstPath)
	if err != nil {
		return "", err
	}

	if info.IsDir() {
		// This is a main workspace
		return root, nil
	}

	// This is a linked workspace - read the link file
	linkData, err := os.ReadFile(fstPath)
	if err != nil {
		return "", fmt.Errorf("failed to read workspace link: %w", err)
	}

	// Parse link file format: "main: /path/to/main\nworkspace_id: ws-xxx"
	var mainPath string
	lines := strings.Split(string(linkData), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "main: ") {
			mainPath = strings.TrimPrefix(line, "main: ")
			break
		}
	}

	if mainPath == "" {
		return "", fmt.Errorf("invalid workspace link file")
	}

	// Verify main workspace exists
	mainFstPath := filepath.Join(mainPath, ConfigDirName)
	if info, err := os.Stat(mainFstPath); err != nil || !info.IsDir() {
		return "", fmt.Errorf("main workspace not found at %s", mainPath)
	}

	return mainPath, nil
}

// GetConfigDir returns the .fst directory path for the MAIN workspace
// This is where shared caches (blobs, manifests) are stored
func GetConfigDir() (string, error) {
	mainPath, err := GetMainWorkspacePath()
	if err != nil {
		return "", err
	}
	return filepath.Join(mainPath, ConfigDirName), nil
}

// GetLocalConfigDir returns the .fst directory for the current workspace
// For main workspaces, same as GetConfigDir
// For linked workspaces, returns the workspace's own config location
func GetLocalConfigDir() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}

	isLinked, err := IsLinkedWorkspace()
	if err != nil {
		return "", err
	}

	if isLinked {
		// For linked workspaces, config is stored in main's workspaces/ dir
		mainPath, err := GetMainWorkspacePath()
		if err != nil {
			return "", err
		}

		// Get workspace ID from the link metadata
		cfg, err := Load()
		if err != nil {
			return "", err
		}

		return filepath.Join(mainPath, ConfigDirName, "workspaces", cfg.WorkspaceID), nil
	}

	return filepath.Join(root, ConfigDirName), nil
}

// Load reads the project configuration
// For main workspaces: from .fst/config.json
// For linked workspaces: from main's .fst/workspaces/{id}/config.json
func Load() (*ProjectConfig, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return nil, err
	}

	fstPath := filepath.Join(root, ConfigDirName)
	info, err := os.Stat(fstPath)
	if err != nil {
		return nil, err
	}

	var configPath string
	if info.IsDir() {
		// Main workspace
		configPath = filepath.Join(fstPath, ConfigFileName)
	} else {
		// Linked workspace - read link to find main, then load from workspaces/
		linkData, err := os.ReadFile(fstPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read workspace link: %w", err)
		}

		// Link file format: "main: /path/to/main\nworkspace_id: ws-xxx"
		lines := strings.Split(string(linkData), "\n")
		var mainPath, workspaceID string
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "main: ") {
				mainPath = strings.TrimPrefix(line, "main: ")
			} else if strings.HasPrefix(line, "workspace_id: ") {
				workspaceID = strings.TrimPrefix(line, "workspace_id: ")
			}
		}

		if mainPath == "" || workspaceID == "" {
			return nil, fmt.Errorf("invalid workspace link file")
		}

		configPath = filepath.Join(mainPath, ConfigDirName, "workspaces", workspaceID, ConfigFileName)
	}

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

// Save writes the project configuration
func Save(config *ProjectConfig) error {
	root, err := FindProjectRoot()
	if err != nil {
		// If no project root, try current directory
		root, err = os.Getwd()
		if err != nil {
			return err
		}
	}

	fstPath := filepath.Join(root, ConfigDirName)
	info, err := os.Stat(fstPath)

	var configPath string
	if err == nil && !info.IsDir() {
		// Linked workspace - save to main's workspaces/ dir
		linkData, err := os.ReadFile(fstPath)
		if err != nil {
			return fmt.Errorf("failed to read workspace link: %w", err)
		}

		lines := strings.Split(string(linkData), "\n")
		var mainPath string
		for _, line := range lines {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "main: ") {
				mainPath = strings.TrimPrefix(line, "main: ")
				break
			}
		}

		if mainPath == "" {
			return fmt.Errorf("invalid workspace link file")
		}

		configDir := filepath.Join(mainPath, ConfigDirName, "workspaces", config.WorkspaceID)
		if err := os.MkdirAll(configDir, 0755); err != nil {
			return fmt.Errorf("failed to create workspace config directory: %w", err)
		}
		configPath = filepath.Join(configDir, ConfigFileName)
	} else {
		// Main workspace
		configDir := filepath.Join(root, ConfigDirName)
		if err := os.MkdirAll(configDir, 0755); err != nil {
			return fmt.Errorf("failed to create config directory: %w", err)
		}
		configPath = filepath.Join(configDir, ConfigFileName)
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// InitMain creates a new main workspace with .fst directory
func InitMain(projectID, workspaceID, workspaceName string) error {
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
	for _, subdir := range []string{"cache", "cache/blobs", "cache/manifests", "workspaces"} {
		if err := os.MkdirAll(filepath.Join(configDir, subdir), 0755); err != nil {
			return fmt.Errorf("failed to create %s: %w", subdir, err)
		}
	}

	config := &ProjectConfig{
		ProjectID:     projectID,
		WorkspaceID:   workspaceID,
		WorkspaceName: workspaceName,
		Mode:          "local",
		IsMain:        true,
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
workspaces/
*.log
`
	gitignorePath := filepath.Join(configDir, ".gitignore")
	if err := os.WriteFile(gitignorePath, []byte(gitignore), 0644); err != nil {
		return fmt.Errorf("failed to write .gitignore: %w", err)
	}

	return nil
}

// InitLinked creates a linked workspace pointing to a main workspace
func InitLinked(mainPath, workspaceID, workspaceName, baseSnapshotID, projectID string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}

	fstPath := filepath.Join(cwd, ConfigDirName)

	// Check if already initialized
	if _, err := os.Stat(fstPath); err == nil {
		return fmt.Errorf("already initialized: %s exists", fstPath)
	}

	// Create link file (not directory)
	linkContent := fmt.Sprintf("main: %s\nworkspace_id: %s\n", mainPath, workspaceID)
	if err := os.WriteFile(fstPath, []byte(linkContent), 0644); err != nil {
		return fmt.Errorf("failed to create workspace link: %w", err)
	}

	// Create workspace config in main's workspaces/ directory
	mainConfigDir := filepath.Join(mainPath, ConfigDirName)
	workspaceDir := filepath.Join(mainConfigDir, "workspaces", workspaceID)
	if err := os.MkdirAll(workspaceDir, 0755); err != nil {
		return fmt.Errorf("failed to create workspace directory: %w", err)
	}

	config := &ProjectConfig{
		ProjectID:      projectID,
		WorkspaceID:    workspaceID,
		WorkspaceName:  workspaceName,
		BaseSnapshotID: baseSnapshotID,
		Mode:           "local",
		IsMain:         false,
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(workspaceDir, ConfigFileName)
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
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

// Init is deprecated - use InitMain instead
func Init(projectID, projectName, workspaceID, workspaceName string) error {
	return InitMain(projectID, workspaceID, workspaceName)
}
