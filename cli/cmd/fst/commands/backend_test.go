package commands

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func TestBackendConfigRoundTrip(t *testing.T) {
	root := t.TempDir()

	// Save config with backend
	cfg := &config.ParentConfig{
		ProjectID:   "proj-123",
		ProjectName: "test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type:   "github",
			Repo:   "owner/repo",
			Remote: "origin",
		},
	}
	if err := config.SaveParentConfigAt(root, cfg); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Load and verify
	loaded, err := config.LoadParentConfigAt(root)
	if err != nil {
		t.Fatalf("LoadParentConfigAt: %v", err)
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
	cfg := &config.ParentConfig{
		ProjectID:   "proj-456",
		ProjectName: "old-project",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}
	if err := config.SaveParentConfigAt(root, cfg); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	// Load and verify backward compat
	loaded, err := config.LoadParentConfigAt(root)
	if err != nil {
		t.Fatalf("LoadParentConfigAt: %v", err)
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
	if b := BackendFromConfig(nil); b != nil {
		t.Fatalf("expected nil for nil config")
	}

	// github
	b := BackendFromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo", Remote: "origin"})
	if b == nil {
		t.Fatalf("expected github backend")
	}
	if b.Type() != "github" {
		t.Fatalf("expected github type, got %s", b.Type())
	}

	// git
	b = BackendFromConfig(&config.BackendConfig{Type: "git"})
	if b == nil {
		t.Fatalf("expected git backend")
	}
	if b.Type() != "git" {
		t.Fatalf("expected git type, got %s", b.Type())
	}

	// unknown → nil
	b = BackendFromConfig(&config.BackendConfig{Type: "unknown"})
	if b != nil {
		t.Fatalf("expected nil for unknown type")
	}

	// github without remote → defaults to origin
	ghb := BackendFromConfig(&config.BackendConfig{Type: "github", Repo: "owner/repo"})
	gh, ok := ghb.(*GitHubBackend)
	if !ok {
		t.Fatalf("expected *GitHubBackend")
	}
	if gh.Remote != "origin" {
		t.Fatalf("expected default remote 'origin', got %s", gh.Remote)
	}
}

func TestGitBackendNoRemote(t *testing.T) {
	b := &GitBackend{}
	if err := b.Sync("/tmp/nonexistent"); err != backend.ErrNoRemote {
		t.Fatalf("expected ErrNoRemote from Sync, got %v", err)
	}
	if err := b.Pull("/tmp/nonexistent"); err != backend.ErrNoRemote {
		t.Fatalf("expected ErrNoRemote from Pull, got %v", err)
	}
}

func TestBackendSetGit(t *testing.T) {
	// Set up a project with a workspace and snapshot
	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-git-test",
		ProjectName: "git-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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
	snapID, err := createImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
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

	// Verify fst.json has backend config
	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		t.Fatalf("LoadParentConfigAt: %v", err)
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
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-off-test",
		ProjectName: "off-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type: "git",
		},
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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

	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		t.Fatalf("LoadParentConfigAt: %v", err)
	}
	if parentCfg.Backend != nil {
		t.Fatalf("expected nil backend after off")
	}
}

func TestBackendStatus(t *testing.T) {
	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-status-test",
		ProjectName: "status-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type:   "github",
			Repo:   "owner/repo",
			Remote: "origin",
		},
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-auto",
		ProjectName: "auto-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
		Backend: &config.BackendConfig{
			Type: "git",
		},
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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
	snapID, err := createImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
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
	snap2, err := createImportedSnapshot(s, wsRoot, wsCfg, []string{snapID}, "second", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
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

	// Use the git backend's AfterSnapshot
	b := &GitBackend{}
	if err := b.AfterSnapshot(projectRoot); err != nil {
		t.Fatalf("AfterSnapshot: %v", err)
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
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-incr",
		ProjectName: "incr-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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
	snapID, _ := createImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
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
	addGit := newGitEnv(projectRoot, addWorkDir, addIndexPath)

	// Checkout current tree, add a file, commit
	if err := gitCheckoutTree(addGit, "main"); err != nil {
		t.Fatalf("checkout: %v", err)
	}
	if err := os.WriteFile(filepath.Join(addWorkDir, "new.txt"), []byte("from remote"), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := addGit.run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	treeSHA, err := getGitTreeSHA(addGit)
	if err != nil {
		t.Fatalf("getGitTreeSHA: %v", err)
	}
	parentSHA, err := gitRefSHA(addGit, "refs/heads/main")
	if err != nil {
		t.Fatalf("gitRefSHA: %v", err)
	}
	newSHA, err := createGitCommitWithParents(addGit, treeSHA, "remote commit", []string{parentSHA}, nil)
	if err != nil {
		t.Fatalf("createGitCommitWithParents: %v", err)
	}
	if err := updateGitBranchRef(addGit, "main", newSHA); err != nil {
		t.Fatalf("updateGitBranchRef: %v", err)
	}

	// Run incremental import
	if err := IncrementalImportFromGit(projectRoot); err != nil {
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
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-skip",
		ProjectName: "skip-test",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
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
	snapID, _ := createImportedSnapshot(s, wsRoot, wsCfg, nil, "initial", time.Now().UTC().Format(time.RFC3339), "Test", "test@test.com", "")
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
	if err := IncrementalImportFromGit(projectRoot); err != nil {
		t.Fatalf("IncrementalImportFromGit: %v", err)
	}

	// Snapshot should be unchanged
	wsCfg, _ = config.LoadAt(wsRoot)
	if wsCfg.CurrentSnapshotID != snapID {
		t.Fatalf("expected snapshot unchanged, but got %s (was %s)", wsCfg.CurrentSnapshotID, snapID)
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
