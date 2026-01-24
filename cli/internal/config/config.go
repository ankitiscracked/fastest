package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Global cache directory name
const globalCacheDirName = "fst"

const (
	ConfigDirName    = ".fst"
	ConfigFileName   = "config.json"
	SnapshotsDirName = "snapshots"
	ManifestsDirName = "manifests"
)

// GetGlobalCacheDir returns the global cache directory (~/.cache/fst/)
// Supports XDG_CACHE_HOME environment variable
func GetGlobalCacheDir() (string, error) {
	cacheHome := os.Getenv("XDG_CACHE_HOME")
	if cacheHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("could not determine home directory: %w", err)
		}
		cacheHome = filepath.Join(home, ".cache")
	}
	cacheDir := filepath.Join(cacheHome, globalCacheDirName)
	if err := os.MkdirAll(cacheDir, 0755); err != nil {
		return "", fmt.Errorf("could not create cache directory: %w", err)
	}
	return cacheDir, nil
}

// GetGlobalBlobDir returns the global blob storage directory (~/.cache/fst/blobs/)
func GetGlobalBlobDir() (string, error) {
	cacheDir, err := GetGlobalCacheDir()
	if err != nil {
		return "", err
	}
	blobDir := filepath.Join(cacheDir, "blobs")
	if err := os.MkdirAll(blobDir, 0755); err != nil {
		return "", fmt.Errorf("could not create blob directory: %w", err)
	}
	return blobDir, nil
}

// GetGlobalConfigDir returns the global config directory (~/.config/fst/)
// Supports XDG_CONFIG_HOME environment variable
func GetGlobalConfigDir() (string, error) {
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("could not determine home directory: %w", err)
		}
		configHome = filepath.Join(home, ".config")
	}
	configDir := filepath.Join(configHome, globalCacheDirName)
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", fmt.Errorf("could not create config directory: %w", err)
	}
	return configDir, nil
}

// GetSnapshotsDir returns the local snapshots directory for the current workspace
func GetSnapshotsDir() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}
	snapshotsDir := filepath.Join(root, ConfigDirName, SnapshotsDirName)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return "", fmt.Errorf("could not create snapshots directory: %w", err)
	}
	return snapshotsDir, nil
}

// GetManifestsDir returns the local manifests directory for the current workspace
func GetManifestsDir() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}
	manifestsDir := filepath.Join(root, ConfigDirName, ManifestsDirName)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return "", fmt.Errorf("could not create manifests directory: %w", err)
	}
	return manifestsDir, nil
}

// GetSnapshotsDirAt returns the snapshots directory for a specific workspace root
func GetSnapshotsDirAt(root string) string {
	return filepath.Join(root, ConfigDirName, SnapshotsDirName)
}

// GetManifestsDirAt returns the manifests directory for a specific workspace root
func GetManifestsDirAt(root string) string {
	return filepath.Join(root, ConfigDirName, ManifestsDirName)
}

// ManifestHashFromSnapshotID extracts the manifest hash from a snapshot ID.
func ManifestHashFromSnapshotID(snapshotID string) (string, error) {
	const prefix = "snap-"
	if strings.HasPrefix(snapshotID, prefix) && len(snapshotID) > len(prefix) {
		return strings.TrimPrefix(snapshotID, prefix), nil
	}
	return "", fmt.Errorf("invalid snapshot ID format: %s", snapshotID)
}

// SnapshotMeta represents snapshot metadata
type SnapshotMeta struct {
	ID        string `json:"id"`
	CreatedAt string `json:"created_at"`
}

// GetLatestSnapshotID returns the most recent snapshot ID for the current workspace
func GetLatestSnapshotID() (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}
	return GetLatestSnapshotIDAt(root)
}

// GetLatestSnapshotIDAt returns the most recent snapshot ID for a specific workspace
func GetLatestSnapshotIDAt(root string) (string, error) {
	snapshotsDir := GetSnapshotsDirAt(root)

	entries, err := os.ReadDir(snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}

	var latestID string
	var latestTime string

	for _, entry := range entries {
		name := entry.Name()
		// Look for metadata files (snap-xxx.meta.json)
		if !entry.IsDir() && len(name) > 10 && name[len(name)-10:] == ".meta.json" {
			metaPath := filepath.Join(snapshotsDir, name)
			data, err := os.ReadFile(metaPath)
			if err != nil {
				continue
			}

			var meta SnapshotMeta
			if err := json.Unmarshal(data, &meta); err != nil {
				continue
			}

			// Compare timestamps (RFC3339 format sorts lexicographically)
			if meta.CreatedAt > latestTime {
				latestTime = meta.CreatedAt
				latestID = meta.ID
			}
		}
	}

	return latestID, nil
}

// MergeRecord tracks when a workspace was last merged from another workspace
type MergeRecord struct {
	LastMergedSnapshot string `json:"last_merged_snapshot"`
	MergedAt           string `json:"merged_at"`
}

// ProjectConfig represents the local project configuration stored in .fst/config.json
// All workspaces are peers - there is no main/linked distinction
type ProjectConfig struct {
	ProjectID         string                 `json:"project_id"`
	WorkspaceID       string                 `json:"workspace_id,omitempty"`
	WorkspaceName     string                 `json:"workspace_name,omitempty"`
	ForkSnapshotID    string                 `json:"fork_snapshot_id,omitempty"`
	CurrentSnapshotID string                 `json:"current_snapshot_id,omitempty"`
	MergeHistory      map[string]MergeRecord `json:"merge_history,omitempty"`
	APIURL            string                 `json:"api_url,omitempty"`
	Mode              string                 `json:"mode,omitempty"` // "cloud" or "local"
}

// FindProjectRoot walks up the directory tree to find .fst/ directory
func FindProjectRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		fstPath := filepath.Join(dir, ConfigDirName)

		// Check if .fst exists as a directory with config.json
		if info, err := os.Stat(fstPath); err == nil && info.IsDir() {
			configPath := filepath.Join(fstPath, ConfigFileName)
			if _, err := os.Stat(configPath); err == nil {
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

// GetConfigDir returns the .fst directory path for the current workspace
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

	var config struct {
		ProjectConfig
		BaseSnapshotID string `json:"base_snapshot_id,omitempty"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	if config.ForkSnapshotID == "" && config.BaseSnapshotID != "" {
		config.ForkSnapshotID = config.BaseSnapshotID
	}
	if config.CurrentSnapshotID == "" {
		if root, err := FindProjectRoot(); err == nil {
			if latest, err := GetLatestSnapshotIDAt(root); err == nil && latest != "" {
				config.CurrentSnapshotID = latest
			}
		}
	}

	return &config.ProjectConfig, nil
}

// LoadAt reads the project configuration from a specific workspace root
func LoadAt(root string) (*ProjectConfig, error) {
	configPath := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var config struct {
		ProjectConfig
		BaseSnapshotID string `json:"base_snapshot_id,omitempty"`
	}
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	if config.ForkSnapshotID == "" && config.BaseSnapshotID != "" {
		config.ForkSnapshotID = config.BaseSnapshotID
	}
	if config.CurrentSnapshotID == "" {
		if latest, err := GetLatestSnapshotIDAt(root); err == nil && latest != "" {
			config.CurrentSnapshotID = latest
		}
	}

	return &config.ProjectConfig, nil
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

// SaveAt writes the project configuration to a specific workspace root
func SaveAt(root string, config *ProjectConfig) error {
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

// Init creates a new workspace with .fst directory structure
func Init(projectID, workspaceID, workspaceName string) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}

	return InitAt(cwd, projectID, workspaceID, workspaceName, "")
}

// InitAt creates a new workspace at a specific path
func InitAt(root, projectID, workspaceID, workspaceName, forkSnapshotID string) error {
	configDir := filepath.Join(root, ConfigDirName)

	// Check if already initialized
	if _, err := os.Stat(configDir); err == nil {
		return fmt.Errorf("already initialized: %s exists", configDir)
	}

	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// Create snapshots directory
	snapshotsDir := filepath.Join(configDir, SnapshotsDirName)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return fmt.Errorf("failed to create snapshots directory: %w", err)
	}

	// Create manifests directory
	manifestsDir := filepath.Join(configDir, ManifestsDirName)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return fmt.Errorf("failed to create manifests directory: %w", err)
	}

	config := &ProjectConfig{
		ProjectID:         projectID,
		WorkspaceID:       workspaceID,
		WorkspaceName:     workspaceName,
		ForkSnapshotID:    forkSnapshotID,
		CurrentSnapshotID: forkSnapshotID,
		Mode:              "local",
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
gitignore := `# Fastest local data
snapshots/
manifests/
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
