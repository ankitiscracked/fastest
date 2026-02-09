package commands

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

func init() {
	register(func(root *cobra.Command) {
		root.AddCommand(newEditCmd())
		root.AddCommand(newDropCmd())
		root.AddCommand(newSquashCmd())
		root.AddCommand(newRebaseCmd())
	})
}

func newEditCmd() *cobra.Command {
	var message string
	cmd := &cobra.Command{
		Use:     "edit <snapshot>",
		Aliases: []string{"amend"},
		Short:   "Edit snapshot message",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(message) == "" {
				return fmt.Errorf("message is required")
			}
			return runEdit(args[0], message)
		},
	}
	cmd.Flags().StringVarP(&message, "message", "m", "", "New snapshot message")
	return cmd
}

func newDropCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "drop <snapshot>",
		Short: "Drop a snapshot from history",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runDrop(args[0])
		},
	}
	return cmd
}

func newSquashCmd() *cobra.Command {
	var message string
	cmd := &cobra.Command{
		Use:   "squash <from>..<to>",
		Short: "Squash a linear range of snapshots into one",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			from, to, err := parseSnapshotRange(args[0])
			if err != nil {
				return err
			}
			return runSquash(from, to, message)
		},
	}
	cmd.Flags().StringVarP(&message, "message", "m", "", "New message for the squashed snapshot")
	return cmd
}

func newRebaseCmd() *cobra.Command {
	var onto string
	cmd := &cobra.Command{
		Use:   "rebase <from>..<to> --onto <snapshot>",
		Short: "Rebase a linear range onto a new parent snapshot",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if strings.TrimSpace(onto) == "" {
				return fmt.Errorf("--onto is required")
			}
			from, to, err := parseSnapshotRange(args[0])
			if err != nil {
				return err
			}
			return runRebase(from, to, onto)
		},
	}
	cmd.Flags().StringVar(&onto, "onto", "", "New parent snapshot for the range")
	return cmd
}

func runEdit(snapshotID, message string) error {
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	s := store.OpenFromWorkspace(root)
	resolved, err := s.ResolveSnapshotID(snapshotID)
	if err != nil {
		return err
	}

	if err := s.EditSnapshotMessage(resolved, message); err != nil {
		return err
	}

	fmt.Printf("✓ Updated snapshot %s\n", resolved)
	return nil
}

func runDrop(snapshotID string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	s := store.OpenFromWorkspace(root)
	resolved, err := s.ResolveSnapshotID(snapshotID)
	if err != nil {
		return err
	}

	if resolved == cfg.BaseSnapshotID {
		return fmt.Errorf("cannot drop the base snapshot")
	}

	meta, err := s.LoadSnapshotMeta(resolved)
	if err != nil {
		return fmt.Errorf("snapshot not found: %s", resolved)
	}

	if len(meta.ParentSnapshotIDs) > 1 {
		return fmt.Errorf("cannot drop merge snapshot %s", resolved)
	}

	parent := ""
	if len(meta.ParentSnapshotIDs) == 1 {
		parent = meta.ParentSnapshotIDs[0]
	}
	if parent == "" {
		return fmt.Errorf("cannot drop root snapshot %s", resolved)
	}

	wsChain, err := s.BuildWorkspaceChain(cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to build workspace history: %w", err)
	}

	dropIdx := -1
	for i, id := range wsChain {
		if id == resolved {
			dropIdx = i
			break
		}
	}
	if dropIdx == -1 {
		return fmt.Errorf("snapshot %s is not in this workspace's history", resolved)
	}

	if dropIdx == len(wsChain)-1 {
		cfg.CurrentSnapshotID = parent
	} else {
		continuationChain := wsChain[dropIdx+1:]
		result, err := s.RewriteChain(continuationChain, parent, nil)
		if err != nil {
			return fmt.Errorf("failed to rewrite chain: %w", err)
		}
		cfg.CurrentSnapshotID = result.IDMap[wsChain[len(wsChain)-1]]
	}

	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	fmt.Printf("✓ Dropped snapshot %s\n", resolved)
	return nil
}

func runSquash(fromArg, toArg, message string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	s := store.OpenFromWorkspace(root)
	from, err := s.ResolveSnapshotID(fromArg)
	if err != nil {
		return err
	}
	to, err := s.ResolveSnapshotID(toArg)
	if err != nil {
		return err
	}
	if from == to {
		return fmt.Errorf("range must include at least two snapshots")
	}

	wsChain, err := s.BuildWorkspaceChain(cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to build workspace history: %w", err)
	}

	fromIdx, toIdx := -1, -1
	for i, id := range wsChain {
		if id == from {
			fromIdx = i
		}
		if id == to {
			toIdx = i
		}
	}
	if fromIdx == -1 {
		return fmt.Errorf("snapshot %s not in workspace history", from)
	}
	if toIdx == -1 {
		return fmt.Errorf("snapshot %s not in workspace history", to)
	}
	if fromIdx >= toIdx {
		return fmt.Errorf("from must come before to in history")
	}

	// Validate linear (no merge snapshots)
	for i := fromIdx; i <= toIdx; i++ {
		m, err := s.LoadSnapshotMeta(wsChain[i])
		if err == nil && len(m.ParentSnapshotIDs) > 1 {
			return fmt.Errorf("snapshot %s is a merge snapshot", wsChain[i])
		}
	}

	fromMeta, err := s.LoadSnapshotMeta(from)
	if err != nil {
		return fmt.Errorf("snapshot not found: %s", from)
	}
	squashParent := ""
	if len(fromMeta.ParentSnapshotIDs) == 1 {
		squashParent = fromMeta.ParentSnapshotIDs[0]
	}

	rewriteChain := wsChain[toIdx:]
	messageOverrides := map[string]string{}
	if strings.TrimSpace(message) != "" {
		messageOverrides[to] = message
	}

	result, err := s.RewriteChain(rewriteChain, squashParent, messageOverrides)
	if err != nil {
		return fmt.Errorf("failed to rewrite chain: %w", err)
	}

	cfg.CurrentSnapshotID = result.IDMap[wsChain[len(wsChain)-1]]
	if cfg.BaseSnapshotID == from {
		cfg.BaseSnapshotID = result.IDMap[to]
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	squashCount := toIdx - fromIdx + 1
	fmt.Printf("✓ Squashed %d snapshots into %s\n", squashCount, result.IDMap[to])
	return nil
}

func runRebase(fromArg, toArg, ontoArg string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	s := store.OpenFromWorkspace(root)
	from, err := s.ResolveSnapshotID(fromArg)
	if err != nil {
		return err
	}
	to, err := s.ResolveSnapshotID(toArg)
	if err != nil {
		return err
	}
	onto, err := s.ResolveSnapshotID(ontoArg)
	if err != nil {
		return err
	}
	if from == to {
		return fmt.Errorf("range must include at least two snapshots")
	}
	if from == cfg.BaseSnapshotID {
		return fmt.Errorf("cannot rebase starting at the base snapshot")
	}

	wsChain, err := s.BuildWorkspaceChain(cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to build workspace history: %w", err)
	}

	fromIdx, toIdx := -1, -1
	for i, id := range wsChain {
		if id == from {
			fromIdx = i
		}
		if id == to {
			toIdx = i
		}
	}
	if fromIdx == -1 {
		return fmt.Errorf("snapshot %s not in workspace history", from)
	}
	if toIdx == -1 {
		return fmt.Errorf("snapshot %s not in workspace history", to)
	}
	if fromIdx >= toIdx {
		return fmt.Errorf("from must come before to in history")
	}

	rangeChain := wsChain[fromIdx : toIdx+1]
	for _, id := range rangeChain {
		if id == onto {
			return fmt.Errorf("cannot rebase onto a snapshot within the range")
		}
	}
	if s.IsDescendantOf(onto, rangeChain) {
		return fmt.Errorf("cannot rebase onto a descendant of the range")
	}

	if !s.SnapshotExists(onto) {
		return fmt.Errorf("snapshot not found: %s", onto)
	}

	fromMeta, err := s.LoadSnapshotMeta(from)
	if err != nil {
		return fmt.Errorf("snapshot not found: %s", from)
	}
	prevParent := ""
	if len(fromMeta.ParentSnapshotIDs) > 0 {
		prevParent = fromMeta.ParentSnapshotIDs[0]
	}
	if prevParent == "" {
		return fmt.Errorf("cannot rebase root snapshot %s", from)
	}
	if !s.IsAncestorOf(onto, prevParent) {
		return fmt.Errorf("cannot rebase onto %s; it is not an ancestor of %s", onto, from)
	}

	rewriteChain := wsChain[fromIdx:]
	result, err := s.RewriteChain(rewriteChain, onto, nil)
	if err != nil {
		return fmt.Errorf("failed to rewrite chain: %w", err)
	}

	cfg.CurrentSnapshotID = result.IDMap[wsChain[len(wsChain)-1]]
	if prevParent == cfg.BaseSnapshotID {
		cfg.BaseSnapshotID = onto
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	fmt.Printf("✓ Rebased %d snapshots onto %s\n", len(rangeChain), onto)
	return nil
}

func parseSnapshotRange(arg string) (string, string, error) {
	parts := strings.SplitN(arg, "..", 2)
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid range %q (expected <from>..<to>)", arg)
	}
	if parts[0] == "" || parts[1] == "" {
		return "", "", fmt.Errorf("invalid range %q (expected <from>..<to>)", arg)
	}
	return parts[0], parts[1], nil
}
