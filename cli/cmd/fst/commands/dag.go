package commands

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/dag"
	"github.com/anthropics/fastest/cli/internal/store"
	"github.com/anthropics/fastest/cli/internal/ui"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newDagCmd()) })
}

func newDagCmd() *cobra.Command {
	var limit int

	cmd := &cobra.Command{
		Use:   "dag",
		Short: "Show project-wide snapshot DAG",
		Long: `Display the snapshot DAG across all workspaces in the project.

Shows a graph of all snapshots reachable from any workspace head,
with merge and fork lines connecting related snapshots.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDag(limit)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "n", 20, "Maximum number of snapshots to show")

	return cmd
}

func runDag(limit int) error {
	parentRoot, _, err := findProjectContext()
	if err != nil {
		return fmt.Errorf("not in a project directory: %w", err)
	}

	s := store.OpenAt(parentRoot)

	// Collect all workspace heads
	workspaces, err := s.ListWorkspaces()
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}

	if len(workspaces) == 0 {
		fmt.Println("No workspaces found.")
		return nil
	}

	// Build head set and workspace label map
	var heads []string
	headLabels := make(map[string]string)
	seen := make(map[string]bool)
	for _, ws := range workspaces {
		if ws.CurrentSnapshotID != "" && !seen[ws.CurrentSnapshotID] {
			heads = append(heads, ws.CurrentSnapshotID)
			seen[ws.CurrentSnapshotID] = true
			headLabels[ws.CurrentSnapshotID] = ws.WorkspaceName
		}
	}

	if len(heads) == 0 {
		fmt.Println("No snapshots found.")
		return nil
	}

	// Load all snapshot metadata
	allMetas, err := s.LoadAllSnapshotMetas()
	if err != nil {
		return fmt.Errorf("failed to load snapshots: %w", err)
	}

	// Build SnapshotInfo map for DAG operations
	snapInfos := make(map[string]*dag.SnapshotInfo, len(allMetas))
	for id, meta := range allMetas {
		snapInfos[id] = &dag.SnapshotInfo{
			ID:        meta.ID,
			ParentIDs: meta.ParentSnapshotIDs,
			CreatedAt: meta.CreatedAt,
		}
	}

	// BFS from all heads and topo sort
	reachable := dag.CollectReachable(heads, snapInfos)
	sorted := dag.TopoSort(heads, reachable)

	if len(sorted) == 0 {
		fmt.Println("No snapshots in graph.")
		return nil
	}

	// Apply limit
	if limit > 0 && len(sorted) > limit {
		sorted = sorted[:limit]
	}

	// Get current workspace snapshot for highlighting
	currentSnapshotID := ""
	if cfg, loadErr := config.Load(); loadErr == nil {
		currentSnapshotID = cfg.CurrentSnapshotID
	}

	// Build short IDs
	ids := make([]string, 0, len(sorted))
	for _, s := range sorted {
		ids = append(ids, s.ID)
	}
	shortIDs := shortenIDs(ids, 12)

	fmt.Printf("Snapshot DAG (%d workspaces, %d snapshots):\n", len(workspaces), len(reachable))
	fmt.Println()

	// Render graph
	renderer := dag.NewGraphRenderer()
	renderer.Colorize = true

	for _, snapInfo := range sorted {
		meta := allMetas[snapInfo.ID]
		if meta == nil {
			continue
		}

		row := renderer.NextRow(snapInfo.ID, snapInfo.ParentIDs)

		// Print pre-lines (merge-in)
		for _, line := range row.PreLines {
			fmt.Println(line)
		}

		// Print node line with snapshot info
		isCurrent := meta.ID == currentSnapshotID
		shortID := shortIDs[meta.ID]

		timeStr := formatSnapshotTime(meta.CreatedAt)

		agentTag := ""
		if meta.Agent != "" {
			agentTag = " " + ui.Cyan("["+meta.Agent+"]")
		}

		wsTag := ""
		if label, ok := headLabels[meta.ID]; ok {
			wsTag = " " + ui.Green("["+label+"]")
		}

		fmt.Printf("%s  %s  %s  (%d files, %s)%s%s\n",
			row.NodeLine,
			ui.Yellow(shortID),
			ui.Dim(timeStr),
			meta.Files,
			formatBytes(meta.Size),
			agentTag,
			wsTag,
		)

		// Message
		if meta.Message != "" {
			graphIndent := computeGraphIndent(row.NodeLine)
			msg := meta.Message
			if len(msg) > 70 {
				msg = msg[:67] + "..."
			}
			fmt.Printf("%s  %s\n", graphIndent, msg)
		}

		if isCurrent {
			graphIndent := computeGraphIndent(row.NodeLine)
			fmt.Printf("%s  %s\n", graphIndent, ui.Dim("(current)"))
		}

		// Print post-lines (fork-out)
		for _, line := range row.PostLines {
			fmt.Println(line)
		}

		fmt.Println()
	}

	if limit > 0 && len(sorted) == limit {
		fmt.Printf("  ... use -n to show more\n")
	}

	return nil
}

// computeGraphIndent returns spaces matching the display width of the graph prefix.
func computeGraphIndent(graphPrefix string) string {
	runes := []rune(graphPrefix)
	return fmt.Sprintf("%*s", len(runes), "")
}
