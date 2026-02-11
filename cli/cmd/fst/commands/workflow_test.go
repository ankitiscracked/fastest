package commands

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

func TestSnapshotCreatesLocalArtifacts(t *testing.T) {
	root := setupWorkspace(t, "ws-snap", map[string]string{
		"a.txt": "hello",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "test snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot failed: %v", err)
	}

	manifestsDir := filepath.Join(root, ".fst", "manifests")
	snapshotsDir := filepath.Join(root, ".fst", "snapshots")
	entries, err := os.ReadDir(manifestsDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected manifest to be created")
	}
	entries, err = os.ReadDir(snapshotsDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected snapshot metadata to be created")
	}

	blobDir := filepath.Join(root, ".fst", "blobs")
	entries, err = os.ReadDir(blobDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected blob cache to be populated")
	}
}

func TestStatusRunsInWorkspace(t *testing.T) {
	root := setupWorkspace(t, "ws-status", map[string]string{
		"readme.md": "ok",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"status"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("status failed: %v", err)
	}
}

func TestDriftBetweenWorkspacesIncludeDirtyJSON(t *testing.T) {
	// setupProjectWithWorkspaces creates base.txt in both workspaces at base.
	// Target adds a.txt, Source adds a.txt (different content) + b.txt.
	_, targetRoot, sourceRoot := setupProjectWithWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"a.txt": "two", "b.txt": "new"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "ws-source", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var result struct {
		TheirChanges struct {
			FilesAdded []string `json:"files_added"`
		} `json:"their_changes"`
		OverlappingFiles []string `json:"overlapping_files"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if !contains(result.TheirChanges.FilesAdded, "b.txt") {
		t.Fatalf("expected b.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	if !contains(result.TheirChanges.FilesAdded, "a.txt") {
		t.Fatalf("expected a.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	_ = sourceRoot
}

func TestDriftBetweenWorkspacesNoDirtyJSON(t *testing.T) {
	_, targetRoot, sourceRoot := setupProjectWithWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"a.txt": "two", "b.txt": "new"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "ws-source", "--no-dirty", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var result struct {
		TheirChanges struct {
			FilesAdded []string `json:"files_added"`
		} `json:"their_changes"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if !contains(result.TheirChanges.FilesAdded, "b.txt") {
		t.Fatalf("expected b.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	if !contains(result.TheirChanges.FilesAdded, "a.txt") {
		t.Fatalf("expected a.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	_ = sourceRoot
}

func TestDriftUsesMainWorkspace(t *testing.T) {
	_, targetRoot, sourceRoot := setupProjectWithWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	// Rename source workspace to "main" and re-register in store
	sourceCfg, err := config.LoadAt(sourceRoot)
	if err != nil {
		t.Fatalf("LoadAt source: %v", err)
	}
	sourceCfg.WorkspaceName = "main"
	if err := config.SaveAt(sourceRoot, sourceCfg); err != nil {
		t.Fatalf("SaveAt source: %v", err)
	}

	// Re-open to update registry with new name
	restoreCwd := chdir(t, sourceRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "re-register"})
	_ = cmd.Execute()
	restoreCwd()

	restoreCwd = chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var result struct {
		TheirWorkspace string `json:"their_workspace"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if result.TheirWorkspace != "main" {
		t.Fatalf("expected their_workspace main, got %q", result.TheirWorkspace)
	}
}

func TestSnapshotRejectsMessageAndAgentMessage(t *testing.T) {
	root := setupWorkspace(t, "ws-snap", map[string]string{
		"a.txt": "hello",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "test", "--agent-message"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected snapshot with --message and --agent-message to fail")
	}
}

func TestDriftExitCode1WhenDriftDetected(t *testing.T) {
	// setupForkedWorkspaces guarantees a shared ancestor
	_, targetRoot, sourceRoot := setupForkedWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)
	_ = sourceRoot

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"drift", "ws-source", "--no-dirty"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected non-nil error (SilentExit) when drift detected")
	}
	if code := ExitCode(err); code != 1 {
		t.Fatalf("expected exit code 1, got %d (err: %v)", code, err)
	}
}

func TestDriftExitCode0WhenNoDrift(t *testing.T) {
	_, targetRoot, sourceRoot := setupForkedWorkspaces(t,
		map[string]string{},
		map[string]string{},
	)
	_ = sourceRoot

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"drift", "ws-source", "--no-dirty"})
	err := cmd.Execute()
	if err != nil {
		t.Fatalf("expected nil error when no drift, got: %v", err)
	}
}

func TestDiffExitCode1WhenDifferencesFound(t *testing.T) {
	_, targetRoot, sourceRoot := setupForkedWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	// Use path-based target to avoid parent-root resolution issues
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"diff", sourceRoot, "--names-only"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected non-nil error (SilentExit) when diffs found")
	}
	if code := ExitCode(err); code != 1 {
		t.Fatalf("expected exit code 1, got %d (err: %v)", code, err)
	}
}

func TestStatusShowsWorkspaceSnapshot(t *testing.T) {
	// Create a project with two workspaces that have different snapshots
	_, targetRoot, sourceRoot := setupForkedWorkspaces(t,
		map[string]string{"target-file.txt": "target"},
		map[string]string{"source-file.txt": "source"},
	)

	// Get the target workspace config to know its snapshot ID
	targetCfg, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target: %v", err)
	}

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"status", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("status --json failed: %v", err)
	}

	var result struct {
		LatestSnapshotID string `json:"latest_snapshot_id"`
		WorkspaceName    string `json:"workspace_name"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse status JSON: %v\noutput: %s", err, output)
	}

	// Status should show the workspace's own snapshot, not some other workspace's
	if result.LatestSnapshotID != targetCfg.CurrentSnapshotID {
		t.Fatalf("status showed snapshot %s, expected workspace snapshot %s",
			result.LatestSnapshotID, targetCfg.CurrentSnapshotID)
	}
	if result.WorkspaceName != "ws-target" {
		t.Fatalf("expected workspace name ws-target, got %s", result.WorkspaceName)
	}
	_ = sourceRoot
}

func TestRestoreOverwritesDirtyFiles(t *testing.T) {
	root := setupWorkspace(t, "ws-restore", map[string]string{
		"file.txt": "v1",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	// Create initial snapshot
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "v1"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot v1 failed: %v", err)
	}

	cfg1, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	snapV1 := cfg1.CurrentSnapshotID

	// Modify file
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("v2"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	// Restore to v1 — should overwrite dirty file without needing --force
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"restore", "--to", snapV1})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("restore failed: %v", err)
	}

	// Verify file content was restored
	content, err := os.ReadFile(filepath.Join(root, "file.txt"))
	if err != nil {
		t.Fatalf("read file: %v", err)
	}
	if string(content) != "v1" {
		t.Fatalf("expected 'v1', got %q", string(content))
	}

	// No auto-snapshot should have been created — only the v1 snapshot
	snapshotsDir := filepath.Join(root, ".fst", "snapshots")
	entries, err := os.ReadDir(snapshotsDir)
	if err != nil {
		t.Fatalf("ReadDir snapshots: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("expected exactly 1 snapshot (v1), got %d", len(entries))
	}
}

// setupForkedWorkspaces creates two workspaces that share a common base
// snapshot (guaranteed same ID). Workspace B forks from workspace A's base
// snapshot, ensuring the merge-base BFS can find a common ancestor regardless
// of timing.
func setupForkedWorkspaces(t *testing.T, targetFiles, sourceFiles map[string]string) (string, string, string) {
	t.Helper()

	projectRoot := t.TempDir()

	if err := os.WriteFile(filepath.Join(projectRoot, "fst.json"), []byte(`{"name":"test-project"}`), 0644); err != nil {
		t.Fatalf("write fst.json: %v", err)
	}
	for _, d := range []string{".fst/snapshots", ".fst/manifests", ".fst/blobs", ".fst/workspaces"} {
		if err := os.MkdirAll(filepath.Join(projectRoot, d), 0755); err != nil {
			t.Fatalf("mkdir %s: %v", d, err)
		}
	}

	targetRoot := filepath.Join(projectRoot, "ws-target")
	sourceRoot := filepath.Join(projectRoot, "ws-source")

	// Create target workspace with base file
	for _, ws := range []struct {
		root, id, name string
	}{
		{targetRoot, "ws-target-id", "ws-target"},
		{sourceRoot, "ws-source-id", "ws-source"},
	} {
		if err := os.MkdirAll(filepath.Join(ws.root, ".fst"), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
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
		if err := os.WriteFile(filepath.Join(ws.root, "base.txt"), []byte("base"), 0644); err != nil {
			t.Fatalf("write base.txt: %v", err)
		}
	}

	// Create ONE base snapshot from target workspace
	restoreCwd := chdir(t, targetRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "base snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("base snapshot failed: %v", err)
	}
	restoreCwd()

	// Read the base snapshot ID from target's config
	targetCfg, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target: %v", err)
	}
	baseSnapshotID := targetCfg.CurrentSnapshotID

	// Set source workspace to the SAME base snapshot ID so they share an ancestor
	sourceCfg, err := config.LoadAt(sourceRoot)
	if err != nil {
		t.Fatalf("LoadAt source: %v", err)
	}
	sourceCfg.CurrentSnapshotID = baseSnapshotID
	if err := config.SaveAt(sourceRoot, sourceCfg); err != nil {
		t.Fatalf("SaveAt source: %v", err)
	}

	// Add divergent changes and snapshot
	for path, content := range targetFiles {
		full := filepath.Join(targetRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}
	for path, content := range sourceFiles {
		full := filepath.Join(sourceRoot, path)
		os.MkdirAll(filepath.Dir(full), 0755)
		os.WriteFile(full, []byte(content), 0644)
	}

	restoreCwd = chdir(t, targetRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "target changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("target snapshot: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, sourceRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "source changes"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("source snapshot: %v", err)
	}
	restoreCwd()

	return projectRoot, targetRoot, sourceRoot
}

func setupWorkspace(t *testing.T, name string, files map[string]string) string {
	t.Helper()
	root := t.TempDir()
	for path, content := range files {
		full := filepath.Join(root, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write file: %v", err)
		}
	}
	cfg := &config.ProjectConfig{
		ProjectID:     "proj-1",
		WorkspaceID:   name + "-id",
		WorkspaceName: name,
		Mode:          "local",
	}
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	return root
}

func chdir(t *testing.T, dir string) func() {
	t.Helper()
	cwd, err := os.Getwd()
	if err != nil {
		t.Fatalf("getwd: %v", err)
	}
	if err := os.Chdir(dir); err != nil {
		t.Fatalf("chdir: %v", err)
	}
	return func() {
		_ = os.Chdir(cwd)
	}
}

func setenv(t *testing.T, key, value string) {
	t.Helper()
	prev, ok := os.LookupEnv(key)
	if err := os.Setenv(key, value); err != nil {
		t.Fatalf("setenv %s: %v", key, err)
	}
	t.Cleanup(func() {
		if ok {
			_ = os.Setenv(key, prev)
		} else {
			_ = os.Unsetenv(key)
		}
	})
}

func captureStdout(fn func() error, output *string) error {
	old := os.Stdout
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	os.Stdout = w
	runErr := fn()
	_ = w.Close()
	os.Stdout = old
	data, _ := io.ReadAll(r)
	*output = string(data)
	return runErr
}

func snapshotMetaPath(root, snapshotID string) string {
	return filepath.Join(root, ".fst", "snapshots", snapshotID+".meta.json")
}

func contains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}

