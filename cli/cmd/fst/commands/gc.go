package commands

import (
	"errors"
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newGCCmd()) })
}

func newGCCmd() *cobra.Command {
	var dryRun bool

	cmd := &cobra.Command{
		Use:   "gc",
		Short: "Prune unreachable snapshots from the shared store",
		Long: `Garbage-collect unreachable snapshots and manifests from the project's
shared snapshot store.

A snapshot is reachable if it is an ancestor of any workspace's current or
base snapshot. Unreachable snapshots are leftovers from history rewriting
(drop, squash, rebase) and can be safely removed.

Must be run from within a project folder (directory containing fst.json).`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGC(dryRun)
		},
	}

	cmd.Flags().BoolVar(&dryRun, "dry-run", false, "Show what would be deleted without deleting")

	return cmd
}

func runGC(dryRun bool) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	projectRoot, _, err := config.FindParentRootFrom(cwd)
	if err != nil {
		if errors.Is(err, config.ErrParentNotFound) {
			return fmt.Errorf("not in a project folder - run from a directory containing fst.json")
		}
		return err
	}

	s := store.OpenAt(projectRoot)
	result, err := s.GC(store.GCOpts{DryRun: dryRun})
	if err != nil {
		return err
	}

	if len(result.UnreachableSnapshots) == 0 && len(result.OrphanedBlobs) == 0 {
		fmt.Println("No unreachable snapshots or orphaned blobs found - nothing to collect.")
		return nil
	}

	if dryRun {
		if len(result.UnreachableSnapshots) > 0 {
			fmt.Printf("Would delete %d unreachable snapshot(s):\n", len(result.UnreachableSnapshots))
			for _, id := range result.UnreachableSnapshots {
				fmt.Printf("  %s\n", id)
			}
		}
		if len(result.OrphanedManifests) > 0 {
			fmt.Printf("Would delete %d orphaned manifest(s):\n", len(result.OrphanedManifests))
			for _, hash := range result.OrphanedManifests {
				fmt.Printf("  %s\n", hash)
			}
		}
		if len(result.OrphanedBlobs) > 0 {
			fmt.Printf("Would delete %d orphaned blob(s).\n", len(result.OrphanedBlobs))
		}
		return nil
	}

	fmt.Printf("Deleted %d unreachable snapshot(s)", result.DeletedSnapshots)
	if result.DeletedManifests > 0 {
		fmt.Printf(", %d orphaned manifest(s)", result.DeletedManifests)
	}
	if result.DeletedBlobs > 0 {
		fmt.Printf(", %d orphaned blob(s)", result.DeletedBlobs)
	}
	fmt.Println(".")

	return nil
}
