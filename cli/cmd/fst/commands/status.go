package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newStatusCmd()) })
}

func newStatusCmd() *cobra.Command {
	var jsonOutput bool

	cmd := &cobra.Command{
		Use:   "status",
		Short: "Show workspace status",
		Long: `Show the current workspace status.

Without flags, shows detailed status of the current workspace:
- Workspace name and path
- Base snapshot info
- Upstream workspace (if any)
- Current drift (files changed since base)

Examples:
  fst status          # Current workspace status`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runStatus(jsonOutput)
		},
	}

	cmd.Flags().BoolVar(&jsonOutput, "json", false, "Output in JSON format")

	return cmd
}

func runStatus(jsonOutput bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Use workspace's current snapshot, not project-wide latest
	latestSnapshotID := cfg.CurrentSnapshotID
	latestSnapshotTime := ""
	if latestSnapshotID != "" {
		snapshotsDir, _ := config.GetSnapshotsDir()
		metaPath := filepath.Join(snapshotsDir, latestSnapshotID+".meta.json")
		if info, err := os.Stat(metaPath); err == nil {
			latestSnapshotTime = formatTimeAgo(info.ModTime())
		}
	}

	// Get changes since current snapshot
	var driftReport *drift.Report
	driftReport, err = drift.ComputeFromLatestSnapshot(root)
	if err != nil {
		// Non-fatal, just won't show changes
		driftReport = nil
	}

	// Get upstream info
	upstreamID, upstreamName, _ := drift.GetUpstreamWorkspace(root)

	// Get base snapshot time
	var baseTime string
	if cfg.BaseSnapshotID != "" {
		snapshotsDir, _ := config.GetSnapshotsDir()
		metaPath := filepath.Join(snapshotsDir, cfg.BaseSnapshotID+".meta.json")
		if info, err := os.Stat(metaPath); err == nil {
			baseTime = formatTimeAgo(info.ModTime())
		}
	}

	if jsonOutput {
		return printStatusJSON(cfg, root, driftReport, upstreamName, baseTime, latestSnapshotID, latestSnapshotTime)
	}

	return printStatusHuman(cfg, root, driftReport, upstreamID, upstreamName, baseTime, latestSnapshotID, latestSnapshotTime)
}

func printStatusHuman(cfg *config.ProjectConfig, root string, driftReport *drift.Report, upstreamID, upstreamName, baseTime, latestSnapshotID, latestSnapshotTime string) error {
	fmt.Printf("Workspace: \033[1m%s\033[0m\n", cfg.WorkspaceName)
	fmt.Printf("ID:        %s\n", cfg.WorkspaceID)
	fmt.Printf("Path:      %s\n", root)
	if cfg.Mode != "" {
		fmt.Printf("Mode:      %s\n", cfg.Mode)
	}
	fmt.Println()

	snapshotIDs := make([]string, 0, 2)
	if latestSnapshotID != "" {
		snapshotIDs = append(snapshotIDs, latestSnapshotID)
	}
	if cfg.BaseSnapshotID != "" {
		snapshotIDs = append(snapshotIDs, cfg.BaseSnapshotID)
	}
	shortSnapshotIDs := shortenIDs(snapshotIDs, 12)

	if latestSnapshotID != "" {
		fmt.Printf("Latest:    %s", shortSnapshotIDs[latestSnapshotID])
		if latestSnapshotTime != "" {
			fmt.Printf(" (%s)", latestSnapshotTime)
		}
		fmt.Println()
	}

	// Base snapshot
	if cfg.BaseSnapshotID != "" {
		fmt.Printf("Base:      %s", shortSnapshotIDs[cfg.BaseSnapshotID])
		if baseTime != "" {
			fmt.Printf(" (%s)", baseTime)
		}
		fmt.Println()
	} else {
		fmt.Println("Base:      (none)")
	}

	// Upstream
	if upstreamName != "" {
		fmt.Printf("Upstream:  %s\n", upstreamName)
	}

	fmt.Println()

	// Changes
	if driftReport == nil {
		fmt.Println("Changes:   (unable to compute)")
	} else if !driftReport.HasChanges() {
		fmt.Println("\033[32m✓ No changes since last snapshot\033[0m")
	} else {
		added := len(driftReport.FilesAdded)
		modified := len(driftReport.FilesModified)
		deleted := len(driftReport.FilesDeleted)
		total := added + modified + deleted

		fmt.Printf("Changes:   \033[33m%d files changed\033[0m since last snapshot (+%d ~%d -%d)\n",
			total, added, modified, deleted)
	}

	return nil
}

func printStatusJSON(cfg *config.ProjectConfig, root string, driftReport *drift.Report, upstreamName, baseTime, latestSnapshotID, latestSnapshotTime string) error {
	fmt.Println("{")
	fmt.Printf("  \"workspace_name\": %q,\n", cfg.WorkspaceName)
	fmt.Printf("  \"workspace_id\": %q,\n", cfg.WorkspaceID)
	fmt.Printf("  \"path\": %q,\n", root)
	fmt.Printf("  \"mode\": %q,\n", cfg.Mode)
	fmt.Printf("  \"latest_snapshot_id\": %q,\n", latestSnapshotID)
	fmt.Printf("  \"latest_snapshot_time\": %q,\n", latestSnapshotTime)
	fmt.Printf("  \"base_snapshot_id\": %q,\n", cfg.BaseSnapshotID)
	if upstreamName != "" {
		fmt.Printf("  \"upstream\": %q,\n", upstreamName)
	}

	if driftReport != nil {
		fmt.Printf("  \"files_added\": %d,\n", len(driftReport.FilesAdded))
		fmt.Printf("  \"files_modified\": %d,\n", len(driftReport.FilesModified))
		fmt.Printf("  \"files_deleted\": %d,\n", len(driftReport.FilesDeleted))
		fmt.Printf("  \"since\": %q\n", "last_snapshot")
	} else {
		fmt.Printf("  \"files_added\": 0,\n")
		fmt.Printf("  \"files_modified\": 0,\n")
		fmt.Printf("  \"files_deleted\": 0,\n")
		fmt.Printf("  \"since\": %q\n", "last_snapshot")
	}
	fmt.Println("}")
	return nil
}

func formatTimeAgo(t time.Time) string {
	diff := time.Since(t)

	switch {
	case diff < time.Minute:
		return "just now"
	case diff < time.Hour:
		mins := int(diff.Minutes())
		if mins == 1 {
			return "1 min ago"
		}
		return fmt.Sprintf("%d mins ago", mins)
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
		return t.Format("Jan 2")
	}
}
