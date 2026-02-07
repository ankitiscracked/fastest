package manifest

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStatCacheLookupHit(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)

	info, _ := os.Stat(f)

	cache := &StatCache{
		WrittenAt: time.Now().Add(time.Second).UnixNano(), // future → not racily clean
		Entries:   make(map[string]StatCacheEntry),
	}
	cache.Update("file.txt", info, "abc123")

	got := cache.Lookup("file.txt", info)
	if got != "abc123" {
		t.Fatalf("expected cache hit, got %q", got)
	}
}

func TestStatCacheLookupMissModTime(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info1, _ := os.Stat(f)

	cache := &StatCache{
		WrittenAt: time.Now().Add(time.Second).UnixNano(),
		Entries:   make(map[string]StatCacheEntry),
	}
	cache.Update("file.txt", info1, "abc123")

	// Modify file to change mtime
	time.Sleep(10 * time.Millisecond)
	os.WriteFile(f, []byte("hello"), 0644)
	info2, _ := os.Stat(f)

	got := cache.Lookup("file.txt", info2)
	if got != "" {
		t.Fatalf("expected cache miss on mtime change, got %q", got)
	}
}

func TestStatCacheLookupMissSize(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info, _ := os.Stat(f)

	cache := &StatCache{
		WrittenAt: time.Now().Add(time.Second).UnixNano(),
		Entries:   make(map[string]StatCacheEntry),
	}
	cache.Update("file.txt", info, "abc123")

	// Change size in the entry to simulate mismatch
	entry := cache.Entries["file.txt"]
	entry.Size = 999
	cache.Entries["file.txt"] = entry

	got := cache.Lookup("file.txt", info)
	if got != "" {
		t.Fatalf("expected cache miss on size change, got %q", got)
	}
}

func TestStatCacheLookupMissInode(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info, _ := os.Stat(f)

	cache := &StatCache{
		WrittenAt: time.Now().Add(time.Second).UnixNano(),
		Entries:   make(map[string]StatCacheEntry),
	}
	cache.Update("file.txt", info, "abc123")

	// Change inode in the entry to simulate file replacement
	entry := cache.Entries["file.txt"]
	entry.Ino = entry.Ino + 1
	cache.Entries["file.txt"] = entry

	got := cache.Lookup("file.txt", info)
	if got != "" {
		t.Fatalf("expected cache miss on inode change, got %q", got)
	}
}

func TestStatCacheLookupMissNotPresent(t *testing.T) {
	cache := &StatCache{
		WrittenAt: time.Now().UnixNano(),
		Entries:   make(map[string]StatCacheEntry),
	}

	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info, _ := os.Stat(f)

	got := cache.Lookup("file.txt", info)
	if got != "" {
		t.Fatalf("expected cache miss for absent entry, got %q", got)
	}
}

func TestStatCacheRacilyClean(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info, _ := os.Stat(f)

	// Set WrittenAt to before the file's mtime → racily clean
	cache := &StatCache{
		WrittenAt: info.ModTime().UnixNano() - 1,
		Entries:   make(map[string]StatCacheEntry),
	}
	cache.Update("file.txt", info, "abc123")

	got := cache.Lookup("file.txt", info)
	if got != "" {
		t.Fatalf("expected cache miss for racily clean file, got %q", got)
	}
}

func TestStatCacheSaveLoad(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, "stat-cache.json")

	f := filepath.Join(dir, "file.txt")
	os.WriteFile(f, []byte("hello"), 0644)
	info, _ := os.Stat(f)

	cache := &StatCache{Entries: make(map[string]StatCacheEntry)}
	cache.Update("file.txt", info, "somehash")
	cache.Save(cachePath)

	loaded := LoadStatCache(cachePath)
	if loaded.WrittenAt == 0 {
		t.Fatalf("expected non-zero WrittenAt after Save")
	}
	entry, ok := loaded.Entries["file.txt"]
	if !ok {
		t.Fatalf("expected entry for file.txt")
	}
	if entry.Hash != "somehash" {
		t.Fatalf("expected hash 'somehash', got %q", entry.Hash)
	}
}

func TestStatCacheCorrupt(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, "stat-cache.json")
	os.WriteFile(cachePath, []byte("not valid json{{{"), 0644)

	cache := LoadStatCache(cachePath)
	if len(cache.Entries) != 0 {
		t.Fatalf("expected empty cache from corrupt file, got %d entries", len(cache.Entries))
	}
}

func TestStatCacheMissing(t *testing.T) {
	cache := LoadStatCache("/nonexistent/path/stat-cache.json")
	if len(cache.Entries) != 0 {
		t.Fatalf("expected empty cache from missing file, got %d entries", len(cache.Entries))
	}
}

func TestGenerateWithCacheIdenticalOutput(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, ".fst", "stat-cache.json")
	os.MkdirAll(filepath.Join(dir, ".fst"), 0755)

	// Create some files
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("aaa"), 0644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0755)
	os.WriteFile(filepath.Join(dir, "sub", "b.txt"), []byte("bbb"), 0644)

	// Generate without cache
	m1, err := Generate(dir, false)
	if err != nil {
		t.Fatalf("Generate: %v", err)
	}

	// Generate with cache (first run, all misses)
	m2, err := GenerateWithCache(dir, cachePath)
	if err != nil {
		t.Fatalf("GenerateWithCache (cold): %v", err)
	}

	j1, _ := m1.ToJSON()
	j2, _ := m2.ToJSON()
	if string(j1) != string(j2) {
		t.Fatalf("cold cache manifest differs from uncached manifest:\n%s\nvs\n%s", j1, j2)
	}

	// Generate with cache again (should be all hits)
	// Need to wait so file mtimes are < WrittenAt for cache hits
	time.Sleep(20 * time.Millisecond)
	m3, err := GenerateWithCache(dir, cachePath)
	if err != nil {
		t.Fatalf("GenerateWithCache (warm): %v", err)
	}

	j3, _ := m3.ToJSON()
	if string(j1) != string(j3) {
		t.Fatalf("warm cache manifest differs from uncached manifest:\n%s\nvs\n%s", j1, j3)
	}
}

func TestGenerateWithCacheReHashesOnChange(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, ".fst", "stat-cache.json")
	os.MkdirAll(filepath.Join(dir, ".fst"), 0755)

	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("original"), 0644)

	// Prime the cache
	m1, err := GenerateWithCache(dir, cachePath)
	if err != nil {
		t.Fatalf("GenerateWithCache: %v", err)
	}

	// Modify the file
	time.Sleep(20 * time.Millisecond)
	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("modified"), 0644)

	// Wait so new mtime is established
	time.Sleep(20 * time.Millisecond)

	m2, err := GenerateWithCache(dir, cachePath)
	if err != nil {
		t.Fatalf("GenerateWithCache after modify: %v", err)
	}

	var hash1, hash2 string
	for _, f := range m1.Files {
		if f.Path == "file.txt" {
			hash1 = f.Hash
		}
	}
	for _, f := range m2.Files {
		if f.Path == "file.txt" {
			hash2 = f.Hash
		}
	}

	if hash1 == hash2 {
		t.Fatalf("expected different hash after modification, got %s both times", hash1)
	}
}

func TestGenerateWithCachePrunesDeletedFiles(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, ".fst", "stat-cache.json")
	os.MkdirAll(filepath.Join(dir, ".fst"), 0755)

	os.WriteFile(filepath.Join(dir, "keep.txt"), []byte("keep"), 0644)
	os.WriteFile(filepath.Join(dir, "delete.txt"), []byte("delete"), 0644)

	// Prime cache
	GenerateWithCache(dir, cachePath)

	// Delete a file
	os.Remove(filepath.Join(dir, "delete.txt"))

	// Regenerate
	GenerateWithCache(dir, cachePath)

	// Check cache no longer has the deleted file
	cache := LoadStatCache(cachePath)
	if _, ok := cache.Entries["delete.txt"]; ok {
		t.Fatalf("expected deleted file to be pruned from cache")
	}
	if _, ok := cache.Entries["keep.txt"]; !ok {
		t.Fatalf("expected kept file to remain in cache")
	}
}

func TestBuildStatCacheFromManifest(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, ".fst", "stat-cache.json")
	os.MkdirAll(filepath.Join(dir, ".fst"), 0755)

	os.WriteFile(filepath.Join(dir, "file.txt"), []byte("hello"), 0644)

	m, _ := Generate(dir, false)
	BuildStatCacheFromManifest(dir, m, cachePath)

	cache := LoadStatCache(cachePath)
	entry, ok := cache.Entries["file.txt"]
	if !ok {
		t.Fatalf("expected file.txt in cache")
	}
	if entry.Hash == "" {
		t.Fatalf("expected non-empty hash")
	}

	// Verify the cache is usable for a subsequent GenerateWithCache
	time.Sleep(20 * time.Millisecond)
	m2, err := GenerateWithCache(dir, cachePath)
	if err != nil {
		t.Fatalf("GenerateWithCache: %v", err)
	}

	j1, _ := m.ToJSON()
	j2, _ := m2.ToJSON()
	if string(j1) != string(j2) {
		t.Fatalf("manifest from BuildStatCacheFromManifest should match GenerateWithCache")
	}
}
