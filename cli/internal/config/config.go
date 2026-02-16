package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ankitiscracked/fastest/cli/internal/ignore"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)


const (
	ConfigDirName    = ".fst"
	ConfigFileName   = "config.json"
	SnapshotsDirName = "snapshots"
	ManifestsDirName = "manifests"
	BlobsDirName     = "blobs"
)

// StatCacheFileName is the name of the stat cache file stored in .fst/.
const StatCacheFileName = "stat-cache.json"

// GetStatCachePath returns the path to the stat cache file for a workspace root.
// The stat cache is always workspace-local (not shared at project level) because
// it caches stat data specific to the workspace's working directory.
func GetStatCachePath(root string) string {
	return filepath.Join(root, ConfigDirName, StatCacheFileName)
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
	configDir := filepath.Join(configHome, "fst")
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", fmt.Errorf("could not create config directory: %w", err)
	}
	return configDir, nil
}

// GetSnapshotsDir returns the snapshots directory for the current workspace.
// If the workspace is under a project, returns the shared project-level directory.
func GetSnapshotsDir() (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	snapshotsDir := GetSnapshotsDirAt(root)
	if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
		return "", fmt.Errorf("could not create snapshots directory: %w", err)
	}
	return snapshotsDir, nil
}

// GetManifestsDir returns the manifests directory for the current workspace.
// If the workspace is under a project, returns the shared project-level directory.
func GetManifestsDir() (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	manifestsDir := GetManifestsDirAt(root)
	if err := os.MkdirAll(manifestsDir, 0755); err != nil {
		return "", fmt.Errorf("could not create manifests directory: %w", err)
	}
	return manifestsDir, nil
}

// GetSnapshotsDirAt returns the snapshots directory for a specific workspace root.
// If the workspace is under a project, returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetSnapshotsDirAt(root string) string {
	if projectRoot, _, err := FindProjectRootFrom(root); err == nil {
		return filepath.Join(projectRoot, ConfigDirName, SnapshotsDirName)
	}
	return filepath.Join(root, ConfigDirName, SnapshotsDirName)
}

// GetManifestsDirAt returns the manifests directory for a specific workspace root.
// If the workspace is under a project, returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetManifestsDirAt(root string) string {
	if projectRoot, _, err := FindProjectRootFrom(root); err == nil {
		return filepath.Join(projectRoot, ConfigDirName, ManifestsDirName)
	}
	return filepath.Join(root, ConfigDirName, ManifestsDirName)
}

// GetBlobsDir returns the blobs directory for the current workspace.
// If the workspace is under a project, returns the shared project-level directory.
func GetBlobsDir() (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	blobsDir := GetBlobsDirAt(root)
	if err := os.MkdirAll(blobsDir, 0755); err != nil {
		return "", fmt.Errorf("could not create blobs directory: %w", err)
	}
	return blobsDir, nil
}

// GetBlobsDirAt returns the blobs directory for a specific workspace root.
// If the workspace is under a project, returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetBlobsDirAt(root string) string {
	if projectRoot, _, err := FindProjectRootFrom(root); err == nil {
		return filepath.Join(projectRoot, ConfigDirName, BlobsDirName)
	}
	return filepath.Join(root, ConfigDirName, BlobsDirName)
}

// GetWorkspaceLocalSnapshotsDirAt returns the workspace-local snapshots directory,
// bypassing the project-level shared store. Used for migration.
func GetWorkspaceLocalSnapshotsDirAt(root string) string {
	return filepath.Join(root, ConfigDirName, SnapshotsDirName)
}

// GetWorkspaceLocalManifestsDirAt returns the workspace-local manifests directory,
// bypassing the project-level shared store. Used for migration.
func GetWorkspaceLocalManifestsDirAt(root string) string {
	return filepath.Join(root, ConfigDirName, ManifestsDirName)
}

// GetWorkspaceLocalBlobsDirAt returns the workspace-local blobs directory,
// bypassing the project-level shared store. Used for migration.
func GetWorkspaceLocalBlobsDirAt(root string) string {
	return filepath.Join(root, ConfigDirName, BlobsDirName)
}

// SnapshotMeta is a type alias for store.SnapshotMeta.
// All new code should use store.SnapshotMeta directly.
type SnapshotMeta = store.SnapshotMeta

// ManifestHashFromSnapshotID resolves a snapshot ID to its manifest hash using local metadata.
func ManifestHashFromSnapshotID(snapshotID string) (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	return ManifestHashFromSnapshotIDAt(root, snapshotID)
}

// ManifestHashFromSnapshotIDAt resolves a snapshot ID to its manifest hash for a specific workspace root.
func ManifestHashFromSnapshotIDAt(root, snapshotID string) (string, error) {
	s := store.OpenFromWorkspace(root)
	return s.ManifestHashFromSnapshotID(snapshotID)
}

// ResolveSnapshotIDAt resolves a snapshot prefix to a full ID for a specific workspace root.
func ResolveSnapshotIDAt(root, snapshotID string) (string, error) {
	s := store.OpenFromWorkspace(root)
	return s.ResolveSnapshotID(snapshotID)
}

// GetLatestSnapshotID returns the most recent snapshot ID for the current workspace
func GetLatestSnapshotID() (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	return GetLatestSnapshotIDAt(root)
}

// GetLatestSnapshotIDAt returns the most recent snapshot ID for a specific workspace
func GetLatestSnapshotIDAt(root string) (string, error) {
	s := store.OpenFromWorkspace(root)
	return s.GetLatestSnapshotID()
}

// GetLatestSnapshotIDForWorkspaceAt returns the most recent snapshot ID for a specific
// workspace, filtering by workspace_id. This is needed when using a shared project-level
// snapshot store where multiple workspaces' snapshots coexist.
func GetLatestSnapshotIDForWorkspaceAt(root string, workspaceID string) (string, error) {
	s := store.OpenFromWorkspace(root)
	return s.GetLatestSnapshotIDForWorkspace(workspaceID)
}

// WorkspaceConfig represents the local project configuration stored in .fst/config.json
// All workspaces are peers - there is no main/linked distinction
type WorkspaceConfig struct {
	Type           string `json:"type"`
	ProjectID      string `json:"project_id"`
	WorkspaceID    string `json:"workspace_id,omitempty"`
	WorkspaceName  string `json:"workspace_name,omitempty"`
	BaseSnapshotID string `json:"base_snapshot_id,omitempty"`
	// Deprecated: legacy field for backwards compatibility.
	ForkSnapshotID    string `json:"fork_snapshot_id,omitempty"`
	CurrentSnapshotID string `json:"current_snapshot_id,omitempty"`
	APIURL            string `json:"api_url,omitempty"`
	Mode              string `json:"mode,omitempty"` // "cloud" or "local"
}

// isWorkspaceRoot checks if dir contains a .fst/config.json with type "workspace".
func isWorkspaceRoot(dir string) bool {
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
	return header.Type == ConfigTypeWorkspace
}

// FindWorkspaceRoot walks up the directory tree to find a workspace root (.fst/config.json with type "workspace")
func FindWorkspaceRoot() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		if isWorkspaceRoot(dir) {
			return dir, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("not in a fst project (no .fst found)")
		}
		dir = parent
	}
}

// GetConfigDir returns the .fst directory path for the current workspace
func GetConfigDir() (string, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return "", err
	}
	return filepath.Join(root, ConfigDirName), nil
}

// Load reads the project configuration from .fst/config.json
func Load() (*WorkspaceConfig, error) {
	root, err := FindWorkspaceRoot()
	if err != nil {
		return nil, err
	}

	configPath := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var config WorkspaceConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	normalizeConfig(&config)
	if config.CurrentSnapshotID == "" {
		if latest, err := GetLatestSnapshotIDForWorkspaceAt(root, config.WorkspaceID); err == nil && latest != "" {
			config.CurrentSnapshotID = latest
		}
	}

	return &config, nil
}

func normalizeConfig(config *WorkspaceConfig) {
	if config == nil {
		return
	}
	if config.Type == "" {
		config.Type = ConfigTypeWorkspace
	}
	if config.BaseSnapshotID == "" && config.ForkSnapshotID != "" {
		config.BaseSnapshotID = config.ForkSnapshotID
	}
	if config.ForkSnapshotID != "" {
		config.ForkSnapshotID = ""
	}
}

// LoadAt reads the project configuration from a specific workspace root
func LoadAt(root string) (*WorkspaceConfig, error) {
	configPath := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var config WorkspaceConfig
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, fmt.Errorf("failed to parse config: %w", err)
	}

	normalizeConfig(&config)
	if config.CurrentSnapshotID == "" {
		if latest, err := GetLatestSnapshotIDForWorkspaceAt(root, config.WorkspaceID); err == nil && latest != "" {
			config.CurrentSnapshotID = latest
		}
	}

	return &config, nil
}

// Save writes the project configuration to .fst/config.json
func Save(config *WorkspaceConfig) error {
	root, err := FindWorkspaceRoot()
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

	if config != nil {
		normalizeConfig(config)
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, ConfigFileName)
	if err := store.AtomicWriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	return nil
}

// SaveAt writes the project configuration to a specific workspace root
func SaveAt(root string, config *WorkspaceConfig) error {
	configDir := filepath.Join(root, ConfigDirName)
	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	if config != nil {
		normalizeConfig(config)
	}
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, ConfigFileName)
	if err := store.AtomicWriteFile(configPath, data, 0644); err != nil {
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
func InitAt(root, projectID, workspaceID, workspaceName, baseSnapshotID string) error {
	configDir := filepath.Join(root, ConfigDirName)

	// Check if already initialized
	if _, err := os.Stat(configDir); err == nil {
		return fmt.Errorf("already initialized: %s exists", configDir)
	}

	if err := os.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("failed to create config directory: %w", err)
	}

	// If under a project, ensure the shared store exists at the project level
	// and skip creating workspace-local snapshot/manifest/blob dirs.
	if projectRoot, _, err := FindProjectRootFrom(root); err == nil {
		sharedConfigDir := filepath.Join(projectRoot, ConfigDirName)
		if err := os.MkdirAll(filepath.Join(sharedConfigDir, SnapshotsDirName), 0755); err != nil {
			return fmt.Errorf("failed to create shared snapshots directory: %w", err)
		}
		if err := os.MkdirAll(filepath.Join(sharedConfigDir, ManifestsDirName), 0755); err != nil {
			return fmt.Errorf("failed to create shared manifests directory: %w", err)
		}
		if err := os.MkdirAll(filepath.Join(sharedConfigDir, BlobsDirName), 0755); err != nil {
			return fmt.Errorf("failed to create shared blobs directory: %w", err)
		}
		// Write .gitignore for the project-level .fst/ if not already present
		gitignorePath := filepath.Join(sharedConfigDir, ".gitignore")
		if _, err := os.Stat(gitignorePath); os.IsNotExist(err) {
			gitignore := "# Fastest shared data\nsnapshots/\nmanifests/\nblobs/\n*.log\nstat-cache.json\n"
			_ = os.WriteFile(gitignorePath, []byte(gitignore), 0644)
		}
	} else {
		// Standalone workspace: create local snapshots, manifests, and blobs dirs
		snapshotsDir := filepath.Join(configDir, SnapshotsDirName)
		if err := os.MkdirAll(snapshotsDir, 0755); err != nil {
			return fmt.Errorf("failed to create snapshots directory: %w", err)
		}

		manifestsDir := filepath.Join(configDir, ManifestsDirName)
		if err := os.MkdirAll(manifestsDir, 0755); err != nil {
			return fmt.Errorf("failed to create manifests directory: %w", err)
		}

		blobsDir := filepath.Join(configDir, BlobsDirName)
		if err := os.MkdirAll(blobsDir, 0755); err != nil {
			return fmt.Errorf("failed to create blobs directory: %w", err)
		}
	}

	config := &WorkspaceConfig{
		Type:              ConfigTypeWorkspace,
		ProjectID:         projectID,
		WorkspaceID:       workspaceID,
		WorkspaceName:     workspaceName,
		BaseSnapshotID:    baseSnapshotID,
		CurrentSnapshotID: baseSnapshotID,
		Mode:              "local",
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal config: %w", err)
	}

	configPath := filepath.Join(configDir, ConfigFileName)
	if err := store.AtomicWriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Create .gitignore for .fst directory
	gitignore := `# Fastest local data
snapshots/
manifests/
blobs/
*.log
merge-parents.json
stat-cache.json
`
	gitignorePath := filepath.Join(configDir, ".gitignore")
	if err := os.WriteFile(gitignorePath, []byte(gitignore), 0644); err != nil {
		return fmt.Errorf("failed to write .gitignore: %w", err)
	}

	// Create .fstignore in workspace root if missing
	fstignorePath := filepath.Join(root, ".fstignore")
	if _, err := os.Stat(fstignorePath); os.IsNotExist(err) {
		if err := os.WriteFile(fstignorePath, []byte(ignore.DefaultFileContents()), 0644); err != nil {
			return fmt.Errorf("failed to write .fstignore: %w", err)
		}
	} else if err != nil {
		return fmt.Errorf("failed to check .fstignore: %w", err)
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
	_, err := FindWorkspaceRoot()
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

// MigrateToSharedStore moves snapshot metadata and manifests from a workspace-local
// .fst/ directory to the project-level shared store. Files that already exist in
// the shared store are skipped (content-addressed manifests naturally deduplicate).
func MigrateToSharedStore(workspaceRoot string) error {
	projectRoot, _, err := FindProjectRootFrom(workspaceRoot)
	if err != nil {
		return err
	}

	localSnaps := GetWorkspaceLocalSnapshotsDirAt(workspaceRoot)
	sharedSnaps := filepath.Join(projectRoot, ConfigDirName, SnapshotsDirName)
	localManifests := GetWorkspaceLocalManifestsDirAt(workspaceRoot)
	sharedManifests := filepath.Join(projectRoot, ConfigDirName, ManifestsDirName)
	localBlobs := GetWorkspaceLocalBlobsDirAt(workspaceRoot)
	sharedBlobs := filepath.Join(projectRoot, ConfigDirName, BlobsDirName)

	if err := os.MkdirAll(sharedSnaps, 0755); err != nil {
		return fmt.Errorf("failed to create shared snapshots directory: %w", err)
	}
	if err := os.MkdirAll(sharedManifests, 0755); err != nil {
		return fmt.Errorf("failed to create shared manifests directory: %w", err)
	}
	if err := os.MkdirAll(sharedBlobs, 0755); err != nil {
		return fmt.Errorf("failed to create shared blobs directory: %w", err)
	}

	migrateFiles(localSnaps, sharedSnaps)
	migrateFiles(localManifests, sharedManifests)
	migrateFiles(localBlobs, sharedBlobs)
	return nil
}

// migrateFiles moves files from src to dst directory. Skips if destination already exists.
func migrateFiles(src, dst string) {
	entries, err := os.ReadDir(src)
	if err != nil {
		return
	}
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		srcPath := filepath.Join(src, entry.Name())
		dstPath := filepath.Join(dst, entry.Name())
		if _, err := os.Stat(dstPath); err == nil {
			// Already exists in shared store, remove local copy
			_ = os.Remove(srcPath)
			continue
		}
		if err := os.Rename(srcPath, dstPath); err != nil {
			// If rename fails (cross-device), fall back to copy+remove
			if data, readErr := os.ReadFile(srcPath); readErr == nil {
				if writeErr := os.WriteFile(dstPath, data, 0644); writeErr == nil {
					_ = os.Remove(srcPath)
				}
			}
		}
	}
}
