package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/conflicts"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newDriftCmd()) })
}

// driftResult is the top-level JSON output structure
type driftResult struct {
	OurWorkspace      string           `json:"our_workspace"`
	TheirWorkspace    string           `json:"their_workspace"`
	CommonAncestorID  string           `json:"common_ancestor_id,omitempty"`
	Mode              string           `json:"mode"`
	OurChanges        *drift.Report    `json:"our_changes"`
	TheirChanges      *drift.Report    `json:"their_changes"`
	SnapshotConflicts *conflictSummary `json:"snapshot_conflicts"`
	DirtyConflicts    *conflictSummary `json:"dirty_conflicts,omitempty"`
	OverlappingFiles  []string         `json:"overlapping_files"`
	Summary           string           `json:"summary,omitempty"`
}

type conflictSummary struct {
	TotalFiles   int                   `json:"total_files"`
	TotalRegions int                   `json:"total_regions"`
	Files        []fileConflictSummary `json:"files"`
}

type fileConflictSummary struct {
	Path          string `json:"path"`
	ConflictCount int    `json:"conflict_count"`
}

func newDriftCmd() *cobra.Command {
	var jsonOutput bool
	var summary bool
	var noDirty bool

	cmd := &cobra.Command{
		Use:   "drift [workspace-name]",
		Short: "Show drift and conflicts with another workspace",
		Long: `Show how this workspace has diverged from another workspace,
including file-level conflicts detected via 3-way merge against
their common ancestor (found via DAG traversal).

By default, includes uncommitted (dirty) changes in the analysis.
Use --no-dirty to compare only committed snapshots.

With no argument, compares against the project's main workspace.

Examples:
  fst drift                    # Drift vs main workspace
  fst drift feature-branch     # Drift vs workspace named "feature-branch"
  fst drift --no-dirty         # Compare committed snapshots only
  fst drift --json             # Output as JSON
  fst drift --agent-summary    # Generate AI risk assessment`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			if len(args) > 0 {
				target = args[0]
			}
			return runDrift(target, jsonOutput, summary, noDirty)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")
	cmd.Flags().BoolVar(&summary, "agent-summary", false, "Generate AI drift risk assessment (requires configured agent)")
	cmd.Flags().BoolVar(&noDirty, "no-dirty", false, "Compare committed snapshots only, skip dirty changes")

	return cmd
}

func runDrift(target string, jsonOutput, generateSummary, noDirty bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Resolve target workspace
	otherRoot, otherName, err := resolveTargetWorkspace(target, cfg)
	if err != nil {
		return err
	}

	// Verify target workspace still exists on disk
	if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
		return fmt.Errorf("workspace no longer exists at: %s", otherRoot)
	}

	// Get snapshot heads for both workspaces
	ourHead := cfg.CurrentSnapshotID
	if ourHead == "" {
		ourHead, _ = config.GetLatestSnapshotIDAt(root)
	}

	theirCfg, err := config.LoadAt(otherRoot)
	if err != nil {
		return fmt.Errorf("failed to load target workspace config: %w", err)
	}
	theirHead := theirCfg.CurrentSnapshotID
	if theirHead == "" {
		theirHead, _ = config.GetLatestSnapshotIDAt(otherRoot)
	}

	if ourHead == "" || theirHead == "" {
		return fmt.Errorf("both workspaces must have at least one snapshot for drift analysis")
	}

	// Find common ancestor via DAG traversal
	mergeBaseID, err := dag.GetMergeBase(root, otherRoot, ourHead, theirHead)
	if err != nil {
		return fmt.Errorf("could not find common ancestor: %w\nBoth workspaces need shared snapshot history.", err)
	}

	// Load ancestor manifest (try both workspace dirs)
	ancestorManifest, err := drift.LoadManifestFromSnapshots(root, mergeBaseID)
	if err != nil {
		ancestorManifest, err = drift.LoadManifestFromSnapshots(otherRoot, mergeBaseID)
		if err != nil {
			return fmt.Errorf("failed to load common ancestor manifest: %w", err)
		}
	}

	// Compute drift on each side
	includeDirty := !noDirty
	ourManifest, err := loadManifestForDrift(root, ourHead, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to load current workspace state: %w", err)
	}
	theirManifest, err := loadManifestForDrift(otherRoot, theirHead, includeDirty)
	if err != nil {
		return fmt.Errorf("failed to load target workspace state: %w", err)
	}

	ourChanges := drift.CompareManifests(ancestorManifest, ourManifest)
	theirChanges := drift.CompareManifests(ancestorManifest, theirManifest)

	// Detect snapshot-based conflicts (always)
	snapshotConflictReport, err := conflicts.DetectFromAncestor(root, otherRoot, mergeBaseID, false)
	if err != nil {
		return fmt.Errorf("failed to detect snapshot conflicts: %w", err)
	}
	snapshotSummary := aggregateConflicts(snapshotConflictReport)

	// Detect dirty conflicts (if enabled)
	var dirtySummary *conflictSummary
	if includeDirty {
		dirtyConflictReport, err := conflicts.DetectFromAncestor(root, otherRoot, mergeBaseID, true)
		if err != nil {
			return fmt.Errorf("failed to detect dirty conflicts: %w", err)
		}
		// Compute dirty-only conflicts (additional conflicts not in snapshot)
		dirtySummary = subtractConflicts(dirtyConflictReport, snapshotConflictReport)
	}

	// Compute overlapping files (modified in both but may not conflict)
	overlapping := findOverlappingPaths(ourChanges, theirChanges)

	// Generate agent summary if requested
	var summaryText string
	if generateSummary {
		summaryText = generateDriftSummary(cfg.WorkspaceName, otherName, ourChanges, theirChanges, snapshotSummary, dirtySummary)
	}

	// Build result
	mode := "dirty"
	if noDirty {
		mode = "snapshot"
	}

	result := driftResult{
		OurWorkspace:      cfg.WorkspaceName,
		TheirWorkspace:    otherName,
		CommonAncestorID:  mergeBaseID,
		Mode:              mode,
		OurChanges:        ourChanges,
		TheirChanges:      theirChanges,
		SnapshotConflicts: snapshotSummary,
		DirtyConflicts:    dirtySummary,
		OverlappingFiles:  overlapping,
		Summary:           summaryText,
	}

	// JSON output
	if jsonOutput {
		data, err := json.MarshalIndent(result, "", "  ")
		if err != nil {
			return fmt.Errorf("failed to serialize result: %w", err)
		}
		fmt.Println(string(data))
		return nil
	}

	// Human-readable output
	printDriftReport(result, includeDirty)

	return nil
}

// resolveTargetWorkspace resolves the target workspace by name or defaults to main
func resolveTargetWorkspace(target string, cfg *config.ProjectConfig) (root, name string, err error) {
	if target != "" {
		// Look up by name only
		ws, err := FindWorkspaceByName(cfg.ProjectID, target)
		if err != nil {
			return "", "", fmt.Errorf("workspace '%s' not found in project\nRun 'fst workspaces' to see available workspaces.", target)
		}
		return ws.Path, ws.Name, nil
	}

	// No target — compare against main workspace
	token, err := deps.AuthGetToken()
	if err != nil {
		return "", "", deps.AuthFormatError(err)
	}
	if token == "" {
		return "", "", fmt.Errorf("not logged in - run 'fst login' first\nOr specify a workspace: fst drift <workspace-name>")
	}

	client := deps.NewAPIClient(token, cfg)
	project, workspacesList, err := client.GetProject(cfg.ProjectID)
	if err != nil {
		return "", "", fmt.Errorf("failed to fetch project: %w", err)
	}

	if project.MainWorkspaceID == nil || *project.MainWorkspaceID == "" {
		return "", "", fmt.Errorf("no main workspace configured for this project\nSet one with: fst workspace set-main <workspace>")
	}

	if *project.MainWorkspaceID == cfg.WorkspaceID {
		return "", "", fmt.Errorf("this is the main workspace - specify a workspace to compare against:\n  fst drift <workspace-name>")
	}

	// Find main workspace name from API response
	var mainName string
	for _, ws := range workspacesList {
		if ws.ID == *project.MainWorkspaceID {
			mainName = ws.Name
			break
		}
	}

	// Look up main workspace path from local registry
	registry, err := LoadRegistry()
	if err != nil {
		return "", "", fmt.Errorf("failed to load workspace registry: %w", err)
	}

	for _, ws := range registry.Workspaces {
		if ws.ID == *project.MainWorkspaceID {
			return ws.Path, ws.Name, nil
		}
	}

	return "", "", fmt.Errorf("main workspace '%s' not found locally\nIt may be on a different machine. Use 'fst workspace copy' to clone it.", mainName)
}

// loadManifestForDrift loads a workspace manifest for drift comparison
func loadManifestForDrift(root, snapshotID string, includeDirty bool) (*manifest.Manifest, error) {
	if includeDirty {
		return manifest.Generate(root, false)
	}
	return drift.LoadManifestFromSnapshots(root, snapshotID)
}

// aggregateConflicts builds a conflictSummary from a conflicts.Report
func aggregateConflicts(report *conflicts.Report) *conflictSummary {
	summary := &conflictSummary{}
	for _, c := range report.Conflicts {
		count := len(c.Hunks)
		summary.Files = append(summary.Files, fileConflictSummary{
			Path:          c.Path,
			ConflictCount: count,
		})
		summary.TotalRegions += count
	}
	summary.TotalFiles = len(summary.Files)
	return summary
}

// subtractConflicts returns conflicts in "full" that are NOT in "baseline"
// (i.e., additional conflicts introduced by dirty changes)
func subtractConflicts(full, baseline *conflicts.Report) *conflictSummary {
	baselineSet := make(map[string]int) // path → hunk count
	for _, c := range baseline.Conflicts {
		baselineSet[c.Path] = len(c.Hunks)
	}

	summary := &conflictSummary{}
	for _, c := range full.Conflicts {
		fullCount := len(c.Hunks)
		baseCount := baselineSet[c.Path]
		additional := fullCount - baseCount
		if additional > 0 {
			summary.Files = append(summary.Files, fileConflictSummary{
				Path:          c.Path,
				ConflictCount: additional,
			})
			summary.TotalRegions += additional
		} else if baseCount == 0 && fullCount > 0 {
			// Entirely new conflict file from dirty changes
			summary.Files = append(summary.Files, fileConflictSummary{
				Path:          c.Path,
				ConflictCount: fullCount,
			})
			summary.TotalRegions += fullCount
		}
	}
	summary.TotalFiles = len(summary.Files)
	return summary
}

// findOverlappingPaths returns files modified/added in both reports
func findOverlappingPaths(ours, theirs *drift.Report) []string {
	ourSet := make(map[string]bool)
	for _, f := range ours.FilesAdded {
		ourSet[f] = true
	}
	for _, f := range ours.FilesModified {
		ourSet[f] = true
	}

	var overlapping []string
	for _, f := range theirs.FilesAdded {
		if ourSet[f] {
			overlapping = append(overlapping, f)
		}
	}
	for _, f := range theirs.FilesModified {
		if ourSet[f] {
			overlapping = append(overlapping, f)
		}
	}
	return overlapping
}

// generateDriftSummary invokes the agent to produce a drift risk assessment
func generateDriftSummary(ourName, theirName string, ourChanges, theirChanges *drift.Report, snapshotConflicts, dirtyConflicts *conflictSummary) string {
	preferredAgent, err := agent.GetPreferredAgent()
	if err != nil {
		fmt.Printf("Warning: %v\n", err)
		return ""
	}

	fmt.Printf("Generating drift assessment with %s...\n", preferredAgent.Name)

	var snapshotList, dirtyList []agent.FileConflictSummary
	if snapshotConflicts != nil {
		for _, f := range snapshotConflicts.Files {
			snapshotList = append(snapshotList, agent.FileConflictSummary{
				Path:          f.Path,
				ConflictCount: f.ConflictCount,
			})
		}
	}
	if dirtyConflicts != nil {
		for _, f := range dirtyConflicts.Files {
			dirtyList = append(dirtyList, agent.FileConflictSummary{
				Path:          f.Path,
				ConflictCount: f.ConflictCount,
			})
		}
	}

	context := agent.BuildDriftContext(
		ourName, theirName,
		ourChanges.FilesAdded, ourChanges.FilesModified, ourChanges.FilesDeleted,
		theirChanges.FilesAdded, theirChanges.FilesModified, theirChanges.FilesDeleted,
		snapshotList, dirtyList,
	)

	summaryText, err := agent.InvokeDriftSummary(preferredAgent, context)
	if err != nil {
		fmt.Printf("Warning: Failed to generate summary: %v\n", err)
		return ""
	}
	return summaryText
}

// printDriftReport displays the human-readable drift report
func printDriftReport(result driftResult, includeDirty bool) {
	fmt.Printf("Drift: %s <-> %s\n", result.OurWorkspace, result.TheirWorkspace)
	fmt.Printf("Common ancestor: %s\n", result.CommonAncestorID)
	if includeDirty {
		fmt.Println("Mode: current files (dirty)")
	} else {
		fmt.Println("Mode: committed snapshots")
	}
	fmt.Println()

	ourHasChanges := result.OurChanges != nil && result.OurChanges.HasChanges()
	theirHasChanges := result.TheirChanges != nil && result.TheirChanges.HasChanges()

	if !ourHasChanges && !theirHasChanges {
		fmt.Println("Workspaces are in sync. No drift detected.")
		return
	}

	if ourHasChanges {
		fmt.Println("Our changes (from ancestor):")
		printChanges(result.OurChanges)
		fmt.Println()
	}

	if theirHasChanges {
		fmt.Println("Their changes (from ancestor):")
		printChanges(result.TheirChanges)
		fmt.Println()
	}

	// Snapshot conflicts
	if result.SnapshotConflicts != nil && result.SnapshotConflicts.TotalFiles > 0 {
		fmt.Println("Snapshot conflicts:")
		printConflictSummary(result.SnapshotConflicts)
		fmt.Println()
	}

	// Dirty conflicts (additional)
	if result.DirtyConflicts != nil && result.DirtyConflicts.TotalFiles > 0 {
		fmt.Println("Dirty conflicts (additional):")
		printConflictSummary(result.DirtyConflicts)
		fmt.Println()
	}

	// No conflicts at all
	if (result.SnapshotConflicts == nil || result.SnapshotConflicts.TotalFiles == 0) &&
		(result.DirtyConflicts == nil || result.DirtyConflicts.TotalFiles == 0) {
		if len(result.OverlappingFiles) > 0 {
			fmt.Printf("No conflicts (%d files modified in both workspaces, but changes don't overlap).\n", len(result.OverlappingFiles))
		}
	}

	if result.Summary != "" {
		fmt.Println("Assessment:")
		fmt.Printf("  %s\n", result.Summary)
	}
}

// printChanges prints the changes in a report
func printChanges(report *drift.Report) {
	if len(report.FilesAdded) > 0 {
		fmt.Printf("  Added (%d):\n", len(report.FilesAdded))
		for _, f := range report.FilesAdded {
			fmt.Printf("    \033[32m+ %s\033[0m\n", f)
		}
	}

	if len(report.FilesModified) > 0 {
		fmt.Printf("  Modified (%d):\n", len(report.FilesModified))
		for _, f := range report.FilesModified {
			fmt.Printf("    \033[33m~ %s\033[0m\n", f)
		}
	}

	if len(report.FilesDeleted) > 0 {
		fmt.Printf("  Deleted (%d):\n", len(report.FilesDeleted))
		for _, f := range report.FilesDeleted {
			fmt.Printf("    \033[31m- %s\033[0m\n", f)
		}
	}
}

// printConflictSummary prints aggregated conflict info
func printConflictSummary(cs *conflictSummary) {
	for _, f := range cs.Files {
		label := "conflicts"
		if f.ConflictCount == 1 {
			label = "conflict"
		}
		fmt.Printf("  \033[31m%-40s %d %s\033[0m\n", f.Path, f.ConflictCount, label)
	}
	filesLabel := "files"
	if cs.TotalFiles == 1 {
		filesLabel = "file"
	}
	regionsLabel := "conflicts"
	if cs.TotalRegions == 1 {
		regionsLabel = "conflict"
	}
	fmt.Printf("  Total: %d %s across %d %s\n", cs.TotalRegions, regionsLabel, cs.TotalFiles, filesLabel)
}
