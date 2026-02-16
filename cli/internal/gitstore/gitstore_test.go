package gitstore

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/manifest"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

// initGitRepo creates a git repo and returns an Env for it.
func initGitRepo(t *testing.T) (gitutil.Env, string) {
	t.Helper()
	repoDir := t.TempDir()
	workDir := t.TempDir()
	indexPath := filepath.Join(workDir, "index")

	run := func(args ...string) {
		cmd := exec.Command("git", append([]string{"-C", repoDir}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %s", args, out)
		}
	}
	run("init")
	run("config", "user.name", "Test")
	run("config", "user.email", "test@test.com")

	return gitutil.NewEnv(repoDir, workDir, indexPath), repoDir
}

func TestGitMappingRoundTrip(t *testing.T) {
	dir := t.TempDir()

	// Load from empty dir (should return empty mapping)
	m, err := LoadGitMapping(dir)
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if len(m.Snapshots) != 0 {
		t.Fatalf("expected empty mapping, got %d entries", len(m.Snapshots))
	}

	// Save and reload
	m.Snapshots["snap-123"] = "abc123"
	m.Snapshots["snap-456"] = "def456"
	m.RepoPath = "/some/path"
	if err := SaveGitMapping(dir, m); err != nil {
		t.Fatalf("SaveGitMapping: %v", err)
	}

	loaded, err := LoadGitMapping(dir)
	if err != nil {
		t.Fatalf("LoadGitMapping after save: %v", err)
	}
	if loaded.RepoPath != "/some/path" {
		t.Fatalf("expected /some/path, got %s", loaded.RepoPath)
	}
	if loaded.Snapshots["snap-123"] != "abc123" {
		t.Fatalf("expected abc123, got %s", loaded.Snapshots["snap-123"])
	}
	if loaded.Snapshots["snap-456"] != "def456" {
		t.Fatalf("expected def456, got %s", loaded.Snapshots["snap-456"])
	}
}

func TestGitMappingNilSnapshots(t *testing.T) {
	dir := t.TempDir()

	// Write a mapping with null snapshots field
	exportDir := filepath.Join(dir, "export")
	os.MkdirAll(exportDir, 0755)
	os.WriteFile(filepath.Join(exportDir, "git-map.json"), []byte(`{"repo_path":"","snapshots":null}`), 0644)

	m, err := LoadGitMapping(dir)
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if m.Snapshots == nil {
		t.Fatalf("expected non-nil snapshots map")
	}
}

func TestExportMetadataRoundTrip(t *testing.T) {
	g, _ := initGitRepo(t)

	// Before any metadata exists
	meta, err := LoadExportMetadata(g)
	if err != nil {
		t.Fatalf("LoadExportMetadata: %v", err)
	}
	if meta != nil {
		t.Fatalf("expected nil metadata before any export")
	}

	// Update metadata
	cfg := &config.ProjectConfig{
		ProjectID:     "proj-1",
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
	}
	if err := UpdateExportMetadata(g, cfg, "main"); err != nil {
		t.Fatalf("UpdateExportMetadata: %v", err)
	}

	// Load it back
	meta, err = LoadExportMetadata(g)
	if err != nil {
		t.Fatalf("LoadExportMetadata: %v", err)
	}
	if meta == nil {
		t.Fatalf("expected non-nil metadata")
	}
	if meta.ProjectID != "proj-1" {
		t.Fatalf("expected proj-1, got %s", meta.ProjectID)
	}
	if len(meta.Workspaces) != 1 {
		t.Fatalf("expected 1 workspace, got %d", len(meta.Workspaces))
	}
	ws := meta.Workspaces["ws-1"]
	if ws.Branch != "main" {
		t.Fatalf("expected branch main, got %s", ws.Branch)
	}
	if ws.WorkspaceName != "main" {
		t.Fatalf("expected workspace name main, got %s", ws.WorkspaceName)
	}

	// Update with a second workspace
	cfg2 := &config.ProjectConfig{
		ProjectID:     "proj-1",
		WorkspaceID:   "ws-2",
		WorkspaceName: "feature",
	}
	if err := UpdateExportMetadata(g, cfg2, "feature"); err != nil {
		t.Fatalf("UpdateExportMetadata second: %v", err)
	}
	meta, _ = LoadExportMetadata(g)
	if len(meta.Workspaces) != 2 {
		t.Fatalf("expected 2 workspaces, got %d", len(meta.Workspaces))
	}
}

func TestLoadExportMetadataFromRepo(t *testing.T) {
	g, repoDir := initGitRepo(t)

	// No metadata yet
	meta, err := LoadExportMetadataFromRepo(repoDir)
	if err != nil {
		t.Fatalf("LoadExportMetadataFromRepo: %v", err)
	}
	if meta != nil {
		t.Fatalf("expected nil before export")
	}

	// Create metadata
	cfg := &config.ProjectConfig{
		ProjectID:     "proj-1",
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
	}
	UpdateExportMetadata(g, cfg, "main")

	meta, err = LoadExportMetadataFromRepo(repoDir)
	if err != nil {
		t.Fatalf("LoadExportMetadataFromRepo: %v", err)
	}
	if meta == nil || meta.ProjectID != "proj-1" {
		t.Fatalf("expected metadata with proj-1")
	}
}

func TestCollectExportBranches(t *testing.T) {
	meta := &ExportMeta{
		Workspaces: map[string]ExportWorkspaceMeta{
			"ws-1": {Branch: "main"},
			"ws-2": {Branch: "feature"},
			"ws-3": {Branch: ""},     // empty branch should be skipped
			"ws-4": {Branch: "main"}, // duplicate should be skipped
		},
	}
	branches := CollectExportBranches(meta)
	if len(branches) != 2 {
		t.Fatalf("expected 2 branches, got %d: %v", len(branches), branches)
	}
	branchSet := map[string]bool{}
	for _, b := range branches {
		branchSet[b] = true
	}
	if !branchSet["main"] || !branchSet["feature"] {
		t.Fatalf("expected main and feature, got %v", branches)
	}
}

func TestAgentEmail(t *testing.T) {
	tests := []struct {
		agent    string
		expected string
	}{
		{"Claude", "claude@fastest.local"},
		{"Claude Code", "claude-code@fastest.local"},
		{"GPT-4o", "gpt-4o@fastest.local"},
		{"", ""},
		{"---", "agent@fastest.local"},
		{"My Agent 3.5", "my-agent-3-5@fastest.local"},
	}
	for _, tt := range tests {
		got := AgentEmail(tt.agent)
		if got != tt.expected {
			t.Errorf("AgentEmail(%q) = %q, want %q", tt.agent, got, tt.expected)
		}
	}
}

func TestCommitMetaFromSnapshot(t *testing.T) {
	// With author info
	snap := &store.SnapshotMeta{
		CreatedAt:   "2024-01-01T00:00:00Z",
		AuthorName:  "Alice",
		AuthorEmail: "alice@example.com",
	}
	meta := CommitMetaFromSnapshot(snap)
	if meta == nil {
		t.Fatal("expected non-nil meta")
	}
	if meta.AuthorName != "Alice" {
		t.Fatalf("expected Alice, got %s", meta.AuthorName)
	}
	if meta.AuthorDate != "2024-01-01T00:00:00Z" {
		t.Fatalf("expected date, got %s", meta.AuthorDate)
	}

	// With agent (no author)
	snap2 := &store.SnapshotMeta{
		CreatedAt: "2024-01-01T00:00:00Z",
		Agent:     "Claude",
	}
	meta2 := CommitMetaFromSnapshot(snap2)
	if meta2.AuthorName != "Claude" {
		t.Fatalf("expected Claude, got %s", meta2.AuthorName)
	}
	if meta2.AuthorEmail != "claude@fastest.local" {
		t.Fatalf("expected claude@fastest.local, got %s", meta2.AuthorEmail)
	}

	// Empty snapshot
	empty := &store.SnapshotMeta{}
	if got := CommitMetaFromSnapshot(empty); got != nil {
		t.Fatalf("expected nil for empty snapshot, got %+v", got)
	}
}

func TestRestoreFilesFromManifest(t *testing.T) {
	// Set up a store with blobs
	projectRoot := t.TempDir()
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	// Write some blobs
	s.WriteBlob("hash1", []byte("file1 content"))
	s.WriteBlob("hash2", []byte("file2 content"))

	// Create a manifest with those files
	m := &manifest.Manifest{
		Version: "1",
		Files: []manifest.FileEntry{
			{Type: manifest.EntryTypeFile, Path: "a.txt", Hash: "hash1", Mode: 0644, Size: 13},
			{Type: manifest.EntryTypeFile, Path: "sub/b.txt", Hash: "hash2", Mode: 0644, Size: 13},
		},
	}

	// Restore to a target dir
	targetDir := t.TempDir()
	// Create an extra file that should be removed
	os.WriteFile(filepath.Join(targetDir, "extra.txt"), []byte("should be removed"), 0644)

	if err := RestoreFilesFromManifest(targetDir, s, m); err != nil {
		t.Fatalf("RestoreFilesFromManifest: %v", err)
	}

	// Verify files exist
	data, err := os.ReadFile(filepath.Join(targetDir, "a.txt"))
	if err != nil {
		t.Fatalf("expected a.txt: %v", err)
	}
	if string(data) != "file1 content" {
		t.Fatalf("expected 'file1 content', got %q", string(data))
	}

	data, err = os.ReadFile(filepath.Join(targetDir, "sub", "b.txt"))
	if err != nil {
		t.Fatalf("expected sub/b.txt: %v", err)
	}
	if string(data) != "file2 content" {
		t.Fatalf("expected 'file2 content', got %q", string(data))
	}

	// Extra file should have been removed
	if _, err := os.Stat(filepath.Join(targetDir, "extra.txt")); !os.IsNotExist(err) {
		t.Fatalf("expected extra.txt to be removed")
	}
}

func TestRestoreFilesPreservesGitAndFst(t *testing.T) {
	projectRoot := t.TempDir()
	s := store.OpenAt(projectRoot)
	s.EnsureDirs()

	m := &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}

	targetDir := t.TempDir()
	// Create .git and .fst dirs with files
	os.MkdirAll(filepath.Join(targetDir, ".git"), 0755)
	os.WriteFile(filepath.Join(targetDir, ".git", "HEAD"), []byte("ref"), 0644)
	os.MkdirAll(filepath.Join(targetDir, ".fst"), 0755)
	os.WriteFile(filepath.Join(targetDir, ".fst", "config.json"), []byte("{}"), 0644)

	RestoreFilesFromManifest(targetDir, s, m)

	// .git and .fst should be preserved
	if _, err := os.Stat(filepath.Join(targetDir, ".git", "HEAD")); err != nil {
		t.Fatalf("expected .git/HEAD to be preserved: %v", err)
	}
	if _, err := os.Stat(filepath.Join(targetDir, ".fst", "config.json")); err != nil {
		t.Fatalf("expected .fst/config.json to be preserved: %v", err)
	}
}

func TestResolveGitParentSHAs(t *testing.T) {
	g, _ := initGitRepo(t)

	// Create a commit
	os.WriteFile(filepath.Join(g.WorkTree, "f.txt"), []byte("x"), 0644)
	g.Run("add", "-A")
	tree, _ := gitutil.TreeSHA(g)
	sha, _ := gitutil.CreateCommitWithParents(g, tree, "test", nil, nil)

	mapping := &GitMapping{
		Snapshots: map[string]string{
			"snap-1": sha,
			"snap-2": "0000000000000000000000000000000000000000", // non-existent commit
		},
	}

	// Resolve known parent
	parents, err := ResolveGitParentSHAs(g, mapping, []string{"snap-1"})
	if err != nil {
		t.Fatalf("ResolveGitParentSHAs: %v", err)
	}
	if len(parents) != 1 || parents[0] != sha {
		t.Fatalf("expected [%s], got %v", sha, parents)
	}

	// Empty parents
	parents, _ = ResolveGitParentSHAs(g, mapping, nil)
	if parents != nil {
		t.Fatalf("expected nil for empty parents, got %v", parents)
	}

	// Deduplicates
	parents, _ = ResolveGitParentSHAs(g, mapping, []string{"snap-1", "snap-1"})
	if len(parents) != 1 {
		t.Fatalf("expected 1 deduped parent, got %d", len(parents))
	}

	// Unknown snapshot is skipped (warning printed)
	parents, _ = ResolveGitParentSHAs(g, mapping, []string{"snap-unknown"})
	if len(parents) != 0 {
		t.Fatalf("expected 0 parents for unknown snap, got %d", len(parents))
	}
}

func TestBuildSnapshotDAG(t *testing.T) {
	projectRoot := t.TempDir()
	s := store.OpenAt(projectRoot)
	s.EnsureDirs()

	// Create a chain: snap-A -> snap-B -> snap-C
	s.WriteSnapshotMeta(&store.SnapshotMeta{
		ID: "snap-A", ManifestHash: "h1", CreatedAt: "2024-01-01T00:00:00Z",
	})
	s.WriteSnapshotMeta(&store.SnapshotMeta{
		ID: "snap-B", ManifestHash: "h2", CreatedAt: "2024-01-02T00:00:00Z",
		ParentSnapshotIDs: []string{"snap-A"},
	})
	s.WriteSnapshotMeta(&store.SnapshotMeta{
		ID: "snap-C", ManifestHash: "h3", CreatedAt: "2024-01-03T00:00:00Z",
		ParentSnapshotIDs: []string{"snap-B"},
	})

	dag, err := BuildSnapshotDAG(s, "snap-C")
	if err != nil {
		t.Fatalf("BuildSnapshotDAG: %v", err)
	}
	if len(dag) != 3 {
		t.Fatalf("expected 3 snapshots in DAG, got %d", len(dag))
	}
	// Topo order: A, B, C
	if dag[0].ID != "snap-A" || dag[1].ID != "snap-B" || dag[2].ID != "snap-C" {
		t.Fatalf("expected [A, B, C], got [%s, %s, %s]", dag[0].ID, dag[1].ID, dag[2].ID)
	}

	// Empty ID
	if _, err := BuildSnapshotDAG(s, ""); err == nil {
		t.Fatal("expected error for empty ID")
	}

	// Non-existent ID
	if _, err := BuildSnapshotDAG(s, "snap-nonexistent"); err == nil {
		t.Fatal("expected error for non-existent ID")
	}
}

func TestCreateImportedSnapshot(t *testing.T) {
	projectRoot := t.TempDir()
	s := store.OpenAt(projectRoot)
	s.EnsureDirs()

	// Create a source directory with files
	sourceRoot := t.TempDir()
	os.WriteFile(filepath.Join(sourceRoot, "hello.txt"), []byte("world"), 0644)
	os.MkdirAll(filepath.Join(sourceRoot, "sub"), 0755)
	os.WriteFile(filepath.Join(sourceRoot, "sub", "nested.txt"), []byte("content"), 0644)

	// Create workspace config
	wsRoot := t.TempDir()
	config.InitAt(wsRoot, "proj-1", "ws-1", "main", "")
	wsCfg, _ := config.LoadAt(wsRoot)

	now := time.Now().UTC().Format(time.RFC3339)
	snapID, err := CreateImportedSnapshot(s, sourceRoot, wsCfg, nil, "test import", now, "Author", "author@test.com", "")
	if err != nil {
		t.Fatalf("CreateImportedSnapshot: %v", err)
	}
	if snapID == "" {
		t.Fatal("expected non-empty snapshot ID")
	}

	// Verify snapshot metadata
	meta, err := s.LoadSnapshotMeta(snapID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	if meta.Message != "test import" {
		t.Fatalf("expected message 'test import', got %s", meta.Message)
	}
	if meta.AuthorName != "Author" {
		t.Fatalf("expected author 'Author', got %s", meta.AuthorName)
	}
	if meta.Files != 2 {
		t.Fatalf("expected 2 files, got %d", meta.Files)
	}

	// With parent
	snap2, err := CreateImportedSnapshot(s, sourceRoot, wsCfg, []string{snapID}, "child", now, "Author", "author@test.com", "")
	if err != nil {
		t.Fatalf("CreateImportedSnapshot child: %v", err)
	}
	meta2, _ := s.LoadSnapshotMeta(snap2)
	if len(meta2.ParentSnapshotIDs) != 1 || meta2.ParentSnapshotIDs[0] != snapID {
		t.Fatalf("expected parent [%s], got %v", snapID, meta2.ParentSnapshotIDs)
	}

	// With agent
	snap3, err := CreateImportedSnapshot(s, sourceRoot, wsCfg, nil, "agent work", now, "Claude", "claude@fastest.local", "Claude")
	if err != nil {
		t.Fatalf("CreateImportedSnapshot agent: %v", err)
	}
	meta3, _ := s.LoadSnapshotMeta(snap3)
	if meta3.Agent != "Claude" {
		t.Fatalf("expected agent 'Claude', got %s", meta3.Agent)
	}
}

func TestCreateImportedSnapshotDefaultMessage(t *testing.T) {
	projectRoot := t.TempDir()
	s := store.OpenAt(projectRoot)
	s.EnsureDirs()

	sourceRoot := t.TempDir()
	os.WriteFile(filepath.Join(sourceRoot, "f.txt"), []byte("x"), 0644)

	wsRoot := t.TempDir()
	config.InitAt(wsRoot, "proj-1", "ws-1", "main", "")
	wsCfg, _ := config.LoadAt(wsRoot)

	snapID, _ := CreateImportedSnapshot(s, sourceRoot, wsCfg, nil, "", "", "", "", "")
	meta, _ := s.LoadSnapshotMeta(snapID)
	if meta.Message != "Imported commit" {
		t.Fatalf("expected default message, got %s", meta.Message)
	}
	if meta.CreatedAt == "" {
		t.Fatal("expected non-empty CreatedAt")
	}
}
