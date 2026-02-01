package commands

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func TestWorkspaceInitRequiresProjectFolder(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "readme.md"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "init"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected init to fail without a project folder")
	}
}

func TestWorkspaceCreateFromParent(t *testing.T) {
	parent := t.TempDir()
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-123",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "create", "dev"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("workspace create failed: %v", err)
	}

	workspaceDir := filepath.Join(parent, "dev")
	if _, err := os.Stat(filepath.Join(workspaceDir, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config to exist: %v", err)
	}
}

func TestProjectInitRejectsHome(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "HOME", root)
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "init", "demo"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Fatalf("expected home directory error, got: %v", err)
	}
}

func TestProjectCreateCreatesMainWorkspace(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "create", "demo"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("project create failed: %v", err)
	}

	projectPath := filepath.Join(root, "demo")
	workspacePath := filepath.Join(projectPath, "main")

	if _, err := os.Stat(filepath.Join(projectPath, "fst.json")); err != nil {
		t.Fatalf("expected fst.json: %v", err)
	}
	if _, err := os.Stat(filepath.Join(workspacePath, ".fst", "config.json")); err != nil {
		t.Fatalf("expected workspace config: %v", err)
	}
}

func TestProjectCreateRejectsHome(t *testing.T) {
	root := t.TempDir()

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "HOME", root)
	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"project", "create", "demo"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "home directory") {
		t.Fatalf("expected home directory error, got: %v", err)
	}
}

func TestCopyRejectsWithoutProjectFolder(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "file.txt"), []byte("hi"), 0644); err != nil {
		t.Fatalf("write file: %v", err)
	}

	cfg := &config.ProjectConfig{
		ProjectID:     "proj-copy",
		WorkspaceID:   "ws-copy-id",
		WorkspaceName: "ws-copy",
		Mode:          "local",
	}
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(root, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	if err := os.MkdirAll(filepath.Join(root, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(root, "ws-copy-id", "ws-copy", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "no project folder found") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCopyRejectsInProjectFolder(t *testing.T) {
	parent := t.TempDir()
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}

	restoreCwd := chdir(t, parent)
	defer restoreCwd()

	setenv(t, "XDG_CACHE_HOME", filepath.Join(parent, "cache"))
	setenv(t, "XDG_CONFIG_HOME", filepath.Join(parent, "config"))

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature"})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "project folder") {
		t.Fatalf("expected project folder error, got: %v", err)
	}
}

func TestCopyRejectsTargetOutsideProjectFolder(t *testing.T) {
	parent := t.TempDir()
	workspace := filepath.Join(parent, "main")
	if err := os.MkdirAll(workspace, 0755); err != nil {
		t.Fatalf("mkdir workspace: %v", err)
	}
	if err := config.SaveParentConfigAt(parent, &config.ParentConfig{
		ProjectID:   "proj-copy",
		ProjectName: "demo",
	}); err != nil {
		t.Fatalf("SaveParentConfigAt: %v", err)
	}
	cfg := &config.ProjectConfig{
		ProjectID:     "proj-copy",
		WorkspaceID:   "ws-copy-id",
		WorkspaceName: "main",
		Mode:          "local",
	}
	if err := config.SaveAt(workspace, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(workspace, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(workspace, "ws-copy-id", "main", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	restoreCwd := chdir(t, workspace)
	defer restoreCwd()

	outside := t.TempDir()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"workspace", "copy", "-n", "feature", "--to", filepath.Join(outside, "feature")})
	err := cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if !strings.Contains(err.Error(), "direct child of project folder") {
		t.Fatalf("expected target directory error, got: %v", err)
	}
}

func TestSyncAlreadyInSync(t *testing.T) {
	root := setupWorkspace(t, "ws-sync", map[string]string{
		"file.txt": "content",
	})
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}
	cfg.CurrentSnapshotID = "snap-1"
	if err := config.SaveAt(root, cfg); err != nil {
		t.Fatalf("SaveAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/workspaces/") {
			resp := map[string]interface{}{
				"workspace": map[string]interface{}{
					"id":                  cfg.WorkspaceID,
					"project_id":          cfg.ProjectID,
					"name":                cfg.WorkspaceName,
					"current_snapshot_id": "snap-1",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "token", nil },
		NewAPIClient: func(token string, cfg *config.ProjectConfig) *api.Client {
			client := api.NewClient(token)
			client.SetBaseURL(server.URL)
			return client
		},
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("sync failed: %v", err)
	}
}

func TestSyncModeValidation(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync", "--agent", "--manual"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected conflicting sync flags to fail")
	}
}

func TestMergeModeValidation(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "--agent", "--manual"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected conflicting merge flags to fail")
	}
}

func TestSyncDownloadsManifestAndBlobsDryRun(t *testing.T) {
	root := setupWorkspace(t, "ws-sync-remote", map[string]string{})
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	content := []byte("remote data")
	blobHash := sha256.Sum256(content)
	hashStr := hex.EncodeToString(blobHash[:])

	m := &manifest.Manifest{
		Version: "1",
		Files: []manifest.FileEntry{
			{
				Path: "remote.txt",
				Hash: hashStr,
				Size: int64(len(content)),
				Mode: 0644,
			},
		},
	}
	manifestJSON, err := m.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/workspaces/"):
			resp := map[string]interface{}{
				"workspace": map[string]interface{}{
					"id":                  cfg.WorkspaceID,
					"project_id":          cfg.ProjectID,
					"name":                cfg.WorkspaceName,
					"current_snapshot_id": "snap-remote",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/snapshots/"):
			resp := map[string]interface{}{
				"snapshot": map[string]interface{}{
					"id":            "snap-remote",
					"project_id":    cfg.ProjectID,
					"manifest_hash": hashStr,
					"source":        "cloud",
					"created_at":    "2024-01-01T00:00:00Z",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/blobs/manifests/"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestJSON)
		case r.URL.Path == "/v1/blobs/presign-download":
			resp := map[string]interface{}{
				"urls": map[string]string{
					hashStr: "/download/" + hashStr,
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/download/"):
			_, _ = w.Write(content)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "token", nil },
		NewAPIClient: func(token string, cfg *config.ProjectConfig) *api.Client {
			client := api.NewClient(token)
			client.SetBaseURL(server.URL)
			return client
		},
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync", "--dry-run"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("sync dry-run failed: %v", err)
	}

	blobPath := filepath.Join(cacheDir, "fst", "blobs", hashStr)
	data, err := os.ReadFile(blobPath)
	if err != nil {
		t.Fatalf("expected blob cached: %v", err)
	}
	if string(data) != string(content) {
		t.Fatalf("blob content mismatch")
	}
}

func TestMergeDryRunPlan(t *testing.T) {
	targetRoot := setupWorkspace(t, "ws-target", nil)
	sourceRoot := setupWorkspace(t, "ws-source", nil)
	if err := os.MkdirAll(filepath.Join(targetRoot, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots target: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots source: %v", err)
	}
	if _, err := createInitialSnapshot(targetRoot, "ws-target-id", "ws-target", false); err != nil {
		t.Fatalf("createInitialSnapshot target: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, ".fst", "manifests"), 0755); err != nil {
		t.Fatalf("mkdir manifests source: %v", err)
	}

	// Copy snapshot metadata + manifest to source so both share a common ancestor.
	targetSnapshotsDir := filepath.Join(targetRoot, ".fst", "snapshots")
	entries, err := os.ReadDir(targetSnapshotsDir)
	if err != nil || len(entries) == 0 {
		t.Fatalf("expected snapshot metadata in target")
	}
	var snapshotMetaName string
	for _, entry := range entries {
		if strings.HasSuffix(entry.Name(), ".meta.json") {
			snapshotMetaName = entry.Name()
			break
		}
	}
	if snapshotMetaName == "" {
		t.Fatalf("expected snapshot metadata file")
	}
	metaBytes, err := os.ReadFile(filepath.Join(targetSnapshotsDir, snapshotMetaName))
	if err != nil {
		t.Fatalf("read target snapshot meta: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, ".fst", "snapshots", snapshotMetaName), metaBytes, 0644); err != nil {
		t.Fatalf("write source snapshot meta: %v", err)
	}

	var meta config.SnapshotMeta
	if err := json.Unmarshal(metaBytes, &meta); err != nil {
		t.Fatalf("parse snapshot meta: %v", err)
	}
	manifestPath := filepath.Join(targetRoot, ".fst", "manifests", meta.ManifestHash+".json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read target manifest: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, ".fst", "manifests", meta.ManifestHash+".json"), manifestBytes, 0644); err != nil {
		t.Fatalf("write source manifest: %v", err)
	}

	sourceCfg, err := config.LoadAt(sourceRoot)
	if err != nil {
		t.Fatalf("LoadAt source: %v", err)
	}
	sourceCfg.CurrentSnapshotID = meta.ID
	sourceCfg.ForkSnapshotID = meta.ID
	if err := config.SaveAt(sourceRoot, sourceCfg); err != nil {
		t.Fatalf("SaveAt source: %v", err)
	}

	// Add divergent changes after the shared base snapshot.
	if err := os.WriteFile(filepath.Join(targetRoot, "a.txt"), []byte("one"), 0644); err != nil {
		t.Fatalf("write target file: %v", err)
	}
	if err := os.WriteFile(filepath.Join(sourceRoot, "b.txt"), []byte("two"), 0644); err != nil {
		t.Fatalf("write source file: %v", err)
	}

	restoreTargetCwd := chdir(t, targetRoot)
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "target snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("target snapshot failed: %v", err)
	}
	restoreTargetCwd()

	restoreSourceCwd := chdir(t, sourceRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "--message", "source snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("source snapshot failed: %v", err)
	}
	restoreSourceCwd()

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"merge", "source", "--from", sourceRoot, "--dry-run"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("merge dry-run failed: %v", err)
	}
	if !strings.Contains(output, "Merge plan") {
		t.Fatalf("expected merge plan output")
	}
}

func TestStatusJSONOutput(t *testing.T) {
	root := setupWorkspace(t, "ws-json", map[string]string{
		"file.txt": "ok",
	})

	if err := os.MkdirAll(filepath.Join(root, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(root, "ws-json-id", "ws-json", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"status", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("status --json failed: %v", err)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil {
		t.Fatalf("invalid JSON output: %v\noutput: %s", err, output)
	}
	if payload["workspace_name"] != "ws-json" {
		t.Fatalf("workspace_name mismatch: %v", payload["workspace_name"])
	}
	if payload["latest_snapshot_id"] == "" {
		t.Fatalf("expected latest_snapshot_id to be set")
	}
	if payload["latest_snapshot_time"] == "" {
		t.Fatalf("expected latest_snapshot_time to be set")
	}
}

func TestSyncDryRunShowsConflicts(t *testing.T) {
	root := setupWorkspace(t, "ws-sync-conflict", map[string]string{
		"file.txt": "local",
	})
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	remoteContent := []byte("remote")
	blobHash := sha256.Sum256(remoteContent)
	hashStr := hex.EncodeToString(blobHash[:])

	m := &manifest.Manifest{
		Version: "1",
		Files: []manifest.FileEntry{
			{
				Path: "file.txt",
				Hash: hashStr,
				Size: int64(len(remoteContent)),
				Mode: 0644,
			},
		},
	}
	manifestJSON, err := m.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/workspaces/"):
			resp := map[string]interface{}{
				"workspace": map[string]interface{}{
					"id":                  cfg.WorkspaceID,
					"project_id":          cfg.ProjectID,
					"name":                cfg.WorkspaceName,
					"current_snapshot_id": "snap-remote",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/snapshots/"):
			resp := map[string]interface{}{
				"snapshot": map[string]interface{}{
					"id":            "snap-remote",
					"project_id":    cfg.ProjectID,
					"manifest_hash": hashStr,
					"source":        "cloud",
					"created_at":    "2024-01-01T00:00:00Z",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/blobs/manifests/"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestJSON)
		case r.URL.Path == "/v1/blobs/presign-download":
			resp := map[string]interface{}{
				"urls": map[string]string{
					hashStr: "/download/" + hashStr,
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/download/"):
			_, _ = w.Write(remoteContent)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "token", nil },
		NewAPIClient: func(token string, cfg *config.ProjectConfig) *api.Client {
			client := api.NewClient(token)
			client.SetBaseURL(server.URL)
			return client
		},
	})
	defer ResetDeps()

	var output string
	err = captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"sync", "--dry-run"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("sync dry-run failed: %v", err)
	}
	if !strings.Contains(output, "Conflicts:") {
		t.Fatalf("expected conflicts line in output, got: %s", output)
	}
	if !strings.Contains(output, "Conflicts:          1 files") {
		t.Fatalf("expected conflict count line, got: %s", output)
	}
}

func TestSyncApplyNonConflicting(t *testing.T) {
	root := setupWorkspace(t, "ws-sync-apply", map[string]string{})
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	content := []byte("remote file")
	blobHash := sha256.Sum256(content)
	hashStr := hex.EncodeToString(blobHash[:])

	m := &manifest.Manifest{
		Version: "1",
		Files: []manifest.FileEntry{
			{
				Path: "remote.txt",
				Hash: hashStr,
				Size: int64(len(content)),
				Mode: 0644,
			},
		},
	}
	manifestJSON, err := m.ToJSON()
	if err != nil {
		t.Fatalf("ToJSON: %v", err)
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.HasPrefix(r.URL.Path, "/v1/workspaces/"):
			resp := map[string]interface{}{
				"workspace": map[string]interface{}{
					"id":                  cfg.WorkspaceID,
					"project_id":          cfg.ProjectID,
					"name":                cfg.WorkspaceName,
					"current_snapshot_id": "snap-remote",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/snapshots/"):
			resp := map[string]interface{}{
				"snapshot": map[string]interface{}{
					"id":            "snap-remote",
					"project_id":    cfg.ProjectID,
					"manifest_hash": hashStr,
					"source":        "cloud",
					"created_at":    "2024-01-01T00:00:00Z",
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/v1/blobs/manifests/"):
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write(manifestJSON)
		case r.URL.Path == "/v1/blobs/presign-download":
			resp := map[string]interface{}{
				"urls": map[string]string{
					hashStr: "/download/" + hashStr,
				},
			}
			_ = json.NewEncoder(w).Encode(resp)
		case strings.HasPrefix(r.URL.Path, "/download/"):
			_, _ = w.Write(content)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer server.Close()

	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "token", nil },
		NewAPIClient: func(token string, cfg *config.ProjectConfig) *api.Client {
			client := api.NewClient(token)
			client.SetBaseURL(server.URL)
			return client
		},
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"sync", "--no-snapshot"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("sync apply failed: %v", err)
	}

	data, err := os.ReadFile(filepath.Join(root, "remote.txt"))
	if err != nil {
		t.Fatalf("expected remote.txt to be applied: %v", err)
	}
	if string(data) != string(content) {
		t.Fatalf("remote.txt content mismatch")
	}
}

func TestMergePlanNoOtherWorkspaces(t *testing.T) {
	root := setupWorkspace(t, "ws-merge", map[string]string{
		"readme.md": "ok",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"merge", "--plan"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("merge --plan failed: %v", err)
	}
	if !strings.Contains(output, "No other workspaces") {
		t.Fatalf("expected no workspaces message, got: %s", output)
	}
}
