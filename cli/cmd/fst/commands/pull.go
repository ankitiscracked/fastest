package commands

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/backend"
	"github.com/ankitiscracked/fastest/cli/internal/workspace"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newPullCmd()) })
}

func newPullCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "pull",
		Short: "Pull latest changes from the backend",
		Long: `Pull the latest changes from the configured backend.

Requires a backend to be configured (see 'fst backend set').`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runPull()
		},
	}

	return cmd
}

func runPull() error {
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

	if err := b.Pull(projectRoot); err == backend.ErrNoRemote {
		fmt.Println("Backend has no remote to pull from.")
		return nil
	} else {
		return err
	}
}
