package commands

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
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
	cmd.SetArgs([]string{"snapshot"})
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
	rootA := setupWorkspace(t, "ws-a", map[string]string{
		"a.txt": "one",
	})
	rootB := setupWorkspace(t, "ws-b", map[string]string{
		"a.txt": "two",
		"b.txt": "new",
	})

	restoreCwd := chdir(t, rootA)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", rootB, "--include-dirty", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("drift failed: %v", err)
	}

	var report drift.Report
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &report); err != nil {
		t.Fatalf("failed to parse drift JSON: %v\noutput: %s", err, output)
	}
	if !contains(report.FilesAdded, "b.txt") {
		t.Fatalf("expected b.txt in added, got %v", report.FilesAdded)
	}
	if !contains(report.FilesModified, "a.txt") {
		t.Fatalf("expected a.txt in modified, got %v", report.FilesModified)
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
