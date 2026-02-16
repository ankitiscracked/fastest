package commands

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/backend"
	"github.com/ankitiscracked/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newSyncCmd()) })
}

func newSyncCmd() *cobra.Command {
	var manual bool
	var theirs bool
	var ours bool

	cmd := &cobra.Command{
		Use:   "sync",
		Short: "Sync local and remote for this workspace",
		Long: `Sync local and remote changes for the current workspace.

Requires a backend to be configured (see 'fst backend set').
If the local and remote heads diverged, this performs a three-way merge
and creates a new snapshot on success.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			modeCount := 0
			if manual {
				modeCount++
			}
			if theirs {
				modeCount++
			}
			if ours {
				modeCount++
			}
			if modeCount > 1 {
				return fmt.Errorf("only one of --manual, --theirs, --ours can be specified")
			}

			mode := ConflictModeAgent // default
			if manual {
				mode = ConflictModeManual
			} else if theirs {
				mode = ConflictModeTheirs
			} else if ours {
				mode = ConflictModeOurs
			}

			return runSync(mode)
		},
	}

	cmd.Flags().BoolVar(&manual, "manual", false, "Create conflict markers for manual resolution")
	cmd.Flags().BoolVar(&theirs, "theirs", false, "Take remote version for conflicts")
	cmd.Flags().BoolVar(&ours, "ours", false, "Keep local version for conflicts")

	return cmd
}

func runSync(mode ConflictMode) error {
	projectRoot, parentCfg, err := findProjectRootAndConfig()
	if err != nil {
		return err
	}

	b := backend.FromConfig(parentCfg.Backend, RunExportGitAt)
	if b == nil {
		return fmt.Errorf("no backend configured - run 'fst backend set' first")
	}

	lock, err := workspace.AcquireBackendLock(projectRoot)
	if err != nil {
		return err
	}
	defer lock.Release()

	opts := &backend.SyncOptions{
		OnDivergence: buildOnDivergence(mode),
	}
	return b.Sync(projectRoot, opts)
}

func filterMergeActions(actions *mergeActions, files []string) *mergeActions {
	if len(files) == 0 {
		return actions
	}

	filesSet := make(map[string]bool, len(files))
	for _, f := range files {
		filesSet[f] = true
	}

	filtered := &mergeActions{}
	for _, a := range actions.toApply {
		if filesSet[a.path] {
			filtered.toApply = append(filtered.toApply, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}
	for _, a := range actions.conflicts {
		if filesSet[a.path] {
			filtered.conflicts = append(filtered.conflicts, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}
	for _, a := range actions.inSync {
		if filesSet[a.path] {
			filtered.inSync = append(filtered.inSync, a)
		} else {
			filtered.skipped = append(filtered.skipped, mergeAction{path: a.path, actionType: "skip"})
		}
	}

	return filtered
}

func buildSyncConflictContext(conflicts []mergeAction) string {
	lines := []string{"Conflicting files:"}
	for _, c := range conflicts {
		lines = append(lines, "- "+c.path)
	}
	return strings.Join(lines, "\n")
}
