package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/anthropics/fastest/cli/internal/ignore"
)

const (
	ConfigDirName    = ".fst"
	ConfigFileName   = "config.json"
	SnapshotsDirName = "snapshots"
	ManifestsDirName = "manifests"
	BlobsDirName     = "blobs"
)

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
// If the workspace is under a project (fst.json), returns the shared project-level directory.
func GetSnapshotsDir() (string, error) {
	root, err := FindProjectRoot()
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
// If the workspace is under a project (fst.json), returns the shared project-level directory.
func GetManifestsDir() (string, error) {
	root, err := FindProjectRoot()
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
// If the workspace is under a project (fst.json), returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetSnapshotsDirAt(root string) string {
	if projectRoot, _, err := FindParentRootFrom(root); err == nil {
		return filepath.Join(projectRoot, ConfigDirName, SnapshotsDirName)
	}
	return filepath.Join(root, ConfigDirName, SnapshotsDirName)
}

// GetManifestsDirAt returns the manifests directory for a specific workspace root.
// If the workspace is under a project (fst.json), returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetManifestsDirAt(root string) string {
	if projectRoot, _, err := FindParentRootFrom(root); err == nil {
		return filepath.Join(projectRoot, ConfigDirName, ManifestsDirName)
	}
	return filepath.Join(root, ConfigDirName, ManifestsDirName)
}

// GetBlobsDir returns the blobs directory for the current workspace.
// If the workspace is under a project (fst.json), returns the shared project-level directory.
func GetBlobsDir() (string, error) {
	root, err := FindProjectRoot()
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
// If the workspace is under a project (fst.json), returns the shared project-level directory.
// For standalone workspaces, returns the workspace-local directory.
func GetBlobsDirAt(root string) string {
	if projectRoot, _, err := FindParentRootFrom(root); err == nil {
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

// ManifestHashFromSnapshotID resolves a snapshot ID to its manifest hash using local metadata.
func ManifestHashFromSnapshotID(snapshotID string) (string, error) {
	root, err := FindProjectRoot()
	if err != nil {
		return "", err
	}
	return ManifestHashFromSnapshotIDAt(root, snapshotID)
}

// ManifestHashFromSnapshotIDAt resolves a snapshot ID to its manifest hash for a specific workspace root.
func ManifestHashFromSnapshotIDAt(root, snapshotID string) (string, error) {
	if snapshotID == "" {
		return "", fmt.Errorf("empty snapshot ID")
	}

	snapshotsDir := GetSnapshotsDirAt(root)
	metaPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	if data, err := os.ReadFile(metaPath); err == nil {
		var meta SnapshotMeta
		if err := json.Unmarshal(data, &meta); err == nil && meta.ManifestHash != "" {
			if IsContentAddressedSnapshotID(snapshotID) {
				if !VerifySnapshotID(snapshotID, meta.ManifestHash, meta.ParentSnapshotIDs, meta.AuthorName, meta.AuthorEmail, meta.CreatedAt) {
					return "", fmt.Errorf("snapshot integrity check failed for %s: ID does not match content", snapshotID)
				}
			}
			return meta.ManifestHash, nil
		}
	}

	// Fallback for legacy snapshot IDs that embedded the manifest hash.
	const prefix = "snap-"
	if strings.HasPrefix(snapshotID, prefix) {
		legacy := strings.TrimPrefix(snapshotID, prefix)
		if len(legacy) == 64 {
			return legacy, nil
		}
		if resolved, err := ResolveSnapshotIDAt(root, snapshotID); err == nil && resolved != snapshotID {
			metaPath = filepath.Join(snapshotsDir, resolved+".meta.json")
			if data, err := os.ReadFile(metaPath); err == nil {
				var meta SnapshotMeta
				if err := json.Unmarshal(data, &meta); err == nil && meta.ManifestHash != "" {
					return meta.ManifestHash, nil
				}
			}
		} else if err != nil && strings.Contains(err.Error(), "ambiguous") {
			return "", err
		}
	}

	return "", fmt.Errorf("snapshot metadata not found for: %s", snapshotID)
}

// ResolveSnapshotIDAt resolves a snapshot prefix to a full ID for a specific workspace root.
func ResolveSnapshotIDAt(root, snapshotID string) (string, error) {
	if snapshotID == "" {
		return "", fmt.Errorf("empty snapshot ID")
	}

	snapshotsDir := GetSnapshotsDirAt(root)
	entries, err := os.ReadDir(snapshotsDir)
	if err != nil {
		return "", err
	}

	matches := make([]string, 0, 4)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		id := strings.TrimSuffix(name, ".meta.json")
		if strings.HasPrefix(id, snapshotID) {
			matches = append(matches, id)
		}
	}

	if len(matches) == 1 {
		return matches[0], nil
	}
	if len(matches) == 0 {
		return "", fmt.Errorf("snapshot %q not found", snapshotID)
	}
	sort.Strings(matches)
	return "", fmt.Errorf("snapshot %q is ambiguous: %s", snapshotID, strings.Join(matches, ", "))
}

// SnapshotMeta represents snapshot metadata
type SnapshotMeta struct {
	ID                string   `json:"id"`
	WorkspaceID       string   `json:"workspace_id"`
	CreatedAt         string   `json:"created_at"`
	ManifestHash      string   `json:"manifest_hash"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	AuthorName        string   `json:"author_name"`
	AuthorEmail       string   `json:"author_email"`
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

// GetLatestSnapshotIDForWorkspaceAt returns the most recent snapshot ID for a specific
// workspace, filtering by workspace_id. This is needed when using a shared project-level
// snapshot store where multiple workspaces' snapshots coexist.
func GetLatestSnapshotIDForWorkspaceAt(root string, workspaceID string) (string, error) {
	if workspaceID == "" {
		return GetLatestSnapshotIDAt(root)
	}

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

			if meta.WorkspaceID != workspaceID {
				continue
			}

			if meta.CreatedAt > latestTime {
				latestTime = meta.CreatedAt
				latestID = meta.ID
			}
		}
	}

	return latestID, nil
}

// ProjectConfig represents the local project configuration stored in .fst/config.json
// All workspaces are peers - there is no main/linked distinction
type ProjectConfig struct {
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

	var config ProjectConfig
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

func normalizeConfig(config *ProjectConfig) {
	if config == nil {
		return
	}
	if config.BaseSnapshotID == "" && config.ForkSnapshotID != "" {
		config.BaseSnapshotID = config.ForkSnapshotID
	}
	if config.ForkSnapshotID != "" {
		config.ForkSnapshotID = ""
	}
}

// LoadAt reads the project configuration from a specific workspace root
func LoadAt(root string) (*ProjectConfig, error) {
	configPath := filepath.Join(root, ConfigDirName, ConfigFileName)
	data, err := os.ReadFile(configPath)
	if err != nil {
		return nil, fmt.Errorf("failed to read config: %w", err)
	}

	var config ProjectConfig
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

	if config != nil {
		normalizeConfig(config)
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

	if config != nil {
		normalizeConfig(config)
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
	if projectRoot, _, err := FindParentRootFrom(root); err == nil {
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
			gitignore := "# Fastest shared data\nsnapshots/\nmanifests/\nblobs/\n*.log\n"
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

	config := &ProjectConfig{
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
	if err := os.WriteFile(configPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write config: %w", err)
	}

	// Create .gitignore for .fst directory
	gitignore := `# Fastest local data
snapshots/
manifests/
blobs/
*.log
merge-parents.json
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

// MigrateToSharedStore moves snapshot metadata and manifests from a workspace-local
// .fst/ directory to the project-level shared store. Files that already exist in
// the shared store are skipped (content-addressed manifests naturally deduplicate).
func MigrateToSharedStore(workspaceRoot string) error {
	projectRoot, _, err := FindParentRootFrom(workspaceRoot)
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
