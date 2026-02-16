package store

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/ankitiscracked/fastest/cli/internal/manifest"
)

// LoadManifest reads and parses a manifest by its content hash.
func (s *Store) LoadManifest(hash string) (*manifest.Manifest, error) {
	data, err := s.LoadManifestJSON(hash)
	if err != nil {
		return nil, err
	}
	return manifest.FromJSON(data)
}

// LoadManifestJSON reads the raw JSON bytes of a manifest by its content hash.
func (s *Store) LoadManifestJSON(hash string) ([]byte, error) {
	if hash == "" {
		return nil, fmt.Errorf("empty manifest hash")
	}
	path := filepath.Join(s.manifestsDir, hash+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("manifest not found: %w", err)
	}
	return data, nil
}

// WriteManifest serializes a manifest and writes it to the store.
// Returns the content hash used as the filename.
func (s *Store) WriteManifest(m *manifest.Manifest) (string, error) {
	hash, err := m.Hash()
	if err != nil {
		return "", fmt.Errorf("failed to compute manifest hash: %w", err)
	}

	path := filepath.Join(s.manifestsDir, hash+".json")
	// Skip if already exists (content-addressed)
	if _, err := os.Stat(path); err == nil {
		return hash, nil
	}

	data, err := m.ToJSON()
	if err != nil {
		return "", fmt.Errorf("failed to serialize manifest: %w", err)
	}

	if err := AtomicWriteFile(path, data, 0644); err != nil {
		return "", fmt.Errorf("failed to write manifest: %w", err)
	}
	return hash, nil
}

// ManifestExists checks if a manifest with the given hash exists.
func (s *Store) ManifestExists(hash string) bool {
	path := filepath.Join(s.manifestsDir, hash+".json")
	_, err := os.Stat(path)
	return err == nil
}
