package commands

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/ignore"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

type createBackend string

const (
	createBackendAuto  createBackend = "auto"
	createBackendClone createBackend = "clone"
	createBackendCopy  createBackend = "copy"
)

var errCloneUnsupportedPlatform = errors.New("clone backend is not supported on this platform")

var cloneFileFunc = cloneFile

func runCreate(args []string, fromWorkspace, backendArg string) error {
	backend, err := parseCreateBackend(backendArg)
	if err != nil {
		return err
	}

	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	// Determine project root and whether we're inside a workspace
	var parentRoot string
	var parentCfg *config.ParentConfig
	var sourceWorkspaceRoot string
	var sourceWorkspaceCfg *config.ProjectConfig
	var projectID string

	wsRoot, _ := config.FindProjectRoot()
	inWorkspace := wsRoot != ""

	if inWorkspace {
		// We're inside a workspace — find the project root above it
		parentRoot, parentCfg, err = config.FindParentRootFrom(wsRoot)
		if err != nil && !errors.Is(err, config.ErrParentNotFound) {
			return err
		}
		if errors.Is(err, config.ErrParentNotFound) {
			return fmt.Errorf("no project folder found above workspace - run 'fst project init' first")
		}
		projectID = parentCfg.ProjectID

		// Default source is the current workspace
		if fromWorkspace == "" {
			sourceWorkspaceRoot = wsRoot
			sourceWorkspaceCfg, err = config.LoadAt(wsRoot)
			if err != nil {
				return fmt.Errorf("failed to load current workspace config: %w", err)
			}
		}
	} else {
		// Not inside a workspace — must be at project root
		parentRoot, parentCfg, err = config.FindParentRootFrom(cwd)
		if err != nil && !errors.Is(err, config.ErrParentNotFound) {
			return err
		}
		if errors.Is(err, config.ErrParentNotFound) {
			return fmt.Errorf("no project folder found - run 'fst project init' first")
		}
		if cwd != parentRoot {
			return fmt.Errorf("run from a workspace directory or the project folder (%s)", parentRoot)
		}
		projectID = parentCfg.ProjectID
	}

	// Resolve source workspace when --from is specified or we're at project root
	if fromWorkspace != "" || sourceWorkspaceRoot == "" {
		sourceName := fromWorkspace
		if sourceName == "" {
			// At project root with no --from: use main workspace
			sourceName = resolveMainWorkspaceName(parentRoot, parentCfg)
			if sourceName == "" {
				return fmt.Errorf("no main workspace found - specify a source with --from <workspace>")
			}
		}

		sourceWorkspaceRoot, sourceWorkspaceCfg, err = findSourceWorkspace(sourceName, projectID, parentRoot)
		if err != nil {
			return err
		}
	}

	// Get the source workspace's latest snapshot (fork point)
	s := store.OpenFromWorkspace(sourceWorkspaceRoot)
	forkSnapshotID := sourceWorkspaceCfg.CurrentSnapshotID
	if forkSnapshotID == "" {
		latestID, _ := s.GetLatestSnapshotIDForWorkspace(sourceWorkspaceCfg.WorkspaceID)
		forkSnapshotID = latestID
	}
	if forkSnapshotID == "" {
		forkSnapshotID = sourceWorkspaceCfg.BaseSnapshotID
	}
	if forkSnapshotID == "" {
		return fmt.Errorf("source workspace '%s' has no snapshots - run 'fst snapshot' there first", sourceWorkspaceCfg.WorkspaceName)
	}

	// Determine workspace name
	if len(args) == 0 {
		return fmt.Errorf("workspace name is required")
	}
	workspaceName := args[0]

	// Determine target directory (atomic mkdir to avoid TOCTOU race)
	targetDir := filepath.Join(parentRoot, workspaceName)

	fmt.Printf("Creating workspace '%s' from '%s'...\n", workspaceName, sourceWorkspaceCfg.WorkspaceName)

	// Copy files from source workspace (respecting .fstignore)
	matcher, err := ignore.LoadFromDir(sourceWorkspaceRoot)
	if err != nil {
		return fmt.Errorf("failed to load ignore patterns: %w", err)
	}

	if err := os.Mkdir(targetDir, 0755); err != nil {
		if os.IsExist(err) {
			return fmt.Errorf("target directory already exists: %s", targetDir)
		}
		return fmt.Errorf("failed to create workspace directory: %w", err)
	}

	fmt.Printf("Copying files...\n")

	copied := 0
	cloned := 0
	err = filepath.Walk(sourceWorkspaceRoot, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}

		relPath, err := filepath.Rel(sourceWorkspaceRoot, path)
		if err != nil {
			return err
		}
		if relPath == "." {
			return nil
		}

		relPath = filepath.ToSlash(relPath)
		if matcher.Match(relPath, info.IsDir()) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		targetPath := filepath.Join(targetDir, relPath)

		// Handle symlinks: recreate the link rather than copying the target
		if info.Mode()&os.ModeSymlink != 0 {
			linkTarget, err := os.Readlink(path)
			if err != nil {
				return fmt.Errorf("failed to read symlink %s: %w", relPath, err)
			}
			if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
				return err
			}
			if err := os.Symlink(linkTarget, targetPath); err != nil {
				return fmt.Errorf("failed to create symlink %s: %w", relPath, err)
			}
			copied++
			return nil
		}

		if info.IsDir() {
			return os.MkdirAll(targetPath, info.Mode())
		}

		usedClone, err := materializeWorkspaceFile(path, targetPath, info.Mode(), backend)
		if err != nil {
			return fmt.Errorf("failed to copy %s: %w", relPath, err)
		}
		if usedClone {
			cloned++
		} else {
			copied++
		}
		return nil
	})
	if err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to copy files: %w", err)
	}

	fmt.Printf("Materialized %d files (cloned: %d, copied: %d).\n", copied+cloned, cloned, copied)

	// Initialize .fst config in the new workspace
	workspaceID := generateWorkspaceID()
	if err := config.InitAt(targetDir, projectID, workspaceID, workspaceName, forkSnapshotID); err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to initialize workspace: %w", err)
	}

	// Set base and current snapshot to the fork point
	newCfg, err := config.LoadAt(targetDir)
	if err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to load new workspace config: %w", err)
	}
	newCfg.BaseSnapshotID = forkSnapshotID
	newCfg.CurrentSnapshotID = forkSnapshotID
	newCfg.Mode = sourceWorkspaceCfg.Mode
	if err := config.SaveAt(targetDir, newCfg); err != nil {
		os.RemoveAll(targetDir)
		return fmt.Errorf("failed to save workspace config: %w", err)
	}

	// Copy fork-point snapshot metadata and manifest if stores are separate
	sourceSnapshotsDir := config.GetSnapshotsDirAt(sourceWorkspaceRoot)
	targetSnapshotsDir := config.GetSnapshotsDirAt(targetDir)
	if sourceSnapshotsDir != targetSnapshotsDir {
		sourceManifestsDir := config.GetManifestsDirAt(sourceWorkspaceRoot)
		targetManifestsDir := config.GetManifestsDirAt(targetDir)
		_ = os.MkdirAll(targetManifestsDir, 0755)

		if manifestHash, err := config.ManifestHashFromSnapshotIDAt(sourceWorkspaceRoot, forkSnapshotID); err == nil {
			src := filepath.Join(sourceManifestsDir, manifestHash+".json")
			dst := filepath.Join(targetManifestsDir, manifestHash+".json")
			if _, statErr := os.Stat(dst); statErr != nil {
				_ = copyFile(src, dst, 0644)
			}
		}

		src := filepath.Join(sourceSnapshotsDir, forkSnapshotID+".meta.json")
		dst := filepath.Join(targetSnapshotsDir, forkSnapshotID+".meta.json")
		if _, statErr := os.Stat(dst); statErr != nil {
			_ = copyFile(src, dst, 0644)
		}
	}

	// Register in project-level workspace registry
	projectStore := store.OpenAt(parentRoot)
	if err := projectStore.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       workspaceID,
		WorkspaceName:     workspaceName,
		Path:              targetDir,
		CurrentSnapshotID: forkSnapshotID,
		BaseSnapshotID:    forkSnapshotID,
		CreatedAt:         time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		fmt.Printf("Warning: Could not register workspace in project: %v\n", err)
	}

	fmt.Println()
	fmt.Println("✓ Workspace created!")
	fmt.Println()
	fmt.Printf("  Workspace: %s\n", workspaceName)
	fmt.Printf("  Directory: %s\n", targetDir)
	fmt.Printf("  Forked:    %s (%s)\n", sourceWorkspaceCfg.WorkspaceName, forkSnapshotID[:12])
	fmt.Println()
	fmt.Println("Next steps:")
	fmt.Printf("  cd %s\n", targetDir)
	fmt.Println("  fst snapshot      # Capture your changes")
	fmt.Println("  fst drift         # Compare with source")

	return nil
}

// resolveMainWorkspaceName finds the main workspace name for the project.
func resolveMainWorkspaceName(parentRoot string, parentCfg *config.ParentConfig) string {
	// Try to find main workspace from project-level registry
	s := store.OpenAt(parentRoot)
	workspaces, err := s.ListWorkspaces()
	if err != nil {
		return ""
	}

	// Check if a main workspace is defined
	if parentCfg.BaseWorkspaceID != "" {
		for _, ws := range workspaces {
			if ws.WorkspaceID == parentCfg.BaseWorkspaceID {
				return ws.WorkspaceName
			}
		}
	}

	// Look for workspace named "main"
	for _, ws := range workspaces {
		if ws.WorkspaceName == "main" {
			return ws.WorkspaceName
		}
	}

	// Fall back to first workspace
	if len(workspaces) > 0 {
		return workspaces[0].WorkspaceName
	}

	return ""
}

// findSourceWorkspace finds a workspace by name and returns its root and config.
func findSourceWorkspace(name, projectID, parentRoot string) (string, *config.ProjectConfig, error) {
	// Try project-level registry first
	s := store.OpenAt(parentRoot)
	wsInfo, err := s.FindWorkspaceByName(name)
	if err == nil && wsInfo.Path != "" {
		cfg, err := config.LoadAt(wsInfo.Path)
		if err == nil {
			return wsInfo.Path, cfg, nil
		}
	}

	return "", nil, fmt.Errorf("workspace '%s' not found - run 'fst workspaces' to see available workspaces", name)
}

func defaultWorkspaceName(projectName string) string {
	return fmt.Sprintf("%s-%s", projectName, randomSuffix(4))
}

func parseCreateBackend(value string) (createBackend, error) {
	v := strings.ToLower(strings.TrimSpace(value))
	switch createBackend(v) {
	case createBackendAuto:
		return createBackendAuto, nil
	case createBackendClone:
		return createBackendClone, nil
	case createBackendCopy:
		return createBackendCopy, nil
	default:
		return "", fmt.Errorf("invalid backend %q (expected: auto, clone, copy)", value)
	}
}

func materializeWorkspaceFile(src, dst string, mode os.FileMode, backend createBackend) (bool, error) {
	if backend == createBackendCopy || !mode.IsRegular() {
		return false, copyFile(src, dst, mode)
	}

	if err := cloneFileFunc(src, dst, mode); err == nil {
		return true, nil
	} else if backend == createBackendClone {
		return false, err
	}

	// Best-effort fallback for auto mode when clone is unavailable.
	_ = os.Remove(dst)
	return false, copyFile(src, dst, mode)
}

func cloneFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	if err := cloneFileNative(src, dst); err != nil {
		return err
	}

	return os.Chmod(dst, mode)
}
