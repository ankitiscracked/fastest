package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	configDirName  = ".fst"
	snapshotsDirName = "snapshots"
	manifestsDirName = "manifests"
	blobsDirName     = "blobs"
)

// Store provides typed access to the project-level shared store
// (snapshots, manifests, blobs). Multiple workspaces under the same
// project share a single Store.
type Store struct {
	root         string
	snapshotsDir string
	manifestsDir string
	blobsDir     string
}

// OpenAt creates a Store rooted at the given project root directory.
func OpenAt(projectRoot string) *Store {
	base := filepath.Join(projectRoot, configDirName)
	return &Store{
		root:         projectRoot,
		snapshotsDir: filepath.Join(base, snapshotsDirName),
		manifestsDir: filepath.Join(base, manifestsDirName),
		blobsDir:     filepath.Join(base, blobsDirName),
	}
}

// OpenFromWorkspace creates a Store by walking up from a workspace root
// to find the project root (.fst/config.json with type "project").
// If no parent project is found, the workspace root itself is treated
// as the project root (standalone mode).
func OpenFromWorkspace(workspaceRoot string) *Store {
	if projectRoot, err := findProjectRoot(workspaceRoot); err == nil {
		return OpenAt(projectRoot)
	}
	return OpenAt(workspaceRoot)
}

// Root returns the project root directory.
func (s *Store) Root() string { return s.root }

// SnapshotsDir returns the path to the snapshots directory.
func (s *Store) SnapshotsDir() string { return s.snapshotsDir }

// ManifestsDir returns the path to the manifests directory.
func (s *Store) ManifestsDir() string { return s.manifestsDir }

// BlobsDir returns the path to the blobs directory.
func (s *Store) BlobsDir() string { return s.blobsDir }

// EnsureDirs creates the snapshots, manifests, and blobs directories if they
// don't exist.
func (s *Store) EnsureDirs() error {
	for _, dir := range []string{s.snapshotsDir, s.manifestsDir, s.blobsDir} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}
	return nil
}

// isProjectConfig checks if dir contains a .fst/config.json with type "project".
func isProjectConfig(dir string) bool {
	data, err := os.ReadFile(filepath.Join(dir, configDirName, "config.json"))
	if err != nil {
		return false
	}
	var header struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(data, &header); err != nil {
		return false
	}
	return header.Type == "project"
}

// findProjectRoot walks up from start looking for a project root
// (.fst/config.json with type "project").
func findProjectRoot(start string) (string, error) {
	dir := start
	for {
		if isProjectConfig(dir) {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("project root not found")
		}
		dir = parent
	}
}
