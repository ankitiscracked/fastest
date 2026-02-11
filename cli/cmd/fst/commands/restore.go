package commands

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/ui"
	"github.com/anthropics/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newRestoreCmd()) })
}

func newRestoreCmd() *cobra.Command {
	var toSnapshot string
	var toBase bool
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "restore [files...]",
		Short: "Restore files from a snapshot",
		Long: `Restore files from a previous snapshot.

By default, restores the entire workspace from the last snapshot (most recent save point).
Use --to to specify a different snapshot.
Use --to-base to restore to the base/base point snapshot.

Examples:
  fst restore src/main.py           # Restore single file from last snapshot
  fst restore src/                  # Restore all files in directory
  fst restore                       # Restore entire workspace to last snapshot
  fst restore --to snap-abc         # Restore to specific snapshot
  fst restore --to-base             # Restore to base point
  fst restore --dry-run             # Show what would be restored`,
		RunE: func(cmd *cobra.Command, args []string) error {
			if toSnapshot != "" && toBase {
				return fmt.Errorf("cannot use both --to and --to-base")
			}
			return runRestore(args, toSnapshot, toBase, dryRun)
		},
	}

	cmd.Flags().StringVar(&toSnapshot, "to", "", "Target snapshot ID (default: last snapshot)")
	cmd.Flags().BoolVar(&toBase, "to-base", false, "Restore to base/base point snapshot")
	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be restored without making changes")

	return cmd
}

func runRestore(files []string, toSnapshot string, toBase bool, dryRun bool) error {
	ws, err := workspace.Open()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	defer ws.Close()

	result, err := ws.Restore(workspace.RestoreOpts{
		SnapshotID: toSnapshot,
		ToBase:     toBase,
		Files:      files,
		DryRun:     dryRun,
	})

	if result != nil && len(result.MissingBlobs) > 0 {
		fmt.Printf("Error: Missing cached blobs for %d files:\n", len(result.MissingBlobs))
		for _, f := range result.MissingBlobs {
			fmt.Printf("  %s\n", f)
		}
		fmt.Println()
		fmt.Println("These files cannot be restored. The snapshot may have been")
		fmt.Println("created before blob caching was enabled.")
		return err
	}

	if result != nil && len(result.Actions) == 0 {
		fmt.Println("Nothing to restore.")
		return nil
	}

	if result != nil {
		fmt.Printf("Restore to: %s\n", result.TargetSnapshotID)
		fmt.Println()
		printRestoreActions(result)
	}

	if dryRun {
		fmt.Println("(dry run - no changes made)")
		return nil
	}

	if err != nil {
		return err
	}

	fmt.Printf("✓ Restored %d files", result.Restored)
	if result.Deleted > 0 {
		fmt.Printf(", deleted %d files", result.Deleted)
	}
	fmt.Println()

	return nil
}

func printRestoreActions(result *workspace.RestoreResult) {
	var restoreActions, deleteActions []workspace.RestoreAction
	for _, a := range result.Actions {
		switch a.Action {
		case "restore":
			restoreActions = append(restoreActions, a)
		case "delete":
			deleteActions = append(deleteActions, a)
		}
	}

	if len(restoreActions) > 0 {
		fmt.Printf("Entries to restore (%d):\n", len(restoreActions))
		for _, a := range restoreActions {
			status := ""
			if a.Status != "" {
				status = " (" + a.Status + ")"
			}
			fmt.Printf("  %s%s\n", ui.Green("↩ "+a.Path), status)
		}
		fmt.Println()
	}

	if len(deleteActions) > 0 {
		fmt.Printf("Files to delete (%d):\n", len(deleteActions))
		for _, a := range deleteActions {
			fmt.Printf("  %s\n", ui.Red("✗ "+a.Path))
		}
		fmt.Println()
	}
}
