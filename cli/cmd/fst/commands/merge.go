package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	// Remove the placeholder merge command and add the real one
	for i, cmd := range rootCmd.Commands() {
		if cmd.Use == "merge <source-workspace>" {
			rootCmd.RemoveCommand(cmd)
			break
		}
		_ = i
	}
	rootCmd.AddCommand(newMergeCmd())
}

func newMergeCmd() *cobra.Command {
	var useAgent bool
	var manual bool
	var cherryPick []string
	var dryRun bool
	var fromPath string

	cmd := &cobra.Command{
		Use:   "merge [workspace]",
		Short: "Merge changes from another workspace",
		Long: `Merge changes from another workspace into the current one.

This performs a three-way merge:
1. BASE: The common ancestor snapshot
2. LOCAL: Your current workspace
3. REMOTE: The source workspace you're merging from

Non-conflicting changes are applied automatically. For conflicts:
- Default (--agent): Uses your coding agent (claude, aider, etc.) to intelligently merge
- Manual (--manual): Creates conflict markers for you to resolve

Use --from to specify the source workspace path directly (no cloud auth needed).
Or provide a workspace name to look it up from the cloud.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if useAgent && manual {
				return fmt.Errorf("cannot use both --agent and --manual")
			}
			var workspaceName string
			if len(args) > 0 {
				workspaceName = args[0]
			}
			if workspaceName == "" && fromPath == "" {
				return fmt.Errorf("must specify workspace name or --from path")
			}
			return runMerge(workspaceName, fromPath, !manual, cherryPick, dryRun)
		},
	}

	cmd.Flags().BoolVar(&useAgent, "agent", true, "Use coding agent for conflict resolution (default)")
	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().StringSliceVar(&cherryPick, "cherry-pick", nil, "Only merge specific files")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be merged without making changes")
	cmd.Flags().StringVar(&fromPath, "from", "", "Source workspace path (local merge without cloud)")

	return cmd
}

// MergeResult tracks the result of a merge operation
type MergeResult struct {
	Applied    []string // Files applied without conflict
	Conflicts  []string // Files with conflicts
	Skipped    []string // Files skipped (cherry-pick filter)
	Failed     []string // Files that failed to merge
	AgentUsed  bool
	ManualMode bool
}

func runMerge(sourceName string, fromPath string, useAgent bool, cherryPick []string, dryRun bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	localRoot, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var sourceRoot string
	var sourceDisplayName string

	// If --from path is specified, use it directly (no cloud auth needed)
	if fromPath != "" {
		// Resolve to absolute path
		if !filepath.IsAbs(fromPath) {
			cwd, err := os.Getwd()
			if err != nil {
				return err
			}
			fromPath = filepath.Join(cwd, fromPath)
		}
		sourceRoot = fromPath

		// Try to read source workspace name from config
		sourceConfigPath := filepath.Join(sourceRoot, ".fst", "config.json")
		if data, err := os.ReadFile(sourceConfigPath); err == nil {
			var sourceCfg config.ProjectConfig
			if json.Unmarshal(data, &sourceCfg) == nil && sourceCfg.WorkspaceName != "" {
				sourceDisplayName = sourceCfg.WorkspaceName
			}
		}
		if sourceDisplayName == "" {
			sourceDisplayName = filepath.Base(sourceRoot)
		}
	} else {
		// Look up workspace from cloud
		token, err := auth.GetToken()
		if err != nil || token == "" {
			return fmt.Errorf("not logged in - use --from <path> for local merge, or 'fst login' for cloud")
		}

		client := api.NewClient(token)
		_, workspaces, err := client.GetProject(cfg.ProjectID)
		if err != nil {
			return fmt.Errorf("failed to fetch project: %w", err)
		}

		var sourceWorkspace *api.Workspace
		for _, ws := range workspaces {
			if ws.Name == sourceName || ws.ID == sourceName {
				sourceWorkspace = &ws
				break
			}
		}

		if sourceWorkspace == nil {
			return fmt.Errorf("workspace '%s' not found", sourceName)
		}

		if sourceWorkspace.LocalPath == nil || *sourceWorkspace.LocalPath == "" {
			return fmt.Errorf("source workspace has no local path - cannot merge from remote workspaces yet")
		}

		sourceRoot = *sourceWorkspace.LocalPath
		sourceDisplayName = sourceWorkspace.Name
	}

	// Verify source path exists
	if _, err := os.Stat(sourceRoot); os.IsNotExist(err) {
		return fmt.Errorf("source workspace path does not exist: %s", sourceRoot)
	}

	fmt.Printf("Merging from: %s (%s)\n", sourceDisplayName, sourceRoot)
	fmt.Printf("Into:         %s (%s)\n", cfg.WorkspaceName, localRoot)
	fmt.Println()

	// Load base manifest (common ancestor)
	baseManifest, err := loadBaseManifest(cfg)
	if err != nil {
		fmt.Printf("Warning: Could not load base manifest: %v\n", err)
		fmt.Println("Proceeding without three-way merge (will treat all changes as additions)")
		baseManifest = &manifest.Manifest{Version: "1", Files: []manifest.FileEntry{}}
	}

	// Generate manifests for local and remote
	fmt.Println("Scanning local workspace...")
	localManifest, err := manifest.Generate(localRoot, false)
	if err != nil {
		return fmt.Errorf("failed to scan local workspace: %w", err)
	}

	fmt.Println("Scanning source workspace...")
	sourceManifest, err := manifest.Generate(sourceRoot, false)
	if err != nil {
		return fmt.Errorf("failed to scan source workspace: %w", err)
	}

	// Compute three-way diff
	fmt.Println("Computing differences...")
	mergeActions := computeMergeActions(baseManifest, localManifest, sourceManifest, cherryPick)

	// Display summary
	fmt.Println()
	fmt.Printf("Merge plan:\n")
	fmt.Printf("  Apply from source:  %d files\n", len(mergeActions.toApply))
	fmt.Printf("  Conflicts:          %d files\n", len(mergeActions.conflicts))
	fmt.Printf("  Already in sync:    %d files\n", len(mergeActions.inSync))
	if len(cherryPick) > 0 {
		fmt.Printf("  Skipped (filter):   %d files\n", len(mergeActions.skipped))
	}
	fmt.Println()

	if len(mergeActions.toApply) == 0 && len(mergeActions.conflicts) == 0 {
		fmt.Println("✓ Nothing to merge - workspaces are in sync")
		return nil
	}

	if dryRun {
		printMergePlan(mergeActions)
		fmt.Println()
		fmt.Println("(Dry run - no changes made)")
		return nil
	}

	result := &MergeResult{
		AgentUsed:  useAgent,
		ManualMode: !useAgent,
	}

	// Apply non-conflicting changes
	if len(mergeActions.toApply) > 0 {
		fmt.Println("Applying non-conflicting changes...")
		for _, action := range mergeActions.toApply {
			if err := applyChange(localRoot, sourceRoot, action); err != nil {
				fmt.Printf("  ✗ %s: %v\n", action.path, err)
				result.Failed = append(result.Failed, action.path)
			} else {
				fmt.Printf("  ✓ %s\n", action.path)
				result.Applied = append(result.Applied, action.path)
			}
		}
		fmt.Println()
	}

	// Handle conflicts
	if len(mergeActions.conflicts) > 0 {
		if useAgent {
			fmt.Println("Resolving conflicts with agent...")
			preferredAgent, err := agent.GetPreferredAgent()
			if err != nil {
				fmt.Printf("Warning: %v\n", err)
				fmt.Println("Falling back to manual conflict markers...")
				useAgent = false
			} else {
				fmt.Printf("Using %s for conflict resolution...\n", preferredAgent.Name)
				for _, conflict := range mergeActions.conflicts {
					if err := resolveConflictWithAgent(localRoot, sourceRoot, conflict, preferredAgent, baseManifest); err != nil {
						fmt.Printf("  ✗ %s: %v (creating conflict markers)\n", conflict.path, err)
						// Fall back to manual for this file
						if err := createConflictMarkers(localRoot, sourceRoot, conflict); err != nil {
							result.Failed = append(result.Failed, conflict.path)
						} else {
							result.Conflicts = append(result.Conflicts, conflict.path)
						}
					} else {
						fmt.Printf("  ✓ %s (merged by agent)\n", conflict.path)
						result.Applied = append(result.Applied, conflict.path)
					}
				}
			}
		}

		if !useAgent {
			fmt.Println("Creating conflict markers for manual resolution...")
			for _, conflict := range mergeActions.conflicts {
				if err := createConflictMarkers(localRoot, sourceRoot, conflict); err != nil {
					fmt.Printf("  ✗ %s: %v\n", conflict.path, err)
					result.Failed = append(result.Failed, conflict.path)
				} else {
					fmt.Printf("  ⚠ %s (needs manual resolution)\n", conflict.path)
					result.Conflicts = append(result.Conflicts, conflict.path)
				}
			}
		}
		fmt.Println()
	}

	// Summary
	fmt.Println("Merge complete:")
	fmt.Printf("  ✓ Applied:   %d files\n", len(result.Applied))
	if len(result.Conflicts) > 0 {
		fmt.Printf("  ⚠ Conflicts: %d files (need resolution)\n", len(result.Conflicts))
	}
	if len(result.Failed) > 0 {
		fmt.Printf("  ✗ Failed:    %d files\n", len(result.Failed))
	}

	if len(result.Conflicts) > 0 && !useAgent {
		fmt.Println()
		fmt.Println("To resolve conflicts manually:")
		fmt.Println("  1. Edit the conflicting files (look for <<<<<<< markers)")
		fmt.Println("  2. Remove the conflict markers")
		fmt.Println("  3. Run 'fst snapshot' to save the merged state")
	}

	return nil
}

// MergeAction represents a single file merge action
type mergeAction struct {
	path       string
	actionType string // "apply", "conflict", "skip", "in_sync"
	localHash  string
	sourceHash string
	baseHash   string
}

// MergeActions holds all computed merge actions
type mergeActions struct {
	toApply   []mergeAction
	conflicts []mergeAction
	inSync    []mergeAction
	skipped   []mergeAction
}

func computeMergeActions(base, local, source *manifest.Manifest, cherryPick []string) *mergeActions {
	result := &mergeActions{}

	// Build lookup maps
	baseFiles := make(map[string]manifest.FileEntry)
	for _, f := range base.Files {
		baseFiles[f.Path] = f
	}

	localFiles := make(map[string]manifest.FileEntry)
	for _, f := range local.Files {
		localFiles[f.Path] = f
	}

	sourceFiles := make(map[string]manifest.FileEntry)
	for _, f := range source.Files {
		sourceFiles[f.Path] = f
	}

	// Build cherry-pick filter
	cherryPickSet := make(map[string]bool)
	for _, f := range cherryPick {
		cherryPickSet[f] = true
	}
	useCherryPick := len(cherryPick) > 0

	// Collect all unique paths
	allPaths := make(map[string]bool)
	for path := range baseFiles {
		allPaths[path] = true
	}
	for path := range localFiles {
		allPaths[path] = true
	}
	for path := range sourceFiles {
		allPaths[path] = true
	}

	for path := range allPaths {
		// Check cherry-pick filter
		if useCherryPick && !cherryPickSet[path] {
			result.skipped = append(result.skipped, mergeAction{path: path, actionType: "skip"})
			continue
		}

		baseFile, inBase := baseFiles[path]
		localFile, inLocal := localFiles[path]
		sourceFile, inSource := sourceFiles[path]

		action := mergeAction{
			path: path,
		}

		if inBase {
			action.baseHash = baseFile.Hash
		}
		if inLocal {
			action.localHash = localFile.Hash
		}
		if inSource {
			action.sourceHash = sourceFile.Hash
		}

		// Determine action based on three-way comparison
		localChanged := !inBase && inLocal || (inBase && inLocal && baseFile.Hash != localFile.Hash)
		sourceChanged := !inBase && inSource || (inBase && inSource && baseFile.Hash != sourceFile.Hash)
		localDeleted := inBase && !inLocal
		sourceDeleted := inBase && !inSource

		switch {
		case !inSource && !sourceDeleted:
			// File only exists locally or was deleted in source but we have it
			// Nothing to merge from source
			continue

		case !inLocal && inSource:
			// File only in source (added in source) - apply
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)

		case localDeleted && inSource:
			// We deleted, source has it - conflict (or apply source?)
			// Treat as conflict - let user decide
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)

		case sourceDeleted && inLocal:
			// Source deleted, we have it - keep ours (no action needed)
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case inLocal && inSource && localFile.Hash == sourceFile.Hash:
			// Same content - in sync
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case !localChanged && sourceChanged:
			// Only source changed - apply
			action.actionType = "apply"
			result.toApply = append(result.toApply, action)

		case localChanged && !sourceChanged:
			// Only local changed - keep ours (already have it)
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)

		case localChanged && sourceChanged:
			// Both changed - conflict
			action.actionType = "conflict"
			result.conflicts = append(result.conflicts, action)

		default:
			// No changes
			action.actionType = "in_sync"
			result.inSync = append(result.inSync, action)
		}
	}

	return result
}

func printMergePlan(actions *mergeActions) {
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

func applyChange(localRoot, sourceRoot string, action mergeAction) error {
	sourcePath := filepath.Join(sourceRoot, action.path)
	localPath := filepath.Join(localRoot, action.path)

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return err
	}

	// Read source file
	content, err := os.ReadFile(sourcePath)
	if err != nil {
		return fmt.Errorf("failed to read source: %w", err)
	}

	// Get source file mode
	info, err := os.Stat(sourcePath)
	if err != nil {
		return fmt.Errorf("failed to stat source: %w", err)
	}

	// Write to local
	if err := os.WriteFile(localPath, content, info.Mode()); err != nil {
		return fmt.Errorf("failed to write: %w", err)
	}

	return nil
}

func resolveConflictWithAgent(localRoot, sourceRoot string, action mergeAction, ag *agent.Agent, baseManifest *manifest.Manifest) error {
	localPath := filepath.Join(localRoot, action.path)
	sourcePath := filepath.Join(sourceRoot, action.path)

	// Read local content
	localContent, err := os.ReadFile(localPath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read local: %w", err)
	}

	// Read source content
	sourceContent, err := os.ReadFile(sourcePath)
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to read source: %w", err)
	}

	// Try to get base content (may not exist)
	var baseContent []byte
	if action.baseHash != "" {
		// In a full implementation, we'd fetch this from the cache
		// For now, we'll work without it
	}

	// Invoke agent to merge
	merged, err := agent.InvokeMerge(ag,
		string(baseContent),
		string(localContent),
		string(sourceContent),
		action.path,
	)
	if err != nil {
		return err
	}

	// Write merged content
	info, err := os.Stat(sourcePath)
	mode := os.FileMode(0644)
	if err == nil {
		mode = info.Mode()
	}

	if err := os.WriteFile(localPath, []byte(merged), mode); err != nil {
		return fmt.Errorf("failed to write merged: %w", err)
	}

	return nil
}

func createConflictMarkers(localRoot, sourceRoot string, action mergeAction) error {
	localPath := filepath.Join(localRoot, action.path)
	sourcePath := filepath.Join(sourceRoot, action.path)

	// Read both versions
	localContent, localErr := os.ReadFile(localPath)
	sourceContent, sourceErr := os.ReadFile(sourcePath)

	if localErr != nil && sourceErr != nil {
		return fmt.Errorf("cannot read either version")
	}

	// Build conflict content
	var result strings.Builder

	result.WriteString("<<<<<<< LOCAL (this workspace)\n")
	if localErr == nil {
		result.Write(localContent)
		if len(localContent) > 0 && localContent[len(localContent)-1] != '\n' {
			result.WriteString("\n")
		}
	} else {
		result.WriteString("(file does not exist locally)\n")
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

	result.WriteString(">>>>>>> REMOTE (source workspace)\n")

	// Ensure parent directory exists
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return err
	}

	// Write conflict file
	if err := os.WriteFile(localPath, []byte(result.String()), 0644); err != nil {
		return err
	}

	return nil
}

func loadBaseManifest(cfg *config.ProjectConfig) (*manifest.Manifest, error) {
	if cfg.BaseSnapshotID == "" {
		return nil, fmt.Errorf("no base snapshot")
	}

	configDir, err := config.GetConfigDir()
	if err != nil {
		return nil, err
	}

	manifestPath := filepath.Join(configDir, "cache", "manifests", cfg.BaseSnapshotID+".json")
	data, err := os.ReadFile(manifestPath)
	if err != nil {
		return nil, fmt.Errorf("manifest not in cache: %w", err)
	}

	return manifest.FromJSON(data)
}
