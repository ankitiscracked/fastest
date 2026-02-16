package commands

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

// setupExportRepo creates a git repository that looks like the output of
// `fst git export` — with branches and export metadata in refs/fst/meta.
// workspaces is a map of workspace name → ordered list of (message, files) pairs.
// The first workspace's first commit is shared as the base across all workspaces.
// Returns the repo path.
type commitSpec struct {
	Message string
	Files   map[string]string
}

func setupExportRepo(t *testing.T, projectID string, workspaces map[string][]commitSpec) string {
	t.Helper()

	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Test")
	runGit(t, repo, "config", "user.email", "test@example.com")

	tempDir := t.TempDir()
	git := gitutil.NewEnv(repo, tempDir, filepath.Join(tempDir, "index"))

	// We need to create a shared initial commit so branches can share ancestry.
	// Write a base file, commit on an orphan branch, then build workspace branches from there.
	if err := os.WriteFile(filepath.Join(repo, "base.txt"), []byte("base"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	runGit(t, repo, "add", "-A")
	runGit(t, repo, "commit", "-m", "base commit")

	// Get the base commit SHA
	baseSHA := gitOutput(t, repo, "rev-parse", "HEAD")

	wsIndex := 0
	for wsName, commits := range workspaces {
		branchName := wsName

		// Create branch from base
		runGit(t, repo, "checkout", "-B", branchName, baseSHA)

		for _, spec := range commits {
			// Write files
			for path, content := range spec.Files {
				full := filepath.Join(repo, path)
				if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
					t.Fatalf("mkdir: %v", err)
				}
				if err := os.WriteFile(full, []byte(content), 0644); err != nil {
					t.Fatalf("write: %v", err)
				}
			}
			runGit(t, repo, "add", "-A")
			runGit(t, repo, "commit", "-m", spec.Message)
		}

		// Update export metadata for this workspace
		wsID := wsName + "-id"
		if err := gitstore.UpdateExportMetadata(git, &config.ProjectConfig{
			ProjectID:     projectID,
			WorkspaceID:   wsID,
			WorkspaceName: wsName,
		}, branchName); err != nil {
			t.Fatalf("updateExportMetadata for %s: %v", wsName, err)
		}

		wsIndex++
	}

	return repo
}

func TestImportGitRequiresMetadata(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Test")
	runGit(t, repo, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	runGit(t, repo, "add", "-A")
	runGit(t, repo, "commit", "-m", "init")

	root := t.TempDir()
	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo, "--project", "demo"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected import to fail without metadata")
	}
}

func TestImportGitCreatesProjectAndWorkspace(t *testing.T) {
	repo := t.TempDir()
	runGit(t, repo, "init")
	runGit(t, repo, "config", "user.name", "Test")
	runGit(t, repo, "config", "user.email", "test@example.com")
	if err := os.WriteFile(filepath.Join(repo, "a.txt"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}
	runGit(t, repo, "add", "-A")
	runGit(t, repo, "commit", "-m", "init")
	runGit(t, repo, "branch", "-M", "main")

	tempDir := t.TempDir()
	git := gitutil.NewEnv(repo, tempDir, filepath.Join(tempDir, "index"))
	if err := gitstore.UpdateExportMetadata(git, &config.ProjectConfig{
		ProjectID:     "proj-123",
		WorkspaceID:   "ws-1",
		WorkspaceName: "main",
	}, "main"); err != nil {
		t.Fatalf("updateExportMetadata: %v", err)
	}

	root := t.TempDir()
	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo, "--project", "demo"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("import failed: %v", err)
	}

	workspaceRoot := filepath.Join(root, "demo", "main")
	if _, err := os.Stat(filepath.Join(workspaceRoot, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config: %v", err)
	}
	latest, err := config.GetLatestSnapshotIDAt(workspaceRoot)
	if err != nil {
		t.Fatalf("GetLatestSnapshotIDAt: %v", err)
	}
	if latest == "" {
		t.Fatalf("expected snapshots to be imported")
	}
}

func TestImportGitMultiWorkspace(t *testing.T) {
	repo := setupExportRepo(t, "proj-multi", map[string][]commitSpec{
		"main": {
			{Message: "main work", Files: map[string]string{"main.txt": "hello"}},
		},
		"feature": {
			{Message: "feature work", Files: map[string]string{"feature.txt": "world"}},
		},
	})

	root := t.TempDir()
	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo, "--project", "multi"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("import failed: %v", err)
	}

	projectRoot := filepath.Join(root, "multi")

	// Both workspaces should be created
	for _, wsName := range []string{"main", "feature"} {
		wsRoot := filepath.Join(projectRoot, wsName)
		if _, err := os.Stat(filepath.Join(wsRoot, ".fst", "config.json")); err != nil {
			t.Fatalf("expected workspace config for %s: %v", wsName, err)
		}
		cfg, err := config.LoadAt(wsRoot)
		if err != nil {
			t.Fatalf("LoadAt %s: %v", wsName, err)
		}
		if cfg.CurrentSnapshotID == "" {
			t.Fatalf("expected snapshots imported for %s", wsName)
		}
	}

	// Both should have the same project ID
	mainCfg, _ := config.LoadAt(filepath.Join(projectRoot, "main"))
	featureCfg, _ := config.LoadAt(filepath.Join(projectRoot, "feature"))
	if mainCfg.ProjectID != featureCfg.ProjectID {
		t.Fatalf("project ID mismatch: main=%s feature=%s", mainCfg.ProjectID, featureCfg.ProjectID)
	}

	// Verify snapshots exist in shared store
	s := store.OpenAt(projectRoot)
	mainSnap, err := s.LoadSnapshotMeta(mainCfg.CurrentSnapshotID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta main: %v", err)
	}
	featureSnap, err := s.LoadSnapshotMeta(featureCfg.CurrentSnapshotID)
	if err != nil {
		t.Fatalf("LoadSnapshotMeta feature: %v", err)
	}

	// Each workspace has base commit + workspace commit = 2 commits.
	// The tip snapshots should have parents (from base commit).
	if len(mainSnap.ParentSnapshotIDs) == 0 {
		t.Fatalf("expected main snapshot to have parent (base commit)")
	}
	if len(featureSnap.ParentSnapshotIDs) == 0 {
		t.Fatalf("expected feature snapshot to have parent (base commit)")
	}

	// Verify the base snapshots exist in the store
	if _, err := s.LoadSnapshotMeta(mainSnap.ParentSnapshotIDs[0]); err != nil {
		t.Fatalf("base snapshot for main not in store: %v", err)
	}
	if _, err := s.LoadSnapshotMeta(featureSnap.ParentSnapshotIDs[0]); err != nil {
		t.Fatalf("base snapshot for feature not in store: %v", err)
	}
}

func TestImportGitIntoExistingProject(t *testing.T) {
	repo := setupExportRepo(t, "proj-existing", map[string][]commitSpec{
		"ws-new": {
			{Message: "new work", Files: map[string]string{"new.txt": "data"}},
		},
	})

	// Create an existing project
	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-existing",
		ProjectName: "existing",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
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
	cmd.SetArgs([]string{"git", "import", repo})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("import failed: %v", err)
	}

	// Workspace should be created under existing project
	wsRoot := filepath.Join(projectRoot, "ws-new")
	if _, err := os.Stat(filepath.Join(wsRoot, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config: %v", err)
	}
	cfg, err := config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if cfg.CurrentSnapshotID == "" {
		t.Fatalf("expected snapshots imported")
	}
}

func TestImportGitRebuild(t *testing.T) {
	// Use empty project ID so the mismatch check passes when re-importing
	// into the project created by the first import (which generates its own ID).
	repo := setupExportRepo(t, "", map[string][]commitSpec{
		"main": {
			{Message: "initial", Files: map[string]string{"a.txt": "v1"}},
		},
	})

	root := t.TempDir()
	restoreCwd := chdir(t, root)

	// First import — creates new project
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo, "--project", "rebuild-test"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("first import: %v", err)
	}
	restoreCwd()

	projectRoot := filepath.Join(root, "rebuild-test")

	// Second import without rebuild should fail (cwd inside existing project)
	restoreCwd = chdir(t, projectRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected second import without --rebuild to fail")
	}

	// Second import with rebuild should succeed
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"git", "import", repo, "--rebuild"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("rebuild import: %v", err)
	}
	restoreCwd()

	// Verify snapshots still exist
	wsRoot := filepath.Join(projectRoot, "main")
	cfg, err := config.LoadAt(wsRoot)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	if cfg.CurrentSnapshotID == "" {
		t.Fatalf("expected snapshots after rebuild import")
	}
}

func TestImportGitProjectIDMismatch(t *testing.T) {
	repo := setupExportRepo(t, "proj-AAA", map[string][]commitSpec{
		"main": {
			{Message: "work", Files: map[string]string{"a.txt": "data"}},
		},
	})

	// Create project with different ID
	projectRoot := t.TempDir()
	if err := config.SaveParentConfigAt(projectRoot, &config.ParentConfig{
		ProjectID:   "proj-BBB",
		ProjectName: "mismatch",
		CreatedAt:   time.Now().UTC().Format(time.RFC3339),
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
	cmd.SetArgs([]string{"git", "import", repo})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected import to fail with project ID mismatch")
	}
}

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}
