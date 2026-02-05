package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/anthropics/fastest/cli/internal/config"
)

func TestMergeModeValidation(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "--manual"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected conflicting merge flags to fail")
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
	sourceCfg.BaseSnapshotID = meta.ID
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

func TestMergeAutoSnapshot(t *testing.T) {
	targetRoot := setupWorkspace(t, "ws-target-auto", nil)
	sourceRoot := setupWorkspace(t, "ws-source-auto", nil)
	if err := os.MkdirAll(filepath.Join(targetRoot, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots target: %v", err)
	}
	if err := os.MkdirAll(filepath.Join(sourceRoot, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots source: %v", err)
	}
	if _, err := createInitialSnapshot(targetRoot, "ws-target-auto-id", "ws-target-auto", false); err != nil {
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
	sourceCfg.BaseSnapshotID = meta.ID
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

	targetCfg, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target: %v", err)
	}
	sourceCfg, err = config.LoadAt(sourceRoot)
	if err != nil {
		t.Fatalf("LoadAt source: %v", err)
	}
	targetBefore := targetCfg.CurrentSnapshotID
	sourceSnapshot := sourceCfg.CurrentSnapshotID

	restoreCwd := chdir(t, targetRoot)
	cmd = NewRootCmd()
	cmd.SetArgs([]string{"merge", "source", "--from", sourceRoot})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("merge failed: %v", err)
	}
	restoreCwd()

	targetCfgAfter, err := config.LoadAt(targetRoot)
	if err != nil {
		t.Fatalf("LoadAt target after: %v", err)
	}
	if targetCfgAfter.CurrentSnapshotID == targetBefore {
		t.Fatalf("expected merge to create a new snapshot")
	}

	parents, err := config.SnapshotParentIDsAt(targetRoot, targetCfgAfter.CurrentSnapshotID)
	if err != nil {
		t.Fatalf("SnapshotParentIDsAt: %v", err)
	}
	if len(parents) != 2 || !contains(parents, targetBefore) || !contains(parents, sourceSnapshot) {
		t.Fatalf("unexpected merge parents: %v", parents)
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
