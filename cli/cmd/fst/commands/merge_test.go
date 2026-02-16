package commands

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
)

func TestMergeModeValidation(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "--manual"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected conflicting merge flags to fail")
	}
}

// setupProjectWithWorkspaces creates a project directory with two workspace
// subdirectories sharing the same project-level store. Both workspaces get
// an initial snapshot (empty), then diverge with the given file changes.
// Returns the project root, target root, and source root.
func setupProjectWithWorkspaces(t *testing.T, targetFiles, sourceFiles map[string]string) (string, string, string) {
	t.Helper()

	projectRoot := t.TempDir()

	// Create project config
	if err := os.MkdirAll(filepath.Join(projectRoot, ".fst"), 0755); err != nil {
		t.Fatalf("mkdir .fst: %v", err)
	}
	if err := os.WriteFile(filepath.Join(projectRoot, ".fst", "config.json"), []byte(`{"type":"project","project_id":"proj-test","project_name":"test-project"}`), 0644); err != nil {
		t.Fatalf("write config.json: %v", err)
	}

	// Create shared store directories
	for _, d := range []string{".fst/snapshots", ".fst/manifests", ".fst/blobs", ".fst/workspaces"} {
		if err := os.MkdirAll(filepath.Join(projectRoot, d), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	targetRoot := filepath.Join(projectRoot, "ws-target")
	sourceRoot := filepath.Join(projectRoot, "ws-source")

	// Create workspace directories with config
	for _, ws := range []struct {
		root, id, name string
	}{
		{targetRoot, "ws-target-id", "ws-target"},
		{sourceRoot, "ws-source-id", "ws-source"},
	} {
		if err := os.MkdirAll(filepath.Join(ws.root, ".fst"), 0755); err != nil {
			t.Fatalf("mkdir ws .fst: %v", err)
		}
		cfg := &config.ProjectConfig{
			ProjectID:     "proj-1",
			WorkspaceID:   ws.id,
			WorkspaceName: ws.name,
			Mode:          "local",
		}
		if err := config.SaveAt(ws.root, cfg); err != nil {
			t.Fatalf("SaveAt: %v", err)
		}

		// Write a base file so initial snapshot is non-empty
		if err := os.WriteFile(filepath.Join(ws.root, "base.txt"), []byte("base"), 0644); err != nil {
			t.Fatalf("write base.txt: %v", err)
		}
	}

	// Create initial snapshots for both workspaces (they share the project store)
	restoreCwd := chdir(t, targetRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "base snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("target base snapshot failed: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, sourceRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "base snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("source base snapshot failed: %v", err)
	}
	restoreCwd()

	// Add divergent changes
	for path, content := range targetFiles {
		full := filepath.Join(targetRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write target file: %v", err)
		}
	}
	for path, content := range sourceFiles {
		full := filepath.Join(sourceRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write source file: %v", err)
		}
	}

	// Take post-change snapshots
	restoreCwd = chdir(t, targetRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "target changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("target snapshot failed: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, sourceRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "source changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("source snapshot failed: %v", err)
	}
	restoreCwd()

	return projectRoot, targetRoot, sourceRoot
}

func TestMergeDryRunPlan(t *testing.T) {
	_, targetRoot, _ := setupProjectWithWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"merge", "ws-source", "--dry-run", "--force"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("merge dry-run failed: %v", err)
	}
	if !strings.Contains(output, "Merge plan") {
		t.Fatalf("expected merge plan output, got:\n%s", output)
	}
}

func TestMergeAutoSnapshot(t *testing.T) {
	_, targetRoot, _ := setupProjectWithWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	targetCfg, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target: %v", err)
	}
	targetBefore := targetCfg.CurrentSnapshotID

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "ws-source", "--theirs", "--force"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("merge failed: %v", err)
	}

	targetCfgAfter, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target after: %v", err)
	}
	if targetCfgAfter.CurrentSnapshotID == targetBefore {
		t.Fatalf("expected merge to create a new snapshot")
	}
}

func TestMergeAbortClearsPendingParents(t *testing.T) {
	root := setupWorkspace(t, "ws-merge-abort", map[string]string{
		"file.txt": "base",
	})

	if err := config.WritePendingMergeParentsAt(root, []string{"snap-a", "snap-b"}); err != nil {
		t.Fatalf("WritePendingMergeParentsAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "--abort"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("merge --abort failed: %v", err)
	}

	parents, err := config.ReadPendingMergeParentsAt(root)
	if err != nil {
		t.Fatalf("ReadPendingMergeParentsAt: %v", err)
	}
	if len(parents) != 0 {
		t.Fatalf("expected pending parents to be cleared, got %v", parents)
	}

	mergeParentsPath := filepath.Join(root, ".fst", "merge-parents.json")
	if _, err := os.Stat(mergeParentsPath); err == nil {
		t.Fatalf("expected merge-parents.json to be removed")
	}
}
