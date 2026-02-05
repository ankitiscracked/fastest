package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
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

type historySnapshotMeta struct {
	ID                string   `json:"id"`
	ParentSnapshotIDs []string `json:"parent_snapshot_ids"`
	Message           string   `json:"message"`
}

func runEdit(snapshotID, message string) error {
	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	resolved, err := resolveSnapshotIDArg(root, snapshotID)
	if err != nil {
		return err
	}

	metaPath := snapshotMetaPath(root, resolved)
	meta, err := loadSnapshotMetaMap(metaPath)
	if err != nil {
		return err
	}
	meta["message"] = message
	if err := writeSnapshotMetaMap(metaPath, meta); err != nil {
		return fmt.Errorf("failed to update snapshot: %w", err)
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

	resolved, err := resolveSnapshotIDArg(root, snapshotID)
	if err != nil {
		return err
	}

	if resolved == cfg.BaseSnapshotID {
		return fmt.Errorf("cannot drop the base snapshot")
	}

	metas, err := loadHistorySnapshots(root)
	if err != nil {
		return err
	}
	meta := metas[resolved]
	if meta == nil {
		return fmt.Errorf("snapshot not found: %s", resolved)
	}

	if len(meta.ParentSnapshotIDs) > 1 {
		return fmt.Errorf("cannot drop merge snapshot %s", resolved)
	}

	children := buildSnapshotChildren(metas)
	kids := children[resolved]
	if len(kids) > 1 {
		return fmt.Errorf("cannot drop snapshot %s (has multiple children)", resolved)
	}

	parent := ""
	if len(meta.ParentSnapshotIDs) == 1 {
		parent = meta.ParentSnapshotIDs[0]
	}
	if parent == "" {
		return fmt.Errorf("cannot drop root snapshot %s", resolved)
	}

	child := ""
	if len(kids) == 1 {
		child = kids[0]
		if childMeta := metas[child]; childMeta != nil && len(childMeta.ParentSnapshotIDs) > 1 {
			return fmt.Errorf("cannot drop snapshot %s (child %s is a merge snapshot)", resolved, child)
		}
	}

	if child != "" {
		if err := updateSnapshotParents(root, child, []string{parent}); err != nil {
			return err
		}
	}

	if err := os.Remove(snapshotMetaPath(root, resolved)); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove snapshot metadata: %w", err)
	}

	if cfg.CurrentSnapshotID == resolved {
		if child != "" {
			cfg.CurrentSnapshotID = child
		} else {
			cfg.CurrentSnapshotID = parent
		}
		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("failed to update config: %w", err)
		}
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

	from, err := resolveSnapshotIDArg(root, fromArg)
	if err != nil {
		return err
	}
	to, err := resolveSnapshotIDArg(root, toArg)
	if err != nil {
		return err
	}
	if from == to {
		return fmt.Errorf("range must include at least two snapshots")
	}

	metas, err := loadHistorySnapshots(root)
	if err != nil {
		return err
	}
	children := buildSnapshotChildren(metas)
	chain, err := buildLinearChain(metas, children, from, to)
	if err != nil {
		return err
	}

	parent := ""
	if meta := metas[from]; meta != nil && len(meta.ParentSnapshotIDs) == 1 {
		parent = meta.ParentSnapshotIDs[0]
	}

	if err := updateSnapshotParents(root, to, normalizeParents([]string{parent})); err != nil {
		return err
	}
	if strings.TrimSpace(message) != "" {
		if err := updateSnapshotMessage(root, to, message); err != nil {
			return err
		}
	}

	for _, id := range chain {
		if id == to {
			continue
		}
		if err := os.Remove(snapshotMetaPath(root, id)); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("failed to remove snapshot %s: %w", id, err)
		}
	}

	changedConfig := false
	if cfg.BaseSnapshotID == from {
		cfg.BaseSnapshotID = to
		changedConfig = true
	}
	if snapshotInChain(chain, cfg.CurrentSnapshotID) && cfg.CurrentSnapshotID != to {
		cfg.CurrentSnapshotID = to
		changedConfig = true
	}
	if changedConfig {
		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("failed to update config: %w", err)
		}
	}

	fmt.Printf("✓ Squashed %d snapshots into %s\n", len(chain), to)
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

	from, err := resolveSnapshotIDArg(root, fromArg)
	if err != nil {
		return err
	}
	to, err := resolveSnapshotIDArg(root, toArg)
	if err != nil {
		return err
	}
	onto, err := resolveSnapshotIDArg(root, ontoArg)
	if err != nil {
		return err
	}
	if from == to {
		return fmt.Errorf("range must include at least two snapshots")
	}
	if from == cfg.BaseSnapshotID {
		return fmt.Errorf("cannot rebase starting at the base snapshot")
	}

	metas, err := loadHistorySnapshots(root)
	if err != nil {
		return err
	}
	children := buildSnapshotChildren(metas)
	chain, err := buildLinearChain(metas, children, from, to)
	if err != nil {
		return err
	}

	if snapshotInChain(chain, onto) {
		return fmt.Errorf("cannot rebase onto a snapshot within the range")
	}
	if isDescendantOf(metas, onto, chain) {
		return fmt.Errorf("cannot rebase onto a descendant of the range")
	}

	prevParents := []string{}
	if meta := metas[from]; meta != nil {
		prevParents = meta.ParentSnapshotIDs
	}
	prevParent := ""
	if len(prevParents) > 0 {
		prevParent = prevParents[0]
	}
	if prevParent == "" {
		return fmt.Errorf("cannot rebase root snapshot %s", from)
	}
	if !isAncestorOf(metas, onto, prevParent) {
		return fmt.Errorf("cannot rebase onto %s; it is not an ancestor of %s", onto, from)
	}

	if err := updateSnapshotParents(root, from, []string{onto}); err != nil {
		return err
	}

	if prevParent == cfg.BaseSnapshotID {
		cfg.BaseSnapshotID = onto
		if err := config.Save(cfg); err != nil {
			return fmt.Errorf("failed to update config: %w", err)
		}
	}

	fmt.Printf("✓ Rebased %d snapshots onto %s\n", len(chain), onto)
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

func resolveSnapshotIDArg(root, snapshotID string) (string, error) {
	resolved, err := config.ResolveSnapshotIDAt(root, snapshotID)
	if err == nil {
		return resolved, nil
	}
	if strings.Contains(err.Error(), "ambiguous") {
		return "", err
	}

	metaPath := snapshotMetaPath(root, snapshotID)
	if _, statErr := os.Stat(metaPath); statErr == nil {
		return snapshotID, nil
	}
	return "", err
}

func snapshotMetaPath(root, snapshotID string) string {
	return filepath.Join(root, config.ConfigDirName, config.SnapshotsDirName, snapshotID+".meta.json")
}

func loadSnapshotMetaMap(path string) (map[string]any, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var meta map[string]any
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return meta, nil
}

func writeSnapshotMetaMap(path string, meta map[string]any) error {
	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func updateSnapshotParents(root, snapshotID string, parents []string) error {
	metaPath := snapshotMetaPath(root, snapshotID)
	meta, err := loadSnapshotMetaMap(metaPath)
	if err != nil {
		return err
	}
	meta["parent_snapshot_ids"] = normalizeParents(parents)
	if err := writeSnapshotMetaMap(metaPath, meta); err != nil {
		return fmt.Errorf("failed to update snapshot %s: %w", snapshotID, err)
	}
	return nil
}

func updateSnapshotMessage(root, snapshotID, message string) error {
	metaPath := snapshotMetaPath(root, snapshotID)
	meta, err := loadSnapshotMetaMap(metaPath)
	if err != nil {
		return err
	}
	meta["message"] = message
	if err := writeSnapshotMetaMap(metaPath, meta); err != nil {
		return fmt.Errorf("failed to update snapshot %s: %w", snapshotID, err)
	}
	return nil
}

func normalizeParents(parents []string) []string {
	seen := make(map[string]struct{}, len(parents))
	out := make([]string, 0, len(parents))
	for _, p := range parents {
		if p == "" {
			continue
		}
		if _, ok := seen[p]; ok {
			continue
		}
		seen[p] = struct{}{}
		out = append(out, p)
	}
	return out
}

func loadHistorySnapshots(root string) (map[string]*historySnapshotMeta, error) {
	snapshotsDir := filepath.Join(root, config.ConfigDirName, config.SnapshotsDirName)
	entries, err := os.ReadDir(snapshotsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]*historySnapshotMeta{}, nil
		}
		return nil, err
	}

	metas := make(map[string]*historySnapshotMeta)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		path := filepath.Join(snapshotsDir, name)
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var meta historySnapshotMeta
		if err := json.Unmarshal(data, &meta); err != nil {
			continue
		}
		if meta.ID == "" {
			meta.ID = strings.TrimSuffix(name, ".meta.json")
		}
		meta.ParentSnapshotIDs = normalizeParents(meta.ParentSnapshotIDs)
		metas[meta.ID] = &meta
	}

	return metas, nil
}

func buildSnapshotChildren(metas map[string]*historySnapshotMeta) map[string][]string {
	children := make(map[string][]string, len(metas))
	for id, meta := range metas {
		if meta == nil {
			continue
		}
		for _, parent := range meta.ParentSnapshotIDs {
			children[parent] = append(children[parent], id)
		}
		if _, ok := children[id]; !ok {
			children[id] = nil
		}
	}
	return children
}

func buildLinearChain(metas map[string]*historySnapshotMeta, children map[string][]string, from, to string) ([]string, error) {
	chain := []string{to}
	current := to
	for current != from {
		meta := metas[current]
		if meta == nil {
			return nil, fmt.Errorf("snapshot not found: %s", current)
		}
		if len(meta.ParentSnapshotIDs) != 1 {
			return nil, fmt.Errorf("snapshot %s is not linear", current)
		}
		parent := meta.ParentSnapshotIDs[0]
		if parent == "" {
			return nil, fmt.Errorf("snapshot %s has no parent", current)
		}
		chain = append(chain, parent)
		current = parent
	}

	// reverse chain to from -> to
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}

	for i, id := range chain {
		meta := metas[id]
		if meta == nil {
			return nil, fmt.Errorf("snapshot not found: %s", id)
		}
		if len(meta.ParentSnapshotIDs) > 1 {
			return nil, fmt.Errorf("snapshot %s is a merge snapshot", id)
		}
		kids := children[id]
		if i < len(chain)-1 {
			if len(kids) != 1 || kids[0] != chain[i+1] {
				return nil, fmt.Errorf("snapshot %s is not linear", id)
			}
		} else if len(kids) > 1 {
			return nil, fmt.Errorf("snapshot %s has multiple children", id)
		} else if len(kids) == 1 {
			childMeta := metas[kids[0]]
			if childMeta != nil && len(childMeta.ParentSnapshotIDs) > 1 {
				return nil, fmt.Errorf("snapshot %s has a merge child %s", id, kids[0])
			}
		}
	}

	return chain, nil
}

func snapshotInChain(chain []string, id string) bool {
	for _, item := range chain {
		if item == id {
			return true
		}
	}
	return false
}

func isDescendantOf(metas map[string]*historySnapshotMeta, candidate string, chain []string) bool {
	chainSet := make(map[string]struct{}, len(chain))
	for _, id := range chain {
		chainSet[id] = struct{}{}
	}

	current := candidate
	for current != "" {
		if _, ok := chainSet[current]; ok {
			return true
		}
		meta := metas[current]
		if meta == nil || len(meta.ParentSnapshotIDs) == 0 {
			break
		}
		if len(meta.ParentSnapshotIDs) > 1 {
			break
		}
		current = meta.ParentSnapshotIDs[0]
	}
	return false
}

func isAncestorOf(metas map[string]*historySnapshotMeta, ancestor, start string) bool {
	if ancestor == "" || start == "" {
		return false
	}
	if ancestor == start {
		return true
	}

	seen := make(map[string]struct{})
	queue := []string{start}
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if _, ok := seen[current]; ok {
			continue
		}
		seen[current] = struct{}{}
		meta := metas[current]
		if meta == nil {
			continue
		}
		for _, parent := range meta.ParentSnapshotIDs {
			if parent == "" {
				continue
			}
			if parent == ancestor {
				return true
			}
			if _, ok := seen[parent]; !ok {
				queue = append(queue, parent)
			}
		}
	}
	return false
}
