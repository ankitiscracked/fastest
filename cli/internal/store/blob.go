package store

import (
	"fmt"
	"os"
	"path/filepath"
)

// ReadBlob reads a blob's content by its hash.
func (s *Store) ReadBlob(hash string) ([]byte, error) {
	if hash == "" {
		return nil, fmt.Errorf("empty blob hash")
	}
	path := filepath.Join(s.blobsDir, hash)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("blob not found: %w", err)
	}
	return data, nil
}

// WriteBlob writes content to the blob store under the given hash.
// Skips writing if the blob already exists (content-addressed).
func (s *Store) WriteBlob(hash string, content []byte) error {
	if hash == "" {
		return fmt.Errorf("empty blob hash")
	}
	path := filepath.Join(s.blobsDir, hash)
	if _, err := os.Stat(path); err == nil {
		return nil // already exists
	}
	return os.WriteFile(path, content, 0644)
}

// BlobExists checks if a blob with the given hash exists.
func (s *Store) BlobExists(hash string) bool {
	path := filepath.Join(s.blobsDir, hash)
	_, err := os.Stat(path)
	return err == nil
}

// BlobPath returns the filesystem path for a blob by its hash.
func (s *Store) BlobPath(hash string) string {
	return filepath.Join(s.blobsDir, hash)
}
