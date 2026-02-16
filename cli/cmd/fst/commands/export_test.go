package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitstore"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

// setupExportProject creates a project with two workspaces (ws-a, ws-b)
// that share a common base snapshot. Each workspace then diverges with the
// given file changes. Returns (projectRoot, wsARootRoot, wsBRoot).
// Unlike setupForkedWorkspaces, this writes a proper project config with
// project_id/project_name so FindParentRootFrom works.
func setupExportProject(t *testing.T, aFiles, bFiles map[string]string) (string, string, string) {
	t.Helper()

	projectRoot := t.TempDir()

	// Write proper parent config
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-export-test",
		ProjectName: "export-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Create shared store dirs
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsARoot := filepath.Join(projectRoot, "ws-a")
	wsBRoot := filepath.Join(projectRoot, "ws-b")

	// Initialize both workspaces with config
	for _, ws := range []struct {
		root, id, name string
	}{
		{wsARoot, "ws-a-id", "ws-a"},
		{wsBRoot, "ws-b-id", "ws-b"},
	} {
		if err := os.MkdirAll(filepath.Join(ws.root, ".fst"), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		cfg := &config.ProjectConfig{
			ProjectID:     "proj-export-test",
			WorkspaceID:   ws.id,
			WorkspaceName: ws.name,
			Mode:          "local",
		}
		if err := config.SaveAt(ws.root, cfg); err != nil {
			t.Fatalf("SaveAt: %v", err)
		}
		if err := os.WriteFile(filepath.Join(ws.root, "base.txt"), []byte("base"), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	// Create base snapshot from ws-a
	restoreCwd := chdir(t, wsARoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "base snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("base snapshot: %v", err)
	}
	restoreCwd()

	// Share base snapshot with ws-b
	aCfg, err := config.LoadAt(wsARoot)
	if err != nil {
		t.Fatalf("LoadAt ws-a: %v", err)
	}
	bCfg, err := config.LoadAt(wsBRoot)
	if err != nil {
		t.Fatalf("LoadAt ws-b: %v", err)
	}
	bCfg.CurrentSnapshotID = aCfg.CurrentSnapshotID
	if err := config.SaveAt(wsBRoot, bCfg); err != nil {
		t.Fatalf("SaveAt ws-b: %v", err)
	}

	// Add divergent files and snapshot
	for path, content := range aFiles {
		full := filepath.Join(wsARoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}
	for path, content := range bFiles {
		full := filepath.Join(wsBRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}

	restoreCwd = chdir(t, wsARoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "ws-a changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("ws-a snapshot: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, wsBRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "ws-b changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("ws-b snapshot: %v", err)
	}
	restoreCwd()

	return projectRoot, wsARoot, wsBRoot
}

func TestExportGitRequiresProject(t *testing.T) {
	root := t.TempDir()
	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected export to fail outside a project")
	}
}

func TestExportGitSingleWorkspace(t *testing.T) {
	projectRoot := t.TempDir()

	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-single",
		ProjectName: "single",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsRoot := filepath.Join(projectRoot, "ws-one")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "a.txt"), []byte("v1"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-single", "ws-one-id", "ws-one", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}

	// Register workspace
	if err := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   "ws-one-id",
		WorkspaceName: "ws-one",
		Path:          wsRoot,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	// First snapshot
	restoreCwd := chdir(t, wsRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "first commit"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot 1: %v", err)
	}

	// Second snapshot
	if err := os.WriteFile(filepath.Join(wsRoot, "b.txt"), []byte("v2"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "second commit"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot 2: %v", err)
	}
	restoreCwd()

	// Export from project root
	restoreCwd = chdir(t, projectRoot)
	defer restoreCwd()

	cmd = NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("export: %v", err)
	}

	// Verify .git exists
	if _, err := os.Stat(filepath.Join(projectRoot, ".git")); err != nil {
		t.Fatalf("expected .git directory: %v", err)
	}

	// Verify branch has 2 commits
	out := gitOutput(t, projectRoot, "log", "--oneline", "ws-one", "--")
	lines := nonEmptyLines(out)
	if len(lines) != 2 {
		t.Fatalf("expected 2 commits on ws-one, got %d: %s", len(lines), out)
	}

	// Verify commit messages
	out = gitOutput(t, projectRoot, "log", "--format=%s", "ws-one", "--")
	if !strings.Contains(out, "first commit") {
		t.Fatalf("expected 'first commit' in log: %s", out)
	}
	if !strings.Contains(out, "second commit") {
		t.Fatalf("expected 'second commit' in log: %s", out)
	}

	// Verify mapping exists with 2 entries
	mapping, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if len(mapping.Snapshots) != 2 {
		t.Fatalf("expected 2 mapping entries, got %d", len(mapping.Snapshots))
	}
}

func TestExportGitMultiWorkspace(t *testing.T) {
	projectRoot, _, _ := setupExportProject(t,
		map[string]string{"a.txt": "target"},
		map[string]string{"b.txt": "source"},
	)

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("export: %v", err)
	}

	// Both branches should exist
	for _, branch := range []string{"ws-a", "ws-b"} {
		out := gitOutput(t, projectRoot, "log", "--oneline", branch, "--")
		if len(nonEmptyLines(out)) == 0 {
			t.Fatalf("expected commits on branch %s", branch)
		}
	}

	// Shared base commit should have same SHA on both branches
	aCommits := nonEmptyLines(gitOutput(t, projectRoot, "log", "--format=%H", "ws-a", "--"))
	bCommits := nonEmptyLines(gitOutput(t, projectRoot, "log", "--format=%H", "ws-b", "--"))

	if len(aCommits) < 2 || len(bCommits) < 2 {
		t.Fatalf("expected at least 2 commits on each branch, got a=%d b=%d",
			len(aCommits), len(bCommits))
	}

	// Last commit in each list is the oldest (base)
	baseOnA := aCommits[len(aCommits)-1]
	baseOnB := bCommits[len(bCommits)-1]
	if baseOnA != baseOnB {
		t.Fatalf("shared base commit SHA mismatch: a=%s b=%s", baseOnA, baseOnB)
	}

	// Verify mapping has entries for all snapshots (base + a changes + b changes = 3)
	mapping, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if len(mapping.Snapshots) < 3 {
		t.Fatalf("expected at least 3 mapping entries, got %d", len(mapping.Snapshots))
	}
}

// TestExportGitSharedAncestorBranch verifies that when one workspace's
// snapshots are a strict subset of another's (all "already exported"),
// the branch ref is still created. This was a bug where workspaces whose
// entire snapshot chain was shared with a previously-exported workspace
// would have no branch created.
func TestExportGitSharedAncestorBranch(t *testing.T) {
	projectRoot := t.TempDir()

	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-shared",
		ProjectName: "shared",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	// Create ws-a with base + divergent snapshot
	wsARoot := filepath.Join(projectRoot, "ws-a")
	if err := os.MkdirAll(wsARoot, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := config.InitAt(wsARoot, "proj-shared", "ws-a-id", "ws-a", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsARoot, "base.txt"), []byte("base"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	restoreCwd := chdir(t, wsARoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "base snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("base snapshot: %v", err)
	}
	restoreCwd()

	// Get the base snapshot ID
	aCfg, err := config.LoadAt(wsARoot)
	if err != nil {
		t.Fatalf("LoadAt ws-a: %v", err)
	}
	baseSnapshotID := aCfg.CurrentSnapshotID

	// Add divergent file and create second snapshot on ws-a
	if err := os.WriteFile(filepath.Join(wsARoot, "a-only.txt"), []byte("diverge"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	restoreCwd = chdir(t, wsARoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "ws-a diverge"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("ws-a diverge: %v", err)
	}
	restoreCwd()

	// Create ws-b that only has the shared base snapshot (no divergent work)
	wsBRoot := filepath.Join(projectRoot, "ws-b")
	if err := os.MkdirAll(wsBRoot, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := config.InitAt(wsBRoot, "proj-shared", "ws-b-id", "ws-b", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	bCfg, err := config.LoadAt(wsBRoot)
	if err != nil {
		t.Fatalf("LoadAt ws-b: %v", err)
	}
	bCfg.CurrentSnapshotID = baseSnapshotID
	bCfg.BaseSnapshotID = baseSnapshotID
	if err := config.SaveAt(wsBRoot, bCfg); err != nil {
		t.Fatalf("SaveAt ws-b: %v", err)
	}
	if err := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       "ws-b-id",
		WorkspaceName:     "ws-b",
		Path:              wsBRoot,
		CurrentSnapshotID: baseSnapshotID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("RegisterWorkspace ws-b: %v", err)
	}

	// Export
	restoreCwd = chdir(t, projectRoot)
	defer restoreCwd()

	cmd = NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("export: %v", err)
	}

	// ws-a should have 2 commits (base + diverge)
	aCommits := nonEmptyLines(gitOutput(t, projectRoot, "log", "--oneline", "ws-a", "--"))
	if len(aCommits) != 2 {
		t.Fatalf("expected 2 commits on ws-a, got %d: %v", len(aCommits), aCommits)
	}

	// ws-b should exist as a branch with 1 commit (the shared base)
	// This is the key assertion: ws-b's only snapshot was "already exported"
	// by ws-a, but the branch should still be created.
	bCommits := nonEmptyLines(gitOutput(t, projectRoot, "log", "--oneline", "ws-b", "--"))
	if len(bCommits) != 1 {
		t.Fatalf("expected 1 commit on ws-b, got %d: %v", len(bCommits), bCommits)
	}

	// The ws-b branch tip should be the same as ws-a's base commit
	aTip := nonEmptyLines(gitOutput(t, projectRoot, "log", "--format=%H", "ws-a", "--"))
	bTip := nonEmptyLines(gitOutput(t, projectRoot, "log", "--format=%H", "ws-b", "--"))
	// ws-a's oldest commit (last in list) is the base
	wsABase := aTip[len(aTip)-1]
	// ws-b should point to that same commit
	if bTip[0] != wsABase {
		t.Fatalf("ws-b tip (%s) should equal ws-a base (%s)", bTip[0], wsABase)
	}
}

func TestExportGitIncremental(t *testing.T) {
	projectRoot, wsARoot, _ := setupExportProject(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	restoreCwd := chdir(t, projectRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("first export: %v", err)
	}
	restoreCwd()

	// Record mapping after first export
	mapping1, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	count1 := len(mapping1.Snapshots)
	oldSHAs := make(map[string]string, count1)
	for k, v := range mapping1.Snapshots {
		oldSHAs[k] = v
	}

	// Add new snapshot to ws-a
	restoreCwd = chdir(t, wsARoot)
	if err := os.WriteFile(filepath.Join(wsARoot, "c.txt"), []byte("new"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "incremental"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restoreCwd()

	// Export again
	restoreCwd = chdir(t, projectRoot)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd = NewRootCmd()
		cmd.SetArgs([]string{"git", "export"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("incremental export: %v", err)
	}

	// Should contain "already exported" for existing snapshots
	if !strings.Contains(output, "already exported") {
		t.Fatalf("expected 'already exported' in output: %s", output)
	}

	// Mapping should have one more entry
	mapping2, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if len(mapping2.Snapshots) != count1+1 {
		t.Fatalf("expected %d mapping entries, got %d", count1+1, len(mapping2.Snapshots))
	}

	// Old SHAs should be preserved
	for snapID, oldSHA := range oldSHAs {
		if mapping2.Snapshots[snapID] != oldSHA {
			t.Fatalf("SHA changed for %s: %s -> %s", snapID, oldSHA, mapping2.Snapshots[snapID])
		}
	}
}

func TestExportGitRebuild(t *testing.T) {
	projectRoot, _, _ := setupExportProject(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	// First export
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("first export: %v", err)
	}

	mapping1, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}

	// Rebuild export
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"git", "export", "--rebuild"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("rebuild export: %v", err)
	}

	mapping2, err := gitstore.LoadGitMapping(filepath.Join(projectRoot, ".fst"))
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}

	// Same number of snapshot entries
	if len(mapping2.Snapshots) != len(mapping1.Snapshots) {
		t.Fatalf("expected same entry count, got %d vs %d",
			len(mapping2.Snapshots), len(mapping1.Snapshots))
	}

	// All SHAs should be valid (non-empty)
	for snapID, sha := range mapping2.Snapshots {
		if sha == "" {
			t.Fatalf("empty SHA for snapshot %s", snapID)
		}
	}
}

func TestExportGitSkipsEmptyWorkspace(t *testing.T) {
	projectRoot, _, _ := setupExportProject(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	// Create an empty workspace (no snapshots) — use config.InitAt + register
	emptyRoot := filepath.Join(projectRoot, "ws-empty")
	if err := os.MkdirAll(emptyRoot, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := config.InitAt(emptyRoot, "proj-export-test", "ws-empty-id", "ws-empty", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   "ws-empty-id",
		WorkspaceName: "ws-empty",
		Path:          emptyRoot,
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"git", "export", "--init"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("export: %v", err)
	}

	if !strings.Contains(output, "Skipping") {
		t.Fatalf("expected 'Skipping' in output for empty workspace: %s", output)
	}

	// ws-empty branch should not exist
	c := exec.Command("git", "-C", projectRoot, "show-ref", "--verify", "--quiet", "refs/heads/ws-empty")
	if err := c.Run(); err == nil {
		t.Fatalf("ws-empty branch should not exist")
	}
}

func TestBuildSnapshotDAG(t *testing.T) {
	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "p",
		ProjectName: "p",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	// Create chain: A (no parent) -> B -> C
	idA := store.ComputeSnapshotID("mA", nil, "test", "t@t.com", "2024-01-01T00:00:00Z")
	idB := store.ComputeSnapshotID("mB", []string{idA}, "test", "t@t.com", "2024-01-02T00:00:00Z")
	idC := store.ComputeSnapshotID("mC", []string{idB}, "test", "t@t.com", "2024-01-03T00:00:00Z")

	for _, meta := range []*store.SnapshotMeta{
		{ID: idA, ManifestHash: "mA", ParentSnapshotIDs: nil, AuthorName: "test", AuthorEmail: "t@t.com", CreatedAt: "2024-01-01T00:00:00Z"},
		{ID: idB, ManifestHash: "mB", ParentSnapshotIDs: []string{idA}, AuthorName: "test", AuthorEmail: "t@t.com", CreatedAt: "2024-01-02T00:00:00Z"},
		{ID: idC, ManifestHash: "mC", ParentSnapshotIDs: []string{idB}, AuthorName: "test", AuthorEmail: "t@t.com", CreatedAt: "2024-01-03T00:00:00Z"},
	} {
		if err := s.WriteSnapshotMeta(meta); err != nil {
			t.Fatalf("WriteSnapshotMeta %s: %v", meta.ID[:12], err)
		}
	}

	dag, err := gitstore.BuildSnapshotDAG(s, idC)
	if err != nil {
		t.Fatalf("buildSnapshotDAG: %v", err)
	}
	if len(dag) != 3 {
		t.Fatalf("expected 3 snapshots, got %d", len(dag))
	}

	// Parent-before-child order: A, B, C
	if dag[0].ID != idA {
		t.Fatalf("expected first = A, got %s", dag[0].ID[:12])
	}
	if dag[1].ID != idB {
		t.Fatalf("expected second = B, got %s", dag[1].ID[:12])
	}
	if dag[2].ID != idC {
		t.Fatalf("expected third = C, got %s", dag[2].ID[:12])
	}
}

func TestGitMappingRoundTrip(t *testing.T) {
	configDir := t.TempDir()

	// Loading non-existent file returns empty mapping
	m, err := gitstore.LoadGitMapping(configDir)
	if err != nil {
		t.Fatalf("LoadGitMapping empty: %v", err)
	}
	if len(m.Snapshots) != 0 {
		t.Fatalf("expected empty snapshots, got %d", len(m.Snapshots))
	}

	// Save and reload
	m.RepoPath = "/test/repo"
	m.Snapshots["snap-1"] = "abc123"
	m.Snapshots["snap-2"] = "def456"

	if err := gitstore.SaveGitMapping(configDir, m); err != nil {
		t.Fatalf("SaveGitMapping: %v", err)
	}

	loaded, err := gitstore.LoadGitMapping(configDir)
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}
	if loaded.RepoPath != "/test/repo" {
		t.Fatalf("expected RepoPath /test/repo, got %s", loaded.RepoPath)
	}
	if len(loaded.Snapshots) != 2 {
		t.Fatalf("expected 2 snapshots, got %d", len(loaded.Snapshots))
	}
	if loaded.Snapshots["snap-1"] != "abc123" {
		t.Fatalf("expected abc123, got %s", loaded.Snapshots["snap-1"])
	}
}

func TestCommitMetaFromSnapshot(t *testing.T) {
	// With author name and email
	snap := &store.SnapshotMeta{
		AuthorName:  "John Doe",
		AuthorEmail: "john@example.com",
		CreatedAt:   "2024-01-01T00:00:00Z",
	}
	meta := gitstore.CommitMetaFromSnapshot(snap)
	if meta == nil {
		t.Fatalf("expected non-nil meta")
	}
	if meta.AuthorName != "John Doe" {
		t.Fatalf("expected AuthorName 'John Doe', got %q", meta.AuthorName)
	}
	if meta.AuthorEmail != "john@example.com" {
		t.Fatalf("expected AuthorEmail, got %q", meta.AuthorEmail)
	}
	if meta.AuthorDate != "2024-01-01T00:00:00Z" {
		t.Fatalf("expected AuthorDate, got %q", meta.AuthorDate)
	}
	if meta.CommitterName != "John Doe" {
		t.Fatalf("expected CommitterName, got %q", meta.CommitterName)
	}

	// With agent name (no author)
	snap2 := &store.SnapshotMeta{
		Agent:     "Claude Code",
		CreatedAt: "2024-01-01T00:00:00Z",
	}
	meta2 := gitstore.CommitMetaFromSnapshot(snap2)
	if meta2 == nil {
		t.Fatalf("expected non-nil meta for agent")
	}
	if meta2.AuthorName != "Claude Code" {
		t.Fatalf("expected AuthorName 'Claude Code', got %q", meta2.AuthorName)
	}
	if meta2.AuthorEmail != "claude-code@fastest.local" {
		t.Fatalf("expected agent email, got %q", meta2.AuthorEmail)
	}

	// Empty snapshot — no useful metadata
	snap3 := &store.SnapshotMeta{}
	meta3 := gitstore.CommitMetaFromSnapshot(snap3)
	if meta3 != nil {
		t.Fatalf("expected nil meta for empty snapshot")
	}
}

// gitOutput runs a git command and returns the trimmed stdout.
func gitOutput(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
	return strings.TrimSpace(string(output))
}

// nonEmptyLines splits a string into non-empty lines.
func nonEmptyLines(s string) []string {
	var lines []string
	for _, line := range strings.Split(s, "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}
