package commands

// Cloud-specific merge helpers used by sync.go and pull.go.
// These operate on manifests materialized to temp directories (remote snapshots),
// as opposed to the store-based merge in store/merge.go + workspace/merge.go.

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

// mergeAction represents a single file merge action for cloud sync/pull.
type mergeAction struct {
	path        string
	actionType  string // "apply", "conflict", "skip", "in_sync"
	currentHash string
	sourceHash  string
	baseHash    string
	sourceMode  uint32
}

// mergeActions holds all computed merge actions for cloud sync/pull.
type mergeActions struct {
	toApply   []mergeAction
	conflicts []mergeAction
	inSync    []mergeAction
	skipped   []mergeAction
}

func computeMergeActions(base, current, source *manifest.Manifest) *mergeActions {
	result := &mergeActions{}

	baseFiles := make(map[string]manifest.FileEntry)
	for _, f := range base.FileEntries() {
		baseFiles[f.Path] = f
	}

	currentFiles := make(map[string]manifest.FileEntry)
	for _, f := range current.FileEntries() {
		currentFiles[f.Path] = f
	}

	sourceFiles := make(map[string]manifest.FileEntry)
	for _, f := range source.FileEntries() {
		sourceFiles[f.Path] = f
	}

	allPaths := make(map[string]bool)
	for path := range baseFiles {
		allPaths[path] = true
	}
	for path := range currentFiles {
		allPaths[path] = true
	}
	for path := range sourceFiles {
		allPaths[path] = true
	}

	for path := range allPaths {
		baseFile, inBase := baseFiles[path]
		currentFile, inCurrent := currentFiles[path]
		sourceFile, inSource := sourceFiles[path]

		action := mergeAction{path: path}
		if inBase {
			action.baseHash = baseFile.Hash
		}
		if inCurrent {
			action.currentHash = currentFile.Hash
		}
		if inSource {
			action.sourceHash = sourceFile.Hash
			action.sourceMode = sourceFile.Mode
		}

		currentChanged := !inBase && inCurrent || (inBase && inCurrent && baseFile.Hash != currentFile.Hash)
		sourceChanged := !inBase && inSource || (inBase && inSource && baseFile.Hash != sourceFile.Hash)
		currentDeleted := inBase && !inCurrent
		sourceDeleted := inBase && !inSource

		switch {
		case !inSource && !sourceDeleted:
			continue
		case !inCurrent && inSource:
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)
		case currentDeleted && inSource:
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)
		case sourceDeleted && inCurrent:
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		case inCurrent && inSource && currentFile.Hash == sourceFile.Hash:
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		case !currentChanged && sourceChanged:
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)
		case currentChanged && !sourceChanged:
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		case currentChanged && sourceChanged:
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)
		default:
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		}
	}

	return result
}

func printCloudMergePlan(actions *mergeActions) {
	if len(actions.toApply) > 0 {
		fmt.Println("Will apply from source:")
		for _, a := range actions.toApply {
			fmt.Printf("  + %s\n", a.path)
		}
	}

	if len(actions.conflicts) > 0 {
		fmt.Println("Conflicts to resolve:")
		for _, a := range actions.conflicts {
			fmt.Printf("  ! %s\n", a.path)
		}
	}
}

func readSnapshotContent(root, relPath, expectedHash string, mode uint32) ([]byte, os.FileMode, error) {
	if expectedHash == "" {
		return nil, 0, os.ErrNotExist
	}

	if blobDir, err := config.GetBlobsDir(); err == nil {
		blobPath := filepath.Join(blobDir, expectedHash)
		if data, err := os.ReadFile(blobPath); err == nil {
			return data, cloudFileModeOrDefault(mode, 0644), nil
		}
	}

	sourcePath := filepath.Join(root, relPath)
	data, err := os.ReadFile(sourcePath)
	if err != nil {
		return nil, 0, err
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != expectedHash {
		return nil, 0, fmt.Errorf("source file does not match snapshot (dirty)")
	}

	m := cloudFileModeOrDefault(mode, 0)
	if m == 0 {
		if info, err := os.Stat(sourcePath); err == nil {
			m = info.Mode()
		} else {
			m = 0644
		}
	}

	return data, m, nil
}

func cloudFileModeOrDefault(mode uint32, fallback os.FileMode) os.FileMode {
	if mode == 0 {
		return fallback
	}
	return os.FileMode(mode)
}

func applyChange(currentRoot, sourceRoot string, action mergeAction) error {
	currentPath := filepath.Join(currentRoot, action.path)

	if err := os.MkdirAll(filepath.Dir(currentPath), 0755); err != nil {
		return err
	}

	content, mode, err := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)
	if err != nil {
		return fmt.Errorf("failed to read source snapshot: %w", err)
	}

	return os.WriteFile(currentPath, content, mode)
}

func resolveConflictWithAgent(currentRoot, sourceRoot string, action mergeAction, ag *agent.Agent, baseManifest *manifest.Manifest) error {
	currentPath := filepath.Join(currentRoot, action.path)

	currentContent, err := os.ReadFile(currentPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read current: %w", err)
	}

	sourceContent, _, err := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read source snapshot: %w", err)
	}

	var baseContent []byte
	if action.baseHash != "" {
		blobDir, err := config.GetBlobsDir()
		if err == nil {
			blobPath := filepath.Join(blobDir, action.baseHash)
			baseContent, _ = os.ReadFile(blobPath)
		}
	}

	mergeResult, err := agent.InvokeMerge(ag,
		string(baseContent),
		string(currentContent),
		string(sourceContent),
		action.path,
	)
	if err != nil {
		return err
	}

	if len(mergeResult.Strategy) > 0 {
		fmt.Printf("    Strategy:\n")
		for _, bullet := range mergeResult.Strategy {
			fmt.Printf("      . %s\n", bullet)
		}
	}

	showMergeDiff(string(currentContent), mergeResult.MergedCode)

	mode := cloudFileModeOrDefault(action.sourceMode, 0)
	if mode == 0 {
		if info, err := os.Stat(currentPath); err == nil {
			mode = info.Mode()
		} else {
			mode = 0644
		}
	}

	return os.WriteFile(currentPath, []byte(mergeResult.MergedCode), mode)
}

func createConflictMarkers(currentRoot, sourceRoot string, action mergeAction) error {
	currentPath := filepath.Join(currentRoot, action.path)

	currentContent, currentErr := os.ReadFile(currentPath)
	sourceContent, _, sourceErr := readSnapshotContent(sourceRoot, action.path, action.sourceHash, action.sourceMode)

	if currentErr != nil && sourceErr != nil {
		return fmt.Errorf("cannot read either version")
	}

	var result strings.Builder
	result.WriteString("<<<<<<< CURRENT (this workspace)\n")
	if currentErr == nil {
		result.Write(currentContent)
		if len(currentContent) > 0 && currentContent[len(currentContent)-1] != '\n' {
			result.WriteString("\n")
		}
	} else {
		result.WriteString("(file does not exist in current)\n")
	}
	result.WriteString("=======\n")
	if sourceErr == nil {
		result.Write(sourceContent)
		if len(sourceContent) > 0 && sourceContent[len(sourceContent)-1] != '\n' {
			result.WriteString("\n")
		}
	} else {
		result.WriteString("(file does not exist in source)\n")
	}
	result.WriteString(">>>>>>> SOURCE (merging from)\n")

	if err := os.MkdirAll(filepath.Dir(currentPath), 0755); err != nil {
		return err
	}

	return os.WriteFile(currentPath, []byte(result.String()), 0644)
}

func normalizeMergeParents(parents ...string) []string {
	seen := make(map[string]struct{}, len(parents))
	out := make([]string, 0, len(parents))
	for _, p := range parents {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func loadManifestByID(root, snapshotID string) (*manifest.Manifest, error) {
	if snapshotID == "" {
		return nil, fmt.Errorf("empty snapshot ID")
	}

	manifestHash, err := config.ManifestHashFromSnapshotIDAt(root, snapshotID)
	if err != nil {
		return nil, err
	}

	manifestsDir := config.GetManifestsDirAt(root)
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("snapshot manifest not found: %w", err)
	}

	return manifest.FromJSON(data)
}
