package commands

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/backend"
	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitstore"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func TestBackendConfigRoundTrip(t *testing.T) {
	root := t.TempDir()

	// Save config with backend
	cfg := &config.ProjectConfig{
		ProjectID:   "proj-123",
		ProjectName: "test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type:   "github",
			Repo:   "owner/repo",
			Remote: "origin",
		},
	}
	if err := config.SaveProjectConfigAt(root, cfg); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	// Load and verify
	loaded, err := config.LoadProjectConfigAt(root)
	if err != nil {
		t.Fatalf("LoadProjectConfigAt: %v", err)
	}
	if loaded.Backend == nil {
		t.Fatalf("expected backend config")
	}
	if loaded.Backend.Type != "github" {
		t.Fatalf("expected github, got %s", loaded.Backend.Type)
	}
	if loaded.Backend.Repo != "owner/repo" {
		t.Fatalf("expected owner/repo, got %s", loaded.Backend.Repo)
	}
	if loaded.Backend.Remote != "origin" {
		t.Fatalf("expected origin, got %s", loaded.Backend.Remote)
	}
	if loaded.BackendType() != "github" {
		t.Fatalf("BackendType() expected github, got %s", loaded.BackendType())
	}
}

func TestBackendConfigBackwardCompat(t *testing.T) {
	root := t.TempDir()

	// Save config WITHOUT backend (simulates old config)
	cfg := &config.ProjectConfig{
		ProjectID:   "proj-456",
		ProjectName: "old-project",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveProjectConfigAt(root, cfg); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	// Load and verify backward compat
	loaded, err := config.LoadProjectConfigAt(root)
	if err != nil {
		t.Fatalf("LoadProjectConfigAt: %v", err)
	}
	if loaded.Backend != nil {
		t.Fatalf("expected nil backend")
	}
	if loaded.BackendType() != "" {
		t.Fatalf("BackendType() expected empty, got %s", loaded.BackendType())
	}
}

func TestBackendFromConfig(t *testing.T) {
	// nil config → nil backend
	if b := backend.FromConfig(nil, RunExportGitAt); b != nil {
		t.Fatalf("expected nil for nil config")
	}

	// github
	b := backend.FromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo", Remote: "origin"}, RunExportGitAt)
	if b == nil {
		t.Fatalf("expected github backend")
	}
	if b.Type() != "github" {
		t.Fatalf("expected github type, got %s", b.Type())
	}

	// git
	b = backend.FromConfig(&config.BackendConfig{Type: "git"}, RunExportGitAt)
	if b == nil {
		t.Fatalf("expected git backend")
	}
	if b.Type() != "git" {
		t.Fatalf("expected git type, got %s", b.Type())
	}

	// unknown → nil
	b = backend.FromConfig(&config.BackendConfig{Type: "unknown"}, RunExportGitAt)
	if b != nil {
		t.Fatalf("expected nil for unknown type")
	}

	// github without remote → defaults to origin
	ghb := backend.FromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo"}, RunExportGitAt)
	gh, ok := ghb.(*backend.GitHubBackend)
	if !ok {
		t.Fatalf("expected *GitHubBackend")
	}
	if gh.Remote != "origin" {
		t.Fatalf("expected default remote 'origin', got %s", gh.Remote)
	}
}

func TestGitBackendNoRemote(t *testing.T) {
	b := &backend.GitBackend{ExportGit: RunExportGitAt}
	// Pull returns ErrNoRemote since git backend has no remote
	if err := b.Pull("/tmp/nonexistent"); err != backend.ErrNoRemote {
		t.Fatalf("expected ErrNoRemote from Pull, got %v", err)
	}
	// Sync does a local export (same as Push), not ErrNoRemote
}

func TestBackendSetGit(t *testing.T) {
	// Set up a project with a workspace and snapshot
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-git-test",
		ProjectName: "git-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	// Create a workspace with a snapshot
	wsRoot := filepath.Join(projectRoot, "main")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-git-test", "ws-1", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "hello.txt"), []byte("world"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}

	wsCfg, err := config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	snapID, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("createImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snapID
	wsCfg.BaseSnapshotID = snapID
	if err := config.SaveAt(wsRoot, wsCfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snapID,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	// Run backend set git
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"backend", "set", "git"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("backend set git: %v", err)
	}

	// Verify project config has backend config
	parentCfg, err := config.LoadProjectConfigAt(projectRoot)
	if err != nil {
		t.Fatalf("LoadProjectConfigAt: %v", err)
	}
	if parentCfg.Backend == nil {
		t.Fatalf("expected backend config")
	}
	if parentCfg.Backend.Type != "git" {
		t.Fatalf("expected git, got %s", parentCfg.Backend.Type)
	}

	// Verify .git directory exists
	if _, err := os.Stat(filepath.Join(projectRoot, ".git")); err != nil {
		t.Fatalf("expected .git directory: %v", err)
	}

	// Verify git branch exists
	branches := gitOutput(t, projectRoot, "branch", "--list")
	if !containsLine(branches, "main") {
		t.Fatalf("expected 'main' branch, got: %s", branches)
	}
}

func TestBackendOff(t *testing.T) {
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-off-test",
		ProjectName: "off-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type: "git",
		},
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"backend", "off"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("backend off: %v", err)
	}

	parentCfg, err := config.LoadProjectConfigAt(projectRoot)
	if err != nil {
		t.Fatalf("LoadProjectConfigAt: %v", err)
	}
	if parentCfg.Backend != nil {
		t.Fatalf("expected nil backend after off")
	}
}

func TestBackendStatus(t *testing.T) {
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-status-test",
		ProjectName: "status-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type:   "github",
			Repo:   "owner/repo",
			Remote: "origin",
		},
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	restoreCwd := chdir(t, projectRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"backend", "status"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("backend status: %v", err)
	}
}

func TestBackendAutoExport(t *testing.T) {
	// Create a project with git backend and workspace
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-auto",
		ProjectName: "auto-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type: "git",
		},
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	// Create workspace with initial snapshot
	wsRoot := filepath.Join(projectRoot, "main")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-auto", "ws-auto", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("v1"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	wsCfg, _ := config.LoadAt(wsRoot)
	snapID, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("createImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snapID
	wsCfg.BaseSnapshotID = snapID
	_ = config.SaveAt(wsRoot, wsCfg)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snapID,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	// Initialize git and export
	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		t.Fatalf("initial export: %v", err)
	}

	// Get initial commit count
	initialCommits := gitOutput(t, projectRoot, "rev-list", "--count", "main", "--")

	// Add a second snapshot
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("v2"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	snap2, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, []string{snapID}, "second", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("createImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snap2
	_ = config.SaveAt(wsRoot, wsCfg)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snap2,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	// Use the git backend's Push
	b := &backend.GitBackend{ExportGit: RunExportGitAt}
	if err := b.Push(projectRoot); err != nil {
		t.Fatalf("Push: %v", err)
	}

	// Verify new commit was created
	newCommits := gitOutput(t, projectRoot, "rev-list", "--count", "main", "--")
	if newCommits == initialCommits {
		t.Fatalf("expected new commit after AfterSnapshot")
	}
}

func TestIncrementalImport(t *testing.T) {
	// Create a project and export to git
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-incr",
		ProjectName: "incr-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsRoot := filepath.Join(projectRoot, "main")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-incr", "ws-incr", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("v1"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	wsCfg, _ := config.LoadAt(wsRoot)
	snapID, _ := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	wsCfg.CurrentSnapshotID = snapID
	wsCfg.BaseSnapshotID = snapID
	_ = config.SaveAt(wsRoot, wsCfg)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snapID,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	// Init git and export
	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		t.Fatalf("initial export: %v", err)
	}

	// Now add a commit directly to git (simulates a remote push)
	addTempDir := t.TempDir()
	addIndexPath := filepath.Join(addTempDir, "index")
	addWorkDir := filepath.Join(addTempDir, "worktree")
	if err := os.MkdirAll(addWorkDir, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	addGit := gitutil.NewEnv(projectRoot, addWorkDir, addIndexPath)

	// Checkout current tree, add a file, commit
	if err := gitutil.CheckoutTree(addGit, "main"); err != nil {
		t.Fatalf("checkout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(addWorkDir, "new.txt"), []byte("from remote"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := addGit.Run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	treeSHA, err := gitutil.TreeSHA(addGit)
	if err != nil {
		t.Fatalf("TreeSHA: %v", err)
	}
	parentSHA, err := gitutil.RefSHA(addGit, "refs/heads/main")
	if err != nil {
		t.Fatalf("RefSHA: %v", err)
	}
	newSHA, err := gitutil.CreateCommitWithParents(addGit, treeSHA, "remote commit", []string{parentSHA}, nil)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if err := gitutil.UpdateBranchRef(addGit, "main", newSHA); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}

	// Run incremental import
	if _, err := backend.IncrementalImportFromGit(projectRoot); err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}

	// Verify a new snapshot was created
	wsCfg, err = config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if wsCfg.CurrentSnapshotID == snapID {
		t.Fatalf("expected snapshot to change after incremental import")
	}

	// Verify the new snapshot has the correct parent
	newSnap, err := s.LoadSnapshotMeta(wsCfg.CurrentSnapshotID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta: %v", err)
	}
	if len(newSnap.ParentSnapshotIDs) == 0 {
		t.Fatalf("expected new snapshot to have a parent")
	}
}

func TestIncrementalImportSkipsKnown(t *testing.T) {
	// Export and immediately try incremental import — should have no new snapshots
	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-skip",
		ProjectName: "skip-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsRoot := filepath.Join(projectRoot, "main")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-skip", "ws-skip", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("data"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	wsCfg, _ := config.LoadAt(wsRoot)
	snapID, _ := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	wsCfg.CurrentSnapshotID = snapID
	wsCfg.BaseSnapshotID = snapID
	_ = config.SaveAt(wsRoot, wsCfg)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snapID,
		BaseSnapshotID:    snapID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		t.Fatalf("export: %v", err)
	}

	// Incremental import should find nothing new
	if _, err := backend.IncrementalImportFromGit(projectRoot); err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}

	// Snapshot should be unchanged
	wsCfg, _ = config.LoadAt(wsRoot)
	if wsCfg.CurrentSnapshotID != snapID {
		t.Fatalf("expected snapshot unchanged, but got %s (was %s)", wsCfg.CurrentSnapshotID, snapID)
	}
}

func TestIsPushRejected(t *testing.T) {
	tests := []struct {
		output   string
		expected bool
	}{
		{"To github.com:user/repo.git\n ! [rejected]        main -> main (non-fast-forward)\n", true},
		{"error: failed to push some refs to 'origin'\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart. Integrate the remote changes (e.g.\nhint: 'git pull ...') before pushing again.\nhint: See the 'Note about fast-forwards' in 'git push --help' for details.\n", true},
		{"! [rejected] main -> main (fetch first)\n", true},
		{"fatal: repository 'https://github.com/user/repo.git/' not found\n", false},
		{"fatal: Authentication failed for 'https://github.com/user/repo.git/'\n", false},
		{"fatal: unable to access 'https://github.com/user/repo.git/': Could not resolve host: github.com\n", false},
		{"Everything up-to-date\n", false},
	}
	for _, tt := range tests {
		if got := gitutil.IsPushRejected(tt.output); got != tt.expected {
			t.Errorf("gitutil.IsPushRejected(%q) = %v, want %v", tt.output[:min(50, len(tt.output))], got, tt.expected)
		}
	}
}

func TestIsAncestor(t *testing.T) {
	projectRoot := t.TempDir()
	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")

	tmpDir := t.TempDir()
	indexPath := filepath.Join(tmpDir, "index")
	git := gitutil.NewEnv(projectRoot, tmpDir, indexPath)

	// Create initial commit
	if err := os.WriteFile(filepath.Join(tmpDir, "file.txt"), []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := git.Run("add", "-A"); err != nil {
		t.Fatal(err)
	}
	tree1, _ := gitutil.TreeSHA(git)
	sha1, err := gitutil.CreateCommitWithParents(git, tree1, "first", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = gitutil.UpdateBranchRef(git, "test", sha1)

	// Create child commit
	if err := os.WriteFile(filepath.Join(tmpDir, "file.txt"), []byte("v2"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := git.Run("add", "-A"); err != nil {
		t.Fatal(err)
	}
	tree2, _ := gitutil.TreeSHA(git)
	sha2, err := gitutil.CreateCommitWithParents(git, tree2, "second", []string{sha1}, nil)
	if err != nil {
		t.Fatal(err)
	}

	// sha1 is ancestor of sha2
	if !gitutil.IsAncestor(git, sha1, sha2) {
		t.Fatalf("expected sha1 to be ancestor of sha2")
	}
	// sha2 is NOT ancestor of sha1
	if gitutil.IsAncestor(git, sha2, sha1) {
		t.Fatalf("expected sha2 NOT to be ancestor of sha1")
	}
	// sha1 is ancestor of itself
	if !gitutil.IsAncestor(git, sha1, sha1) {
		t.Fatalf("expected sha1 to be ancestor of itself")
	}
}

func TestIncrementalImportDivergence(t *testing.T) {
	// Scenario:
	//   1. Create project with workspace, snapshot snap-A, export to git (commit C1)
	//   2. Create local snapshot snap-B (child of snap-A), update workspace head
	//   3. Add commit C2 to git branch (simulating remote push)
	//   4. Run IncrementalImportFromGit
	//   5. Verify: snap-X imported from C2, workspace head stays at snap-B,
	//      divergence info reports localHead=snap-B, remoteHead=snap-X, mergeBase=snap-A

	projectRoot := t.TempDir()
	if err := config.SaveProjectConfigAt(projectRoot, &config.ProjectConfig{
		ProjectID:   "proj-div",
		ProjectName: "div-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}
	s := store.OpenAt(projectRoot)
	if err := s.EnsureDirs(); err != nil {
		t.Fatalf("EnsureDirs: %v", err)
	}

	wsRoot := filepath.Join(projectRoot, "main")
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := config.InitAt(wsRoot, "proj-div", "ws-div", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("v1"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	wsCfg, _ := config.LoadAt(wsRoot)
	snapA, _ := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	wsCfg.CurrentSnapshotID = snapA
	wsCfg.BaseSnapshotID = snapA
	_ = config.SaveAt(wsRoot, wsCfg)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       wsCfg.WorkspaceID,
		WorkspaceName:     "main",
		Path:              wsRoot,
		CurrentSnapshotID: snapA,
		BaseSnapshotID:    snapA,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	})

	// Init git and export (snap-A → C1)
	runGit(t, projectRoot, "init")
	runGit(t, projectRoot, "config", "user.name", "Test")
	runGit(t, projectRoot, "config", "user.email", "test@test.com")
	if err := RunExportGitAt(projectRoot, false, false); err != nil {
		t.Fatalf("initial export: %v", err)
	}

	// Step 2: Create local snapshot snap-B (child of snap-A)
	if err := os.WriteFile(filepath.Join(wsRoot, "test.txt"), []byte("local change"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	snapB, err := gitstore.CreateImportedSnapshot(s, wsRoot, wsCfg, []string{snapA}, "local work", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
	if err != nil {
		t.Fatalf("createImportedSnapshot: %v", err)
	}
	wsCfg.CurrentSnapshotID = snapB
	_ = config.SaveAt(wsRoot, wsCfg)

	// Step 3: Add commit C2 to git (simulating remote push)
	addTempDir := t.TempDir()
	addWorkDir := filepath.Join(addTempDir, "worktree")
	if err := os.MkdirAll(addWorkDir, 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	addGit := gitutil.NewEnv(projectRoot, addWorkDir, filepath.Join(addTempDir, "index"))
	if err := gitutil.CheckoutTree(addGit, "main"); err != nil {
		t.Fatalf("checkout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(addWorkDir, "remote.txt"), []byte("remote change"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := addGit.Run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	treeSHA, _ := gitutil.TreeSHA(addGit)
	parentSHA, _ := gitutil.RefSHA(addGit, "refs/heads/main")
	newSHA, err := gitutil.CreateCommitWithParents(addGit, treeSHA, "remote commit", []string{parentSHA}, nil)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if err := gitutil.UpdateBranchRef(addGit, "main", newSHA); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}

	// Step 4: Run incremental import
	result, err := backend.IncrementalImportFromGit(projectRoot)
	if err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}

	// Step 5: Verify divergence detected
	if len(result.Diverged) == 0 {
		t.Fatalf("expected divergence info, got none")
	}
	if result.NewSnapshots != 1 {
		t.Fatalf("expected 1 new snapshot, got %d", result.NewSnapshots)
	}

	div := result.Diverged[0]
	if div.WorkspaceName != "main" {
		t.Fatalf("expected workspace 'main', got %s", div.WorkspaceName)
	}
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
	wsCfg, err = config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if wsCfg.CurrentSnapshotID != snapB {
		t.Fatalf("expected workspace head to remain snap-B (%s), got %s", snapB, wsCfg.CurrentSnapshotID)
	}
}

func containsLine(output, target string) bool {
	for _, line := range splitLines(output) {
		trimmed := trimAll(line)
		if trimmed == target {
			return true
		}
	}
	return false
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i, c := range s {
		if c == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func trimAll(s string) string {
	result := ""
	for _, c := range s {
		if c != ' ' && c != '\t' && c != '*' {
			result += string(c)
		}
	}
	return result
}
