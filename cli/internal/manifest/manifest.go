package manifest

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"sort"

	"github.com/anthropics/fastest/cli/internal/ignore"
)

const (
	EntryTypeFile    = "file"
	EntryTypeDir     = "dir"
	EntryTypeSymlink = "symlink"
)

// FileEntry represents a single entry in the manifest
type FileEntry struct {
	Type    string `json:"type"`
	Path    string `json:"path"`
	Hash    string `json:"hash,omitempty"`
	Size    int64  `json:"size,omitempty"`
	Mode    uint32 `json:"mode,omitempty"`
	ModTime int64  `json:"mod_time,omitempty"` // Unix timestamp, optional for reproducibility
	Target  string `json:"target,omitempty"`   // symlink target
}

// Manifest represents a complete project snapshot
type Manifest struct {
	Version string      `json:"version"`
	Files   []FileEntry `json:"files"`
}

// HashFile computes the SHA-256 hash of a file
func HashFile(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// Generate creates a manifest for a directory
func Generate(root string, includeModTime bool) (*Manifest, error) {
	// Load ignore patterns
	matcher, err := ignore.LoadFromDir(root)
	if err != nil {
		return nil, err
	}

	manifest := &Manifest{
		Version: "1",
		Files:   []FileEntry{},
	}

	err = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Get relative path
		relPath, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}

		// Skip root
		if relPath == "." {
			return nil
		}

		// Normalize to forward slashes
		relPath = filepath.ToSlash(relPath)

		// Check if should be ignored
		if matcher.Match(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			entry := FileEntry{
				Type:   EntryTypeSymlink,
				Path:   relPath,
				Target: target,
			}
			if includeModTime {
				entry.ModTime = info.ModTime().Unix()
			}
			manifest.Files = append(manifest.Files, entry)
			return nil
		}

		if info.IsDir() {
			entry := FileEntry{
				Type: EntryTypeDir,
				Path: relPath,
				Mode: uint32(info.Mode().Perm()),
			}
			if includeModTime {
				entry.ModTime = info.ModTime().Unix()
			}
			manifest.Files = append(manifest.Files, entry)
			return nil
		}

		// Compute hash
		hash, err := HashFile(path)
		if err != nil {
			return err
		}

		entry := FileEntry{
			Type: EntryTypeFile,
			Path: relPath,
			Hash: hash,
			Size: info.Size(),
			Mode: uint32(info.Mode().Perm()),
		}

		if includeModTime {
			entry.ModTime = info.ModTime().Unix()
		}

		manifest.Files = append(manifest.Files, entry)
		return nil
	})

	if err != nil {
		return nil, err
	}

	// Sort files for reproducibility
	sort.Slice(manifest.Files, func(i, j int) bool {
		if manifest.Files[i].Path == manifest.Files[j].Path {
			return manifest.Files[i].Type < manifest.Files[j].Type
		}
		return manifest.Files[i].Path < manifest.Files[j].Path
	})

	return manifest, nil
}

// ToJSON converts the manifest to canonical JSON
func (m *Manifest) ToJSON() ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}

// Hash computes the SHA-256 hash of the manifest
func (m *Manifest) Hash() (string, error) {
	data, err := m.ToJSON()
	if err != nil {
		return "", err
	}

	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]), nil
}

// FromJSON parses a manifest from JSON
func FromJSON(data []byte) (*Manifest, error) {
	var m Manifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// Diff compares two manifests and returns the differences
func Diff(base, current *Manifest) (added, modified, deleted []string) {
	baseMap := make(map[string]FileEntry)
	for _, f := range base.Files {
		baseMap[f.Path] = f
	}

	currentMap := make(map[string]FileEntry)
	for _, f := range current.Files {
		currentMap[f.Path] = f
	}

	// Find added and modified files
	for _, f := range current.Files {
		if baseFile, exists := baseMap[f.Path]; !exists {
			added = append(added, f.Path)
		} else if !entriesEqual(baseFile, f) {
			modified = append(modified, f.Path)
		}
	}

	// Find deleted files
	for _, f := range base.Files {
		if _, exists := currentMap[f.Path]; !exists {
			deleted = append(deleted, f.Path)
		}
	}

	sort.Strings(added)
	sort.Strings(modified)
	sort.Strings(deleted)

	return added, modified, deleted
}

func entriesEqual(a, b FileEntry) bool {
	if a.Type != b.Type {
		return false
	}
	switch a.Type {
	case EntryTypeFile:
		return a.Hash == b.Hash && a.Mode == b.Mode
	case EntryTypeSymlink:
		return a.Target == b.Target
	case EntryTypeDir:
		return a.Mode == b.Mode
	default:
		return a.Hash == b.Hash && a.Target == b.Target && a.Mode == b.Mode
	}
}

func (m *Manifest) FileEntries() []FileEntry {
	files := make([]FileEntry, 0, len(m.Files))
	for _, f := range m.Files {
		if f.Type == EntryTypeFile {
			files = append(files, f)
		}
	}
	return files
}

func (m *Manifest) DirEntries() []FileEntry {
	dirs := make([]FileEntry, 0, len(m.Files))
	for _, f := range m.Files {
		if f.Type == EntryTypeDir {
			dirs = append(dirs, f)
		}
	}
	return dirs
}

func (m *Manifest) SymlinkEntries() []FileEntry {
	links := make([]FileEntry, 0, len(m.Files))
	for _, f := range m.Files {
		if f.Type == EntryTypeSymlink {
			links = append(links, f)
		}
	}
	return links
}

// TotalSize returns the total size of all files in the manifest
func (m *Manifest) TotalSize() int64 {
	var total int64
	for _, f := range m.Files {
		if f.Type == EntryTypeFile {
			total += f.Size
		}
	}
	return total
}

// FileCount returns the number of files in the manifest
func (m *Manifest) FileCount() int {
	count := 0
	for _, f := range m.Files {
		if f.Type == EntryTypeFile {
			count++
		}
	}
	return count
}
