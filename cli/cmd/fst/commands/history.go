package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

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

	parent := ""
	if len(meta.ParentSnapshotIDs) == 1 {
		parent = meta.ParentSnapshotIDs[0]
	}
	if parent == "" {
		return fmt.Errorf("cannot drop root snapshot %s", resolved)
	}

	// Build workspace chain from base to HEAD
	wsChain, err := buildWorkspaceChain(metas, cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
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
		// Dropping HEAD - just move HEAD to parent
		cfg.CurrentSnapshotID = parent
	} else {
		// Rewrite chain from the snapshot after the dropped one to HEAD
		continuationChain := wsChain[dropIdx+1:]
		idMap, err := rewriteChainFrom(root, continuationChain, parent, nil)
		if err != nil {
			return fmt.Errorf("failed to rewrite chain: %w", err)
		}
		cfg.CurrentSnapshotID = idMap[wsChain[len(wsChain)-1]]
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

	// Build workspace chain and find positions
	wsChain, err := buildWorkspaceChain(metas, cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
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

	// Validate the range is linear (no merge snapshots)
	for i := fromIdx; i <= toIdx; i++ {
		m := metas[wsChain[i]]
		if m != nil && len(m.ParentSnapshotIDs) > 1 {
			return fmt.Errorf("snapshot %s is a merge snapshot", wsChain[i])
		}
	}

	// Find from's parent (the new parent for the squashed result)
	fromMeta := metas[from]
	squashParent := ""
	if fromMeta != nil && len(fromMeta.ParentSnapshotIDs) == 1 {
		squashParent = fromMeta.ParentSnapshotIDs[0]
	}

	// Build rewrite chain: [to, ..., HEAD]
	// The `to` snapshot gets squashParent as its parent, collapsing from..to into one
	rewriteChain := wsChain[toIdx:]
	messageOverrides := map[string]string{}
	if strings.TrimSpace(message) != "" {
		messageOverrides[to] = message
	}

	idMap, err := rewriteChainFrom(root, rewriteChain, squashParent, messageOverrides)
	if err != nil {
		return fmt.Errorf("failed to rewrite chain: %w", err)
	}

	cfg.CurrentSnapshotID = idMap[wsChain[len(wsChain)-1]]
	if cfg.BaseSnapshotID == from {
		cfg.BaseSnapshotID = idMap[to]
	}
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	squashCount := toIdx - fromIdx + 1
	fmt.Printf("✓ Squashed %d snapshots into %s\n", squashCount, idMap[to])
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

	// Build workspace chain and find positions
	wsChain, err := buildWorkspaceChain(metas, cfg.CurrentSnapshotID, cfg.BaseSnapshotID)
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

	// Validate range doesn't contain onto
	rangeChain := wsChain[fromIdx : toIdx+1]
	if snapshotInChain(rangeChain, onto) {
		return fmt.Errorf("cannot rebase onto a snapshot within the range")
	}
	if isDescendantOf(metas, onto, rangeChain) {
		return fmt.Errorf("cannot rebase onto a descendant of the range")
	}

	if metas[onto] == nil {
		return fmt.Errorf("snapshot not found: %s", onto)
	}

	fromMeta := metas[from]
	if fromMeta == nil {
		return fmt.Errorf("snapshot not found: %s", from)
	}
	prevParent := ""
	if len(fromMeta.ParentSnapshotIDs) > 0 {
		prevParent = fromMeta.ParentSnapshotIDs[0]
	}
	if prevParent == "" {
		return fmt.Errorf("cannot rebase root snapshot %s", from)
	}
	if !isAncestorOf(metas, onto, prevParent) {
		return fmt.Errorf("cannot rebase onto %s; it is not an ancestor of %s", onto, from)
	}

	// Build rewrite chain: [from, ..., HEAD] with from's parent replaced by onto
	rewriteChain := wsChain[fromIdx:]
	idMap, err := rewriteChainFrom(root, rewriteChain, onto, nil)
	if err != nil {
		return fmt.Errorf("failed to rewrite chain: %w", err)
	}

	cfg.CurrentSnapshotID = idMap[wsChain[len(wsChain)-1]]
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
	return filepath.Join(config.GetSnapshotsDirAt(root), snapshotID+".meta.json")
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

// buildWorkspaceChain walks from headID backward following first parents until
// it reaches stopID (inclusive). Returns the chain in forward order: [stopID, ..., headID].
func buildWorkspaceChain(metas map[string]*historySnapshotMeta, headID, stopID string) ([]string, error) {
	var chain []string
	current := headID
	seen := make(map[string]struct{})
	for {
		if _, ok := seen[current]; ok {
			return nil, fmt.Errorf("cycle detected in snapshot history")
		}
		seen[current] = struct{}{}
		chain = append(chain, current)
		if current == stopID {
			break
		}
		meta := metas[current]
		if meta == nil {
			break
		}
		if len(meta.ParentSnapshotIDs) == 0 {
			break
		}
		current = meta.ParentSnapshotIDs[0]
	}
	// Reverse to get forward order
	for i, j := 0, len(chain)-1; i < j; i, j = i+1, j-1 {
		chain[i], chain[j] = chain[j], chain[i]
	}
	return chain, nil
}

// rewriteChainFrom creates new snapshot copies for each ID in chain with rewritten parents.
// The first snapshot gets newFirstParent as its parent. Each subsequent snapshot's parent
// is the previous new snapshot. messageOverrides can optionally change the message for
// specific original IDs. Returns a map from original ID to new ID.
func rewriteChainFrom(root string, chain []string, newFirstParent string, messageOverrides map[string]string) (map[string]string, error) {
	if len(chain) == 0 {
		return nil, fmt.Errorf("empty chain")
	}

	snapshotsDir := config.GetSnapshotsDirAt(root)
	prevNewID := newFirstParent
	idMap := make(map[string]string, len(chain))

	for _, origID := range chain {
		metaPath := filepath.Join(snapshotsDir, origID+".meta.json")
		meta, err := loadSnapshotMetaMap(metaPath)
		if err != nil {
			return nil, fmt.Errorf("failed to read snapshot %s: %w", origID, err)
		}

		// Extract fields needed for content-addressed ID computation
		manifestHash, _ := meta["manifest_hash"].(string)
		authorName, _ := meta["author_name"].(string)
		authorEmail, _ := meta["author_email"].(string)

		var newParents []string
		if prevNewID != "" {
			newParents = []string{prevNewID}
		}
		createdAt := time.Now().UTC().Format(time.RFC3339)

		newID := config.ComputeSnapshotID(manifestHash, newParents, authorName, authorEmail, createdAt)
		meta["id"] = newID
		meta["parent_snapshot_ids"] = newParents
		meta["created_at"] = createdAt

		if messageOverrides != nil {
			if msg, ok := messageOverrides[origID]; ok {
				meta["message"] = msg
			}
		}

		newMetaPath := filepath.Join(snapshotsDir, newID+".meta.json")
		if err := writeSnapshotMetaMap(newMetaPath, meta); err != nil {
			return nil, fmt.Errorf("failed to write new snapshot %s: %w", newID, err)
		}

		idMap[origID] = newID
		prevNewID = newID
	}

	return idMap, nil
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
	snapshotsDir := config.GetSnapshotsDirAt(root)
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
