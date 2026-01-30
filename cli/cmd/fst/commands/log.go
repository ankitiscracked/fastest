package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newLogCmd()) })
}

func newLogCmd() *cobra.Command {
	var limit int
	var showAll bool

	cmd := &cobra.Command{
		Use:   "log",
		Short: "Show snapshot history",
		Long: `Display the history of snapshots for the current workspace.

Shows snapshots in reverse chronological order, starting from the current base.
Each entry shows the snapshot ID, timestamp, file count, and description.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runLog(limit, showAll)
		},
	}

	cmd.Flags().IntVarP(&limit, "limit", "n", 10, "Maximum number of snapshots to show")
	cmd.Flags().BoolVarP(&showAll, "all", "a", false, "Show all snapshots, not just the current chain")

	return cmd
}

// SnapshotMeta represents snapshot metadata
type SnapshotMeta struct {
	ID               string `json:"id"`
	WorkspaceID      string `json:"workspace_id"`
	WorkspaceName    string `json:"workspace_name"`
	ManifestHash     string `json:"manifest_hash"`
	ParentSnapshotID string `json:"parent_snapshot_id"`
	Message          string `json:"message"`
	Agent            string `json:"agent"`
	CreatedAt        string `json:"created_at"`
	Files            int    `json:"files"`
	Size             int64  `json:"size"`
}

func runLog(limit int, showAll bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory - run 'fst init' first")
	}

	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return fmt.Errorf("failed to get snapshots directory: %w", err)
	}

	// Load all snapshot metadata
	snapshots, err := loadAllSnapshots(snapshotsDir)
	if err != nil {
		return fmt.Errorf("failed to load snapshots: %w", err)
	}

	if len(snapshots) == 0 {
		fmt.Println("No snapshots found.")
		fmt.Println()
		fmt.Println("Create one with: fst snapshot --set-base")
		return nil
	}

	var toShow []*SnapshotMeta

	if showAll {
		// Show all snapshots sorted by time
		toShow = snapshots
		sort.Slice(toShow, func(i, j int) bool {
			return toShow[i].CreatedAt > toShow[j].CreatedAt
		})
	} else {
		// Walk the chain from current base
		toShow = walkSnapshotChain(snapshots, cfg.CurrentSnapshotID)
	}

	if len(toShow) == 0 {
		fmt.Println("No snapshots in current chain.")
		fmt.Println()
		fmt.Printf("Current snapshot: %s\n", cfg.CurrentSnapshotID)
		fmt.Println("Use --all to see all snapshots.")
		return nil
	}

	// Apply limit
	if limit > 0 && len(toShow) > limit {
		toShow = toShow[:limit]
	}

	// Display header
	if showAll {
		fmt.Printf("All snapshots (%d):\n", len(snapshots))
	} else {
		fmt.Printf("Snapshot history (from %s):\n", cfg.WorkspaceName)
	}
	fmt.Println()

	// Display snapshots
	for i, snap := range toShow {
		displaySnapshot(snap, i == 0 && snap.ID == cfg.CurrentSnapshotID)
	}

	// Show if there are more
	if limit > 0 && len(toShow) == limit {
		fmt.Printf("  ... use -n to show more\n")
	}

	return nil
}

func loadAllSnapshots(manifestDir string) ([]*SnapshotMeta, error) {
	var snapshots []*SnapshotMeta

	entries, err := os.ReadDir(manifestDir)
	if err != nil {
		if os.IsNotExist(err) {
			return snapshots, nil
		}
		return nil, err
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}

		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}

		path := filepath.Join(manifestDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}

		var meta SnapshotMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}

		snapshots = append(snapshots, &meta)
	}

	return snapshots, nil
}

func walkSnapshotChain(snapshots []*SnapshotMeta, startID string) []*SnapshotMeta {
	// Build lookup map
	byID := make(map[string]*SnapshotMeta)
	for _, s := range snapshots {
		byID[s.ID] = s
	}

	var chain []*SnapshotMeta
	currentID := startID

	// Walk backwards through parents
	for currentID != "" {
		snap, exists := byID[currentID]
		if !exists {
			break
		}
		chain = append(chain, snap)
		currentID = snap.ParentSnapshotID
	}

	return chain
}

func displaySnapshot(snap *SnapshotMeta, isCurrent bool) {
	// Parse and format time
	timeStr := formatSnapshotTime(snap.CreatedAt)

	// Current indicator
	indicator := " "
	if isCurrent {
		indicator = "*"
	}

	// Snapshot ID (shortened)
	shortID := snap.ID
	if len(shortID) > 20 {
		shortID = shortID[:20]
	}

	// Agent tag (if present)
	agentTag := ""
	if snap.Agent != "" {
		agentTag = fmt.Sprintf(" \033[36m[%s]\033[0m", snap.Agent)
	}

	// Format: * snap-abc123  2 hours ago  (5 files, 1.2 KB) [claude]
	fmt.Printf("%s \033[33m%s\033[0m  \033[90m%s\033[0m  (%d files, %s)%s\n",
		indicator,
		shortID,
		timeStr,
		snap.Files,
		formatBytes(snap.Size),
		agentTag,
	)

	// Message (indented)
	if snap.Message != "" {
		// Wrap long messages
		msg := snap.Message
		if len(msg) > 70 {
			msg = msg[:67] + "..."
		}
		fmt.Printf("    %s\n", msg)
	}

	fmt.Println()
}

func formatSnapshotTime(timeStr string) string {
	t, err := time.Parse(time.RFC3339, timeStr)
	if err != nil {
		return timeStr
	}

	now := time.Now()
	diff := now.Sub(t)

	switch {
	case diff < time.Minute:
		return "just now"
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins == 1 {
			return "1 minute ago"
		}
		return fmt.Sprintf("%d minutes ago", mins)
	case diff < 24*time.Hour:
		hours := int(diff.Hours())
		if hours == 1 {
			return "1 hour ago"
		}
		return fmt.Sprintf("%d hours ago", hours)
	case diff < 7*24*time.Hour:
		days := int(diff.Hours() / 24)
		if days == 1 {
			return "yesterday"
		}
		return fmt.Sprintf("%d days ago", days)
	default:
		return t.Format("Jan 2, 2006")
	}
}

func formatBytes(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB"}
	i := 0
	fb := float64(bytes)
	for fb >= k && i < len(sizes)-1 {
		fb /= k
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", bytes, sizes[i])
	}
	return fmt.Sprintf("%.1f %s", fb, sizes[i])
}
