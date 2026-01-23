package conflicts

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/sergi/go-diff/diffmatchpatch"
)

// Hunk represents an overlapping change region
type Hunk struct {
	StartLine   int      `json:"start_line"`
	EndLine     int      `json:"end_line"`
	CurrentLines  []string `json:"local_lines"`
	SourceLines []string `json:"remote_lines"`
	BaseLines   []string `json:"base_lines"`
}

// FileConflict represents a git-style conflict in a file
type FileConflict struct {
	Path          string `json:"path"`
	BaseContent   string `json:"-"` // Not serialized - can be large
	LocalContent  string `json:"-"`
	RemoteContent string `json:"-"`
	Hunks         []Hunk `json:"hunks"`
}

// Report contains all conflicts between workspaces
type Report struct {
	BaseSnapshotID   string         `json:"base_snapshot_id"`
	Conflicts        []FileConflict `json:"conflicts"`
	OverlappingFiles []string       `json:"overlapping_files"` // Files modified in both (may or may not conflict)
	TrueConflicts    int            `json:"true_conflicts"`    // Count of files with actual line conflicts
}

// BlobAccessor provides access to file content by hash
type BlobAccessor interface {
	Get(hash string) (string, error)
}

// FileBlobAccessor reads blobs from the global cache
type FileBlobAccessor struct {
	cacheDir string
}

// NewFileBlobAccessor creates a blob accessor for the global cache
func NewFileBlobAccessor() (*FileBlobAccessor, error) {
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return nil, err
	}
	return &FileBlobAccessor{
		cacheDir: blobDir,
	}, nil
}

// Get retrieves file content by hash from the cache
func (a *FileBlobAccessor) Get(hash string) (string, error) {
	path := filepath.Join(a.cacheDir, hash)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("blob not found: %s", hash)
	}
	return string(data), nil
}

// FileSystemAccessor reads files directly from the filesystem
type FileSystemAccessor struct {
	root     string
	manifest *manifest.Manifest
}

// NewFileSystemAccessor creates a blob accessor that reads from filesystem
func NewFileSystemAccessor(root string, m *manifest.Manifest) *FileSystemAccessor {
	return &FileSystemAccessor{root: root, manifest: m}
}

// Get retrieves file content from the filesystem
func (a *FileSystemAccessor) Get(hash string) (string, error) {
	// Find file path by hash
	for _, f := range a.manifest.Files {
		if f.Hash == hash {
			data, err := os.ReadFile(filepath.Join(a.root, f.Path))
			if err != nil {
				return "", err
			}
			return string(data), nil
		}
	}
	return "", fmt.Errorf("file with hash %s not found", hash)
}

// Detect performs 3-way merge analysis to find git-style conflicts
// between the current workspace and another workspace
// Both workspaces must share a common base_snapshot_id for meaningful conflict detection
func Detect(root, otherRoot string, includeDirty bool) (*Report, error) {
	cfg, err := config.Load()
	if err != nil {
		return nil, fmt.Errorf("not in a project directory: %w", err)
	}

	otherCfg, err := config.LoadAt(otherRoot)
	if err != nil {
		return nil, fmt.Errorf("cannot load other workspace config: %w", err)
	}

	// Load base snapshot manifest (common ancestor)
	// We use current workspace's base as the reference point
	baseSnapshotID := cfg.BaseSnapshotID
	if baseSnapshotID == "" {
		return nil, fmt.Errorf("no base snapshot - cannot detect conflicts")
	}

	// Warn if bases don't match (they should for proper 3-way merge)
	if otherCfg.BaseSnapshotID != baseSnapshotID {
		// They might still share a common ancestor through the snapshot, but warn
		fmt.Printf("Warning: workspaces have different base snapshots (%s vs %s)\n",
			baseSnapshotID, otherCfg.BaseSnapshotID)
	}

	baseManifest, err := loadManifestFromSnapshots(root, baseSnapshotID)
	if err != nil {
		return nil, fmt.Errorf("failed to load base snapshot: %w", err)
	}

	// Generate current workspace manifest
	currentManifest, err := manifest.Generate(root, false)
	if err != nil {
		return nil, fmt.Errorf("failed to generate current manifest: %w", err)
	}

	// Get other workspace's manifest
	var otherManifest *manifest.Manifest
	var otherAccessor BlobAccessor

	if includeDirty {
		otherManifest, err = manifest.Generate(otherRoot, false)
		if err != nil {
			return nil, fmt.Errorf("failed to generate other workspace manifest: %w", err)
		}
		otherAccessor = NewFileSystemAccessor(otherRoot, otherManifest)
	} else {
		snapshotID := otherCfg.LastSnapshotID
		if snapshotID == "" {
			snapshotID = otherCfg.BaseSnapshotID
		}

		if snapshotID == "" {
			return nil, fmt.Errorf("other workspace has no snapshots")
		}

		otherManifest, err = loadManifestFromSnapshots(otherRoot, snapshotID)
		if err != nil {
			return nil, fmt.Errorf("failed to load other workspace snapshot: %w", err)
		}
		otherAccessor, err = NewFileBlobAccessor()
		if err != nil {
			return nil, err
		}
	}

	// Create blob accessors
	baseAccessor, err := NewFileBlobAccessor()
	if err != nil {
		return nil, err
	}
	currentAccessor := NewFileSystemAccessor(root, currentManifest)

	// Find files modified in both workspaces since base
	currentChanges := getModifiedFiles(baseManifest, currentManifest)
	otherChanges := getModifiedFiles(baseManifest, otherManifest)

	// Find overlapping files (modified in both)
	overlapping := findOverlappingFiles(currentChanges, otherChanges)

	// For each overlapping file, perform 3-way diff to find conflicts
	var conflicts []FileConflict
	for _, path := range overlapping {
		baseEntry := getFileEntry(baseManifest, path)
		currentEntry := getFileEntry(currentManifest, path)
		otherEntry := getFileEntry(otherManifest, path)

		// Skip if any version is missing (deleted)
		if baseEntry == nil || currentEntry == nil || otherEntry == nil {
			// Handle deletion conflicts
			if currentEntry == nil && otherEntry != nil {
				// Current deleted, other modified
				conflicts = append(conflicts, FileConflict{
					Path:  path,
					Hunks: []Hunk{{StartLine: 1, EndLine: 1}}, // Indicate conflict
				})
			} else if currentEntry != nil && otherEntry == nil {
				// Current modified, other deleted
				conflicts = append(conflicts, FileConflict{
					Path:  path,
					Hunks: []Hunk{{StartLine: 1, EndLine: 1}},
				})
			}
			continue
		}

		// If hashes match in current and other, no conflict
		if currentEntry.Hash == otherEntry.Hash {
			continue
		}

		// Load file contents
		baseContent, err := baseAccessor.Get(baseEntry.Hash)
		if err != nil {
			continue // Skip files we can't read
		}
		currentContent, err := currentAccessor.Get(currentEntry.Hash)
		if err != nil {
			continue
		}
		otherContent, err := otherAccessor.Get(otherEntry.Hash)
		if err != nil {
			continue
		}

		// Check for overlapping hunks (true conflicts)
		hunks := findConflictingHunks(baseContent, currentContent, otherContent)
		if len(hunks) > 0 {
			conflicts = append(conflicts, FileConflict{
				Path:          path,
				BaseContent:   baseContent,
				LocalContent:  currentContent,
				RemoteContent: otherContent,
				Hunks:         hunks,
			})
		}
	}

	return &Report{
		BaseSnapshotID:   baseSnapshotID,
		Conflicts:        conflicts,
		OverlappingFiles: overlapping,
		TrueConflicts:    len(conflicts),
	}, nil
}

// getModifiedFiles returns files that have changed between base and current manifest
func getModifiedFiles(base, current *manifest.Manifest) map[string]bool {
	_, modified, _ := manifest.Diff(base, current)

	result := make(map[string]bool)
	for _, path := range modified {
		result[path] = true
	}
	return result
}

// findOverlappingFiles returns files that exist in both maps
func findOverlappingFiles(a, b map[string]bool) []string {
	var result []string
	for path := range a {
		if b[path] {
			result = append(result, path)
		}
	}
	sort.Strings(result)
	return result
}

// getFileEntry finds a file entry by path in a manifest
func getFileEntry(m *manifest.Manifest, path string) *manifest.FileEntry {
	for i := range m.Files {
		if m.Files[i].Path == path {
			return &m.Files[i]
		}
	}
	return nil
}

// lineRange tracks the line positions of a change
type lineRange struct {
	start int
	end   int
}

// findConflictingHunks uses 3-way diff to find overlapping changes
func findConflictingHunks(base, local, remote string) []Hunk {
	// Get line-based changes from base to local and base to remote
	localRanges := getChangedLineRanges(base, local)
	remoteRanges := getChangedLineRanges(base, remote)

	// Find overlapping ranges
	var hunks []Hunk
	for _, lr := range localRanges {
		for _, rr := range remoteRanges {
			if rangesOverlap(lr, rr) {
				// These changes overlap - it's a conflict
				baseLines := getLines(base, lr.start, lr.end)
				localLines := getLinesFromDiff(base, local, lr)
				remoteLines := getLinesFromDiff(base, remote, rr)

				hunks = append(hunks, Hunk{
					StartLine:   lr.start,
					EndLine:     max(lr.end, rr.end),
					BaseLines:   baseLines,
					CurrentLines:  localLines,
					SourceLines: remoteLines,
				})
			}
		}
	}

	return hunks
}

// getChangedLineRanges returns the line ranges that were modified
func getChangedLineRanges(base, modified string) []lineRange {
	dmp := diffmatchpatch.New()
	diffs := dmp.DiffMain(base, modified, true)

	var ranges []lineRange
	lineNum := 1

	for _, d := range diffs {
		lineCount := strings.Count(d.Text, "\n")

		switch d.Type {
		case diffmatchpatch.DiffEqual:
			lineNum += lineCount
		case diffmatchpatch.DiffDelete, diffmatchpatch.DiffInsert:
			// Record the range of affected lines
			endLine := lineNum + lineCount
			if lineCount == 0 {
				endLine = lineNum
			}

			// Merge with previous range if adjacent
			if len(ranges) > 0 && ranges[len(ranges)-1].end >= lineNum-1 {
				ranges[len(ranges)-1].end = max(ranges[len(ranges)-1].end, endLine)
			} else {
				ranges = append(ranges, lineRange{start: lineNum, end: endLine})
			}

			if d.Type == diffmatchpatch.DiffDelete {
				lineNum += lineCount
			}
		}
	}

	return ranges
}

// rangesOverlap checks if two line ranges overlap
func rangesOverlap(a, b lineRange) bool {
	return a.start <= b.end && b.start <= a.end
}

// getLines extracts lines from content between start and end (1-indexed)
func getLines(content string, start, end int) []string {
	lines := strings.Split(content, "\n")
	if start < 1 {
		start = 1
	}
	if end > len(lines) {
		end = len(lines)
	}
	if start > len(lines) {
		return nil
	}
	return lines[start-1 : end]
}

// getLinesFromDiff extracts the modified lines in the given range
func getLinesFromDiff(base, modified string, r lineRange) []string {
	// Simple approach: get lines from modified at approximately the same position
	modifiedLines := strings.Split(modified, "\n")
	if r.start < 1 {
		r.start = 1
	}
	end := r.end
	if end > len(modifiedLines) {
		end = len(modifiedLines)
	}
	if r.start > len(modifiedLines) {
		return nil
	}
	return modifiedLines[r.start-1 : end]
}

// loadManifestFromSnapshots loads a manifest from a workspace's snapshots directory
func loadManifestFromSnapshots(root, snapshotID string) (*manifest.Manifest, error) {
	snapshotsDir := config.GetSnapshotsDirAt(root)
	manifestPath := filepath.Join(snapshotsDir, snapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("manifest not found in snapshots: %w", err)
	}
	return manifest.FromJSON(data)
}

// HasConflicts returns true if there are any conflicts
func (r *Report) HasConflicts() bool {
	return len(r.Conflicts) > 0
}

// ToJSON converts the report to JSON
func (r *Report) ToJSON() ([]byte, error) {
	return json.MarshalIndent(r, "", "  ")
}

// FormatSummary returns a human-readable summary
func (r *Report) FormatSummary() string {
	if r.TrueConflicts == 0 {
		if len(r.OverlappingFiles) > 0 {
			return fmt.Sprintf("No conflicts (%d files modified in both workspaces, but changes don't overlap)",
				len(r.OverlappingFiles))
		}
		return "No conflicts"
	}

	totalHunks := 0
	for _, c := range r.Conflicts {
		totalHunks += len(c.Hunks)
	}

	return fmt.Sprintf("%d conflicting files with %d overlapping regions",
		r.TrueConflicts, totalHunks)
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
