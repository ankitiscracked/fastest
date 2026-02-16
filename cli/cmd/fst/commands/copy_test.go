package commands

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func TestCreateRejectsWithoutProjectFolder(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	SetDeps(Deps{})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "project folder") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCreateRejectsWhenNoSourceWorkspace(t *testing.T) {
	parent := t.TempDir()
	if err := config.SaveProjectConfigAt(parent, &config.ProjectConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "no main workspace found") {
		t.Fatalf("expected no main workspace error, got: %v", err)
	}
}

func TestCreateRejectsTargetAlreadyExists(t *testing.T) {
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{})
	defer ResetDeps()

	if err := config.SaveProjectConfigAt(parent, &config.ProjectConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	// Create main workspace with snapshot
	mainDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(mainDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(mainDir, "f.txt"), []byte("x"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := config.InitAt(mainDir, "proj-copy", "ws-main", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	s := store.OpenAt(parent)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   "ws-main",
		WorkspaceName: "main",
		Path:          mainDir,
	})

	restoreCwd := chdir(t, mainDir)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restoreCwd()

	// Create target directory so it already exists
	featureDir := filepath.Join(parent, "feature")
	if err := os.MkdirAll(featureDir, 0755); err != nil {
		t.Fatalf("mkdir feature: %v", err)
	}

	restoreCwd = chdir(t, parent)
	defer restoreCwd()

	cmd = NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("expected already exists error, got: %v", err)
	}
}

func TestCreateRejectsInvalidBackend(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature", "--backend", "invalid"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "invalid backend") {
		t.Fatalf("expected invalid backend error, got: %v", err)
	}
}

func TestMaterializeWorkspaceFileAutoFallsBackToCopy(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src.txt")
	dst := filepath.Join(root, "dst.txt")

	if err := os.WriteFile(src, []byte("hello"), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	originalClone := cloneFileFunc
	cloneFileFunc = func(src, dst string, mode os.FileMode) error {
		return errors.New("clone unsupported")
	}
	defer func() { cloneFileFunc = originalClone }()

	usedClone, err := materializeWorkspaceFile(src, dst, 0644, createBackendAuto)
	if err != nil {
		t.Fatalf("materialize: %v", err)
	}
	if usedClone {
		t.Fatalf("expected copy fallback, got clone")
	}

	data, err := os.ReadFile(dst)
	if err != nil {
		t.Fatalf("read dest: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("unexpected dest content: %q", string(data))
	}
}

// setupProjectWithMain creates a project parent dir with a "main" workspace that
// has an initial snapshot. Returns (parentDir, mainDir).
func setupProjectWithMain(t *testing.T, files map[string]string) (string, string) {
	t.Helper()
	parent := t.TempDir()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	SetDeps(Deps{})

	if err := config.SaveProjectConfigAt(parent, &config.ProjectConfig{
		ProjectID:   "proj-test",
		ProjectName: "test-project",
	}); err != nil {
		t.Fatalf("SaveProjectConfigAt: %v", err)
	}

	mainDir := filepath.Join(parent, "main")
	if err := os.MkdirAll(mainDir, 0755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	for path, content := range files {
		full := filepath.Join(mainDir, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatalf("mkdir: %v", err)
		}
		if err := os.WriteFile(full, []byte(content), 0644); err != nil {
			t.Fatalf("write: %v", err)
		}
	}

	if err := config.InitAt(mainDir, "proj-test", "ws-main", "main", ""); err != nil {
		t.Fatalf("InitAt: %v", err)
	}
	s := store.OpenAt(parent)
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:   "ws-main",
		WorkspaceName: "main",
		Path:          mainDir,
	})

	// Take a snapshot so there's a fork point
	restoreCwd := chdir(t, mainDir)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "init"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("snapshot: %v", err)
	}
	restoreCwd()

	return parent, mainDir
}

func TestCreateCopiesFilesAndInitializesConfig(t *testing.T) {
	parent, mainDir := setupProjectWithMain(t, map[string]string{
		"src/main.go": "package main",
		"README.md":   "hello",
	})
	defer ResetDeps()

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "feature"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create: %v", err)
	}

	featureDir := filepath.Join(parent, "feature")

	// Verify files were copied
	data, err := os.ReadFile(filepath.Join(featureDir, "src/main.go"))
	if err != nil {
		t.Fatalf("read main.go: %v", err)
	}
	if string(data) != "package main" {
		t.Fatalf("unexpected main.go content: %q", string(data))
	}

	data, err = os.ReadFile(filepath.Join(featureDir, "README.md"))
	if err != nil {
		t.Fatalf("read README.md: %v", err)
	}
	if string(data) != "hello" {
		t.Fatalf("unexpected README.md content: %q", string(data))
	}

	// Verify .fst/config.json exists with correct fork snapshot
	newCfg, err := config.LoadAt(featureDir)
	if err != nil {
		t.Fatalf("LoadAt feature: %v", err)
	}
	if newCfg.ProjectID != "proj-test" {
		t.Fatalf("expected project_id proj-test, got %s", newCfg.ProjectID)
	}
	if newCfg.WorkspaceName != "feature" {
		t.Fatalf("expected workspace_name feature, got %s", newCfg.WorkspaceName)
	}
	if newCfg.CurrentSnapshotID == "" {
		t.Fatalf("expected current_snapshot_id to be set")
	}
	if newCfg.BaseSnapshotID == "" {
		t.Fatalf("expected base_snapshot_id to be set")
	}

	// Fork snapshot should match the main workspace's latest
	mainCfg, err := config.LoadAt(mainDir)
	if err != nil {
		t.Fatalf("LoadAt main: %v", err)
	}
	if newCfg.CurrentSnapshotID != mainCfg.CurrentSnapshotID {
		t.Fatalf("fork snapshot mismatch: feature=%s main=%s",
			newCfg.CurrentSnapshotID, mainCfg.CurrentSnapshotID)
	}

	// Verify workspace is registered in the project
	s := store.OpenAt(parent)
	wsInfo, err := s.FindWorkspaceByName("feature")
	if err != nil {
		t.Fatalf("FindWorkspaceByName: %v", err)
	}
	// Resolve symlinks for comparison (macOS /var -> /private/var)
	wantPath, _ := filepath.EvalSymlinks(featureDir)
	gotPath, _ := filepath.EvalSymlinks(wsInfo.Path)
	if gotPath != wantPath {
		t.Fatalf("expected registry path %s, got %s", wantPath, gotPath)
	}
}

func TestCreateFromInsideWorkspace(t *testing.T) {
	parent, mainDir := setupProjectWithMain(t, map[string]string{
		"app.js": "console.log('hi')",
	})
	defer ResetDeps()

	// Run from inside the main workspace (not the project root)
	restoreCwd := chdir(t, mainDir)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "bugfix"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create: %v", err)
	}

	bugfixDir := filepath.Join(parent, "bugfix")
	data, err := os.ReadFile(filepath.Join(bugfixDir, "app.js"))
	if err != nil {
		t.Fatalf("read app.js: %v", err)
	}
	if string(data) != "console.log('hi')" {
		t.Fatalf("unexpected app.js content: %q", string(data))
	}
}

func TestCreateWithFromFlag(t *testing.T) {
	parent, _ := setupProjectWithMain(t, map[string]string{
		"base.txt": "from main",
	})
	defer ResetDeps()

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "derived", "--from", "main"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create --from: %v", err)
	}

	derivedDir := filepath.Join(parent, "derived")
	data, err := os.ReadFile(filepath.Join(derivedDir, "base.txt"))
	if err != nil {
		t.Fatalf("read base.txt: %v", err)
	}
	if string(data) != "from main" {
		t.Fatalf("unexpected base.txt content: %q", string(data))
	}
}

func TestCreateWithCopyBackend(t *testing.T) {
	parent, _ := setupProjectWithMain(t, map[string]string{
		"file.txt": "content",
	})
	defer ResetDeps()

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "copy-ws", "--backend", "copy"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create --backend copy: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(parent, "copy-ws", "file.txt"))
	if err != nil {
		t.Fatalf("read file.txt: %v", err)
	}
	if string(data) != "content" {
		t.Fatalf("unexpected content: %q", string(data))
	}
}

func TestCreatePreservesSymlinks(t *testing.T) {
	parent, mainDir := setupProjectWithMain(t, map[string]string{
		"real.txt": "target content",
	})
	defer ResetDeps()

	// Create a symlink in the source workspace
	if err := os.Symlink("real.txt", filepath.Join(mainDir, "link.txt")); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "sym-ws"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create: %v", err)
	}

	linkPath := filepath.Join(parent, "sym-ws", "link.txt")
	fi, err := os.Lstat(linkPath)
	if err != nil {
		t.Fatalf("lstat link.txt: %v", err)
	}
	if fi.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("expected symlink, got mode %v", fi.Mode())
	}

	target, err := os.Readlink(linkPath)
	if err != nil {
		t.Fatalf("readlink: %v", err)
	}
	if target != "real.txt" {
		t.Fatalf("expected symlink target 'real.txt', got %q", target)
	}
}

func TestMaterializeWorkspaceFileCloneModeFailsWithoutCloneSupport(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "src.txt")
	dst := filepath.Join(root, "dst.txt")

	if err := os.WriteFile(src, []byte("hello"), 0644); err != nil {
		t.Fatalf("write source: %v", err)
	}

	originalClone := cloneFileFunc
	cloneFileFunc = func(src, dst string, mode os.FileMode) error {
		return errors.New("clone unsupported")
	}
	defer func() { cloneFileFunc = originalClone }()

	_, err := materializeWorkspaceFile(src, dst, 0644, createBackendClone)
	if err == nil {
		t.Fatalf("expected clone mode error, got nil")
	}
	if !strings.Contains(err.Error(), "clone unsupported") {
		t.Fatalf("expected clone unsupported error, got: %v", err)
	}
}
