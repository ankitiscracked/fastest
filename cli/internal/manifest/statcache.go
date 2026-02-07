package manifest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// StatCache accelerates manifest generation by skipping SHA-256 hashing for
// files whose stat metadata (mtime, size, mode, inode) hasn't changed since
// the last check. Modeled after Git's index stat cache.
type StatCache struct {
	WrittenAt int64                      `json:"written_at"` // UnixNano when cache was last saved
	Entries   map[string]StatCacheEntry  `json:"entries"`
}

// StatCacheEntry records the stat metadata and content hash for a single file.
type StatCacheEntry struct {
	ModTime int64  `json:"mtime"` // UnixNano
	Size    int64  `json:"size"`
	Mode    uint32 `json:"mode"`
	Ino     uint64 `json:"ino"`
	Hash    string `json:"hash"`
}

// LoadStatCache reads a stat cache from disk. Returns an empty cache if the
// file is missing or corrupt.
func LoadStatCache(path string) *StatCache {
	data, err := os.ReadFile(path)
	if err != nil {
		return &StatCache{Entries: make(map[string]StatCacheEntry)}
	}
	var c StatCache
	if err := json.Unmarshal(data, &c); err != nil {
		return &StatCache{Entries: make(map[string]StatCacheEntry)}
	}
	if c.Entries == nil {
		c.Entries = make(map[string]StatCacheEntry)
	}
	return &c
}

// Save writes the stat cache to disk. Errors are silently ignored — the cache
// is best-effort and the system works correctly without it.
func (c *StatCache) Save(path string) {
	c.WrittenAt = time.Now().UnixNano()
	data, err := json.Marshal(c)
	if err != nil {
		return
	}
	_ = os.WriteFile(path, data, 0644)
}

// Lookup checks whether a file's stat metadata matches the cached entry.
// Returns the cached hash on a hit, empty string on a miss.
//
// The lookup follows Git's stat cache algorithm:
//  1. Entry missing → miss
//  2. Size, mode, or inode differs → miss
//  3. Mtime differs → miss
//  4. Mtime >= cache WrittenAt → "racily clean", force miss
//  5. All match and mtime < WrittenAt → hit
func (c *StatCache) Lookup(relPath string, info os.FileInfo) string {
	entry, ok := c.Entries[relPath]
	if !ok {
		return ""
	}

	mtime := info.ModTime().UnixNano()
	mode := uint32(info.Mode().Perm())
	ino := fileIno(info)

	if entry.Size != info.Size() || entry.Mode != mode || entry.Ino != ino {
		return ""
	}
	if entry.ModTime != mtime {
		return ""
	}
	// Racily clean: file mtime matches but is >= cache write time, so the file
	// may have been modified in the same timestamp quantum as the cache write.
	if mtime >= c.WrittenAt {
		return ""
	}
	return entry.Hash
}

// Update records a file's current stat metadata and hash in the cache.
func (c *StatCache) Update(relPath string, info os.FileInfo, hash string) {
	c.Entries[relPath] = StatCacheEntry{
		ModTime: info.ModTime().UnixNano(),
		Size:    info.Size(),
		Mode:    uint32(info.Mode().Perm()),
		Ino:     fileIno(info),
		Hash:    hash,
	}
}

// GenerateWithCache creates a manifest using stat-cache-accelerated hashing.
// Files whose mtime, size, mode, and inode match the cache skip SHA-256
// hashing. The cache is loaded from cachePath at the start and written back
// at the end. If cachePath is empty, this behaves identically to Generate.
func GenerateWithCache(root string, cachePath string) (*Manifest, error) {
	if cachePath == "" {
		return Generate(root, false)
	}

	cache := LoadStatCache(cachePath)

	m, err := generateWith(root, func(absPath, relPath string, info os.FileInfo) (string, error) {
		if h := cache.Lookup(relPath, info); h != "" {
			return h, nil
		}
		h, err := HashFile(absPath)
		if err != nil {
			return "", err
		}
		cache.Update(relPath, info, h)
		return h, nil
	})
	if err != nil {
		return nil, err
	}

	// Prune cache entries for files no longer in the manifest.
	present := make(map[string]struct{}, len(m.Files))
	for _, f := range m.Files {
		if f.Type == EntryTypeFile {
			present[f.Path] = struct{}{}
		}
	}
	for k := range cache.Entries {
		if _, ok := present[k]; !ok {
			delete(cache.Entries, k)
		}
	}

	cache.Save(cachePath)
	return m, nil
}

// BuildStatCacheFromManifest populates a stat cache from a freshly-generated
// manifest. Call this after snapshot creation (which does full hashing) so that
// subsequent status/drift checks can benefit from the cache immediately.
func BuildStatCacheFromManifest(root string, m *Manifest, cachePath string) {
	if cachePath == "" {
		return
	}
	cache := &StatCache{Entries: make(map[string]StatCacheEntry)}
	for _, f := range m.Files {
		if f.Type != EntryTypeFile {
			continue
		}
		absPath := filepath.Join(root, filepath.FromSlash(f.Path))
		info, err := os.Stat(absPath)
		if err != nil {
			continue
		}
		cache.Update(f.Path, info, f.Hash)
	}
	cache.Save(cachePath)
}

// fileIno extracts the inode number from os.FileInfo via the underlying
// syscall.Stat_t. Returns 0 if the platform doesn't support it.
func fileIno(info os.FileInfo) uint64 {
	if sys, ok := info.Sys().(*syscall.Stat_t); ok {
		return sys.Ino
	}
	return 0
}
