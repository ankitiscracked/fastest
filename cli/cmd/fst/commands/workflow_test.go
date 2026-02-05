package commands

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/index"
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

	blobDir := filepath.Join(cacheDir, "fst", "blobs")
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
	// Create workspace A with a shared base snapshot
	rootA := setupWorkspace(t, "ws-a", map[string]string{
		"a.txt": "base",
	})
	if err := os.MkdirAll(filepath.Join(rootA, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots A: %v", err)
	}

	cacheDir := filepath.Join(rootA, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	baseSnapID, err := createInitialSnapshot(rootA, "ws-a-id", "ws-a", false)
	if err != nil {
		t.Fatalf("createInitialSnapshot A: %v", err)
	}

	// Create workspace B sharing the same base snapshot
	rootB := setupWorkspace(t, "ws-b", map[string]string{
		"a.txt": "base",
	})
	if err := os.MkdirAll(filepath.Join(rootB, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots B: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(rootB, ".fst", "manifests"), 0755); err != nil {
		t.Fatalf("mkdir manifests B: %v", err)
	}

	// Copy base snapshot metadata and manifest to B
	copySnapshotArtifacts(t, rootA, rootB, baseSnapID)

	cfgB, _ := config.LoadAt(rootB)
	cfgB.BaseSnapshotID = baseSnapID
	cfgB.CurrentSnapshotID = baseSnapID
	if err := config.SaveAt(rootB, cfgB); err != nil {
		t.Fatalf("SaveAt B: %v", err)
	}

	// Add divergent changes: A modifies a.txt, B adds b.txt and modifies a.txt
	if err := os.WriteFile(filepath.Join(rootA, "a.txt"), []byte("one"), 0644); err != nil {
		t.Fatalf("write A a.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "a.txt"), []byte("two"), 0644); err != nil {
		t.Fatalf("write B a.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "b.txt"), []byte("new"), 0644); err != nil {
		t.Fatalf("write B b.txt: %v", err)
	}

	// Create snapshots on both sides
	restoreCwd := chdir(t, rootA)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "snap A"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot A: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, rootB)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "snap B"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot B: %v", err)
	}
	restoreCwd()

	// Copy B's snapshot artifacts to A so DAG traversal works
	cfgB, _ = config.LoadAt(rootB)
	copySnapshotArtifacts(t, rootB, rootA, cfgB.CurrentSnapshotID)

	// Register workspace B in the index
	configDir := filepath.Join(rootA, "config")
	setenv(t, "XDG_CONFIG_HOME", configDir)
	registerTestWorkspace(t, "ws-b-id", "proj-1", "ws-b", rootB)

	restoreCwd = chdir(t, rootA)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "ws-b", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var result struct {
		TheirChanges struct {
			FilesAdded    []string `json:"files_added"`
			FilesModified []string `json:"files_modified"`
		} `json:"their_changes"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if !contains(result.TheirChanges.FilesAdded, "b.txt") {
		t.Fatalf("expected b.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	if !contains(result.TheirChanges.FilesModified, "a.txt") {
		t.Fatalf("expected a.txt in their modified, got %v", result.TheirChanges.FilesModified)
	}
}

func TestDriftBetweenWorkspacesNoDirtyJSON(t *testing.T) {
	// Create workspace A with a shared base snapshot
	rootA := setupWorkspace(t, "ws-a", map[string]string{
		"a.txt": "base",
	})
	if err := os.MkdirAll(filepath.Join(rootA, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots A: %v", err)
	}

	cacheDir := filepath.Join(rootA, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	baseSnapID, err := createInitialSnapshot(rootA, "ws-a-id", "ws-a", false)
	if err != nil {
		t.Fatalf("createInitialSnapshot A: %v", err)
	}

	// Create workspace B sharing the same base snapshot
	rootB := setupWorkspace(t, "ws-b", map[string]string{
		"a.txt": "base",
	})
	if err := os.MkdirAll(filepath.Join(rootB, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots B: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(rootB, ".fst", "manifests"), 0755); err != nil {
		t.Fatalf("mkdir manifests B: %v", err)
	}

	// Copy base snapshot metadata and manifest to B
	copySnapshotArtifacts(t, rootA, rootB, baseSnapID)

	cfgB, _ := config.LoadAt(rootB)
	cfgB.BaseSnapshotID = baseSnapID
	cfgB.CurrentSnapshotID = baseSnapID
	if err := config.SaveAt(rootB, cfgB); err != nil {
		t.Fatalf("SaveAt B: %v", err)
	}

	// Add divergent changes
	if err := os.WriteFile(filepath.Join(rootA, "a.txt"), []byte("one"), 0644); err != nil {
		t.Fatalf("write A a.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "a.txt"), []byte("two"), 0644); err != nil {
		t.Fatalf("write B a.txt: %v", err)
	}
	if err := os.WriteFile(filepath.Join(rootB, "b.txt"), []byte("new"), 0644); err != nil {
		t.Fatalf("write B b.txt: %v", err)
	}

	// Create snapshots on both sides
	restoreCwd := chdir(t, rootA)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "snap A"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot A: %v", err)
	}
	restoreCwd()

	restoreCwd = chdir(t, rootB)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "snap B"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot B: %v", err)
	}
	restoreCwd()

	// Copy B's snapshot artifacts to A so DAG traversal works
	cfgB, _ = config.LoadAt(rootB)
	copySnapshotArtifacts(t, rootB, rootA, cfgB.CurrentSnapshotID)

	// Register workspace B in the index
	configDir := filepath.Join(rootA, "config")
	setenv(t, "XDG_CONFIG_HOME", configDir)
	registerTestWorkspace(t, "ws-b-id", "proj-1", "ws-b", rootB)

	restoreCwd = chdir(t, rootA)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "ws-b", "--no-dirty", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var result struct {
		TheirChanges struct {
			FilesAdded    []string `json:"files_added"`
			FilesModified []string `json:"files_modified"`
		} `json:"their_changes"`
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &result); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if !contains(result.TheirChanges.FilesAdded, "b.txt") {
		t.Fatalf("expected b.txt in their added, got %v", result.TheirChanges.FilesAdded)
	}
	if !contains(result.TheirChanges.FilesModified, "a.txt") {
		t.Fatalf("expected a.txt in their modified, got %v", result.TheirChanges.FilesModified)
	}
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

func contains(list []string, item string) bool {
	for _, v := range list {
		if v == item {
			return true
		}
	}
	return false
}

// copySnapshotArtifacts copies a snapshot's metadata and manifest from src to dst workspace
func copySnapshotArtifacts(t *testing.T, srcRoot, dstRoot, snapshotID string) {
	t.Helper()

	// Copy snapshot metadata
	srcMeta := filepath.Join(srcRoot, ".fst", "snapshots", snapshotID+".meta.json")
	dstMeta := filepath.Join(dstRoot, ".fst", "snapshots", snapshotID+".meta.json")
	metaBytes, err := os.ReadFile(srcMeta)
	if err != nil {
		t.Fatalf("read snapshot meta %s: %v", snapshotID, err)
	}
	if err := os.MkdirAll(filepath.Dir(dstMeta), 0755); err != nil {
		t.Fatalf("mkdir dst snapshots: %v", err)
	}
	if err := os.WriteFile(dstMeta, metaBytes, 0644); err != nil {
		t.Fatalf("write snapshot meta: %v", err)
	}

	// Parse to get manifest hash
	var meta config.SnapshotMeta
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		t.Fatalf("parse snapshot meta: %v", err)
	}

	// Copy manifest
	srcManifest := filepath.Join(srcRoot, ".fst", "manifests", meta.ManifestHash+".json")
	dstManifest := filepath.Join(dstRoot, ".fst", "manifests", meta.ManifestHash+".json")
	manifestBytes, err := os.ReadFile(srcManifest)
	if err != nil {
		t.Fatalf("read manifest %s: %v", meta.ManifestHash, err)
	}
	if err := os.MkdirAll(filepath.Dir(dstManifest), 0755); err != nil {
		t.Fatalf("mkdir dst manifests: %v", err)
	}
	if err := os.WriteFile(dstManifest, manifestBytes, 0644); err != nil {
		t.Fatalf("write manifest: %v", err)
	}
}

// registerTestWorkspace registers a workspace in the local index for FindWorkspaceByName
func registerTestWorkspace(t *testing.T, workspaceID, projectID, name, path string) {
	t.Helper()
	if err := index.UpsertWorkspace(index.WorkspaceEntry{
		WorkspaceID:   workspaceID,
		ProjectID:     projectID,
		WorkspaceName: name,
		Path:          path,
	}, ""); err != nil {
		t.Fatalf("UpsertWorkspace: %v", err)
	}
}
