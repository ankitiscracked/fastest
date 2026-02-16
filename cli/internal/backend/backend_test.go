package backend

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitstore"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

// stubExport is a no-op ExportFunc for tests that don't need real git export.
func stubExport(projectRoot string, initRepo, rebuild bool) error {
	return nil
}

func TestFromConfigNil(t *testing.T) {
	if b := FromConfig(nil, stubExport); b != nil {
		t.Fatalf("expected nil for nil config")
	}
}

func TestFromConfigGitHub(t *testing.T) {
	b := FromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo", Remote: "upstream"}, stubExport)
	if b == nil {
		t.Fatal("expected non-nil backend")
	}
	if b.Type() != "github" {
		t.Fatalf("expected github, got %s", b.Type())
	}
	gh, ok := b.(*GitHubBackend)
	if !ok {
		t.Fatal("expected *GitHubBackend")
	}
	if gh.Repo != "owner/repo" {
		t.Fatalf("expected owner/repo, got %s", gh.Repo)
	}
	if gh.Remote != "upstream" {
		t.Fatalf("expected upstream, got %s", gh.Remote)
	}
}

func TestFromConfigGitHubDefaultRemote(t *testing.T) {
	b := FromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo"}, stubExport)
	gh := b.(*GitHubBackend)
	if gh.Remote != "origin" {
		t.Fatalf("expected default remote 'origin', got %s", gh.Remote)
	}
}

func TestFromConfigGit(t *testing.T) {
	b := FromConfig(&config.BackendConfig{Type: "git"}, stubExport)
	if b == nil {
		t.Fatal("expected non-nil backend")
	}
	if b.Type() != "git" {
		t.Fatalf("expected git, got %s", b.Type())
	}
}

func TestFromConfigUnknown(t *testing.T) {
	b := FromConfig(&config.BackendConfig{Type: "unknown"}, stubExport)
	if b != nil {
		t.Fatalf("expected nil for unknown type")
	}
}

func TestGitBackendPullReturnsErrNoRemote(t *testing.T) {
	b := &GitBackend{ExportGit: stubExport}
	if err := b.Pull("/tmp/nonexistent"); err != ErrNoRemote {
		t.Fatalf("expected ErrNoRemote, got %v", err)
	}
}

func TestGitBackendPushCallsExport(t *testing.T) {
	called := false
	export := func(projectRoot string, initRepo, rebuild bool) error {
		called = true
		if initRepo || rebuild {
			t.Fatalf("expected initRepo=false, rebuild=false")
		}
		return nil
	}
	b := &GitBackend{ExportGit: export}
	if err := b.Push("/tmp"); err != nil {
		t.Fatalf("Push: %v", err)
	}
	if !called {
		t.Fatal("expected ExportGit to be called")
	}
}

func TestGitBackendSyncCallsPush(t *testing.T) {
	called := false
	export := func(projectRoot string, initRepo, rebuild bool) error {
		called = true
		return nil
	}
	b := &GitBackend{ExportGit: export}
	if err := b.Sync("/tmp", nil); err != nil {
		t.Fatalf("Sync: %v", err)
	}
	if !called {
		t.Fatal("expected ExportGit to be called via Sync")
	}
}

// runGit runs a git command in the given directory.
func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %v: %s", args, out)
	}
}

// setupProjectWithExport creates a minimal project with one workspace and snapshot,
// initializes git, exports the snapshot to a git commit, and updates the mapping.
// Returns (projectRoot, wsRoot, snapshotID, commitSHA).
func setupProjectWithExport(t *testing.T, projectID, wsName string) (string, string, string, string) {
	t.Helper()

	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   projectID,
		ProjectName: "test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsRoot := filepath.Join(projectRoot, wsName)
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, projectID, "ws-1", wsName, ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("v1"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	wsCfg, err := config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	snapID, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial",
		time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("CreateImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snapID
	wsCfg.BaseSnapshotID = snapID
	if err := config.SaveAt(wsRoot, wsCfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	if err := s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     wsName,
		Path:              wsRoot,
		CurrentSnapshotID: snapID,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	// Init git
	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")

	// Export the snapshot to git
	configDir := filepath.Join(projectRoot, ".fst")
	tmpDir := t.TempDir()
	g := gitutil.NewEnv(projectRoot, tmpDir, filepath.Join(tmpDir, "index"))

	mapping, err := gitstore.LoadGitMapping(configDir)
	if err != nil {
		t.Fatalf("LoadGitMapping: %v", err)
	}

	snap, err := s.LoadSnapshotMeta(snapID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	m, err := s.LoadManifest(snap.ManifestHash)
	if err != nil {
		t.Fatalf("LoadManifest: %v", err)
	}
	if err := gitstore.RestoreFilesFromManifest(tmpDir, s, m); err != nil {
		t.Fatalf("RestoreFilesFromManifest: %v", err)
	}
	if err := g.Run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	tree, err := gitutil.TreeSHA(g)
	if err != nil {
		t.Fatalf("TreeSHA: %v", err)
	}
	meta := gitstore.CommitMetaFromSnapshot(snap)
	commitSHA, err := gitutil.CreateCommitWithParents(g, tree, snap.Message, nil, meta)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if err := gitutil.UpdateBranchRef(g, wsName, commitSHA); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}
	mapping.Snapshots[snapID] = commitSHA
	if err := gitstore.SaveGitMapping(configDir, mapping); err != nil {
		t.Fatalf("SaveGitMapping: %v", err)
	}
	if err := gitstore.UpdateExportMetadata(g, wsCfg, wsName); err != nil {
		t.Fatalf("UpdateExportMetadata: %v", err)
	}

	return projectRoot, wsRoot, snapID, commitSHA
}

// addGitCommit adds a new commit to the given branch in the repo (simulating a remote push).
func addGitCommit(t *testing.T, repoDir, branch, filename, content, message, parentSHA string) string {
	t.Helper()
	addDir := t.TempDir()
	indexDir := t.TempDir()
	addGit := gitutil.NewEnv(repoDir, addDir, filepath.Join(indexDir, "index"))

	if err := gitutil.CheckoutTree(addGit, branch); err != nil {
		t.Fatalf("CheckoutTree: %v", err)
	}
	if err := os.WriteFile(filepath.Join(addDir, filename), []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := addGit.Run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	newTree, err := gitutil.TreeSHA(addGit)
	if err != nil {
		t.Fatalf("TreeSHA: %v", err)
	}
	newSHA, err := gitutil.CreateCommitWithParents(addGit, newTree, message, []string{parentSHA}, nil)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if err := gitutil.UpdateBranchRef(addGit, branch, newSHA); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}
	return newSHA
}

func TestIncrementalImportFromGit(t *testing.T) {
	projectRoot, wsRoot, snapID, commitSHA := setupProjectWithExport(t, "proj-incr", "main")

	// Verify the branch exists with our commit
	tmpCheck := t.TempDir()
	checkGit := gitutil.NewEnv(projectRoot, tmpCheck, filepath.Join(tmpCheck, "index"))
	branchSHA, err := gitutil.RefSHA(checkGit, "refs/heads/main")
	if err != nil {
		t.Fatalf("branch main doesn't exist: %v", err)
	}
	if branchSHA != commitSHA {
		t.Fatalf("expected branch at %s, got %s", commitSHA, branchSHA)
	}

	// Add a commit directly to git (simulating remote push)
	addGitCommit(t, projectRoot, "main", "new.txt", "from remote", "remote commit", commitSHA)

	// Run incremental import
	result, err := IncrementalImportFromGit(projectRoot)
	if err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}
	if result.NewSnapshots != 1 {
		t.Fatalf("expected 1 new snapshot, got %d", result.NewSnapshots)
	}

	// Workspace head should have been updated
	freshCfg, err := config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if freshCfg.CurrentSnapshotID == snapID {
		t.Fatalf("expected snapshot to change")
	}
}

func TestIncrementalImportSkipsKnown(t *testing.T) {
	projectRoot, wsRoot, snapID, _ := setupProjectWithExport(t, "proj-skip", "main")

	// Import without adding any new commits — should find nothing
	result, err := IncrementalImportFromGit(projectRoot)
	if err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}
	if result.NewSnapshots != 0 {
		t.Fatalf("expected 0 new snapshots, got %d", result.NewSnapshots)
	}

	// Snapshot should be unchanged
	wsCfg, _ := config.LoadAt(wsRoot)
	if wsCfg.CurrentSnapshotID != snapID {
		t.Fatalf("expected snapshot unchanged, got %s (was %s)", wsCfg.CurrentSnapshotID, snapID)
	}
}

func TestIncrementalImportDivergence(t *testing.T) {
	projectRoot, wsRoot, snapA, commitSHA := setupProjectWithExport(t, "proj-div", "main")

	// Create local snapshot snap-B (diverging from git)
	s := store.OpenAt(projectRoot)
	wsCfg, _ := config.LoadAt(wsRoot)
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("local change"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	snapB, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, []string{snapA}, "local work",
		time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("CreateImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snapB
	if err := config.SaveAt(wsRoot, wsCfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}

	// Add commit to git (simulating remote)
	addGitCommit(t, projectRoot, "main", "remote.txt", "remote change", "remote commit", commitSHA)

	// Import
	result, err := IncrementalImportFromGit(projectRoot)
	if err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}

	if result.NewSnapshots != 1 {
		t.Fatalf("expected 1 new snapshot, got %d", result.NewSnapshots)
	}
	if len(result.Diverged) != 1 {
		t.Fatalf("expected 1 diverged workspace, got %d", len(result.Diverged))
	}

	div := result.Diverged[0]
	if div.LocalHead != snapB {
		t.Fatalf("expected localHead=%s, got %s", snapB, div.LocalHead)
	}
	if div.MergeBase != snapA {
		t.Fatalf("expected mergeBase=%s, got %s", snapA, div.MergeBase)
	}
	if div.RemoteHead == "" || div.RemoteHead == snapA || div.RemoteHead == snapB {
		t.Fatalf("expected remoteHead to be a new snapshot, got %s", div.RemoteHead)
	}

	// Workspace head should still be snap-B (not overwritten)
	freshCfg, _ := config.LoadAt(wsRoot)
	if freshCfg.CurrentSnapshotID != snapB {
		t.Fatalf("expected head to stay at snap-B, got %s", freshCfg.CurrentSnapshotID)
	}
}
