package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

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
	git := newGitEnv(repo, tempDir, filepath.Join(tempDir, "index"))
	if err := updateExportMetadata(git, &config.ProjectConfig{
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

func runGit(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, output)
	}
}
