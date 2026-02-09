package store

import (
	"fmt"
	"time"
)

// RewriteResult contains the outcome of a chain rewrite operation.
type RewriteResult struct {
	// IDMap maps original snapshot ID → new snapshot ID.
	IDMap     map[string]string
	NewHeadID string
}

// BuildWorkspaceChain walks from headID backward following first parents until
// it reaches stopID (inclusive). Returns the chain in forward order: [stopID, ..., headID].
func (s *Store) BuildWorkspaceChain(headID, stopID string) ([]string, error) {
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
		meta, err := s.LoadSnapshotMeta(current)
		if err != nil {
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

// IsAncestorOf returns true if ancestor is reachable by walking parent links
// from start. Uses BFS through all parent links.
func (s *Store) IsAncestorOf(ancestor, start string) bool {
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
		meta, err := s.LoadSnapshotMeta(current)
		if err != nil {
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

// IsDescendantOf returns true if candidate is a descendant of any snapshot in
// the ancestors set. Walks candidate's first-parent chain only.
func (s *Store) IsDescendantOf(candidate string, ancestors []string) bool {
	ancestorSet := make(map[string]struct{}, len(ancestors))
	for _, id := range ancestors {
		ancestorSet[id] = struct{}{}
	}

	current := candidate
	for current != "" {
		if _, ok := ancestorSet[current]; ok {
			return true
		}
		meta, err := s.LoadSnapshotMeta(current)
		if err != nil || len(meta.ParentSnapshotIDs) == 0 {
			break
		}
		if len(meta.ParentSnapshotIDs) > 1 {
			break
		}
		current = meta.ParentSnapshotIDs[0]
	}
	return false
}

// RewriteChain creates new snapshot copies for each ID in chain with rewritten
// parents. The first snapshot gets newFirstParent as its parent. Each subsequent
// snapshot's parent is the previous new snapshot. messageOverrides can optionally
// change the message for specific original IDs. Returns the mapping from old to
// new IDs and the new head ID.
func (s *Store) RewriteChain(chain []string, newFirstParent string, messageOverrides map[string]string) (*RewriteResult, error) {
	if len(chain) == 0 {
		return nil, fmt.Errorf("empty chain")
	}

	prevNewID := newFirstParent
	idMap := make(map[string]string, len(chain))

	for _, origID := range chain {
		meta, err := s.LoadSnapshotMeta(origID)
		if err != nil {
			return nil, fmt.Errorf("failed to read snapshot %s: %w", origID, err)
		}

		var newParents []string
		if prevNewID != "" {
			newParents = []string{prevNewID}
		}
		createdAt := time.Now().UTC().Format(time.RFC3339)

		newID := ComputeSnapshotID(meta.ManifestHash, newParents, meta.AuthorName, meta.AuthorEmail, createdAt)

		newMeta := &SnapshotMeta{
			ID:                newID,
			WorkspaceID:       meta.WorkspaceID,
			WorkspaceName:     meta.WorkspaceName,
			ManifestHash:      meta.ManifestHash,
			ParentSnapshotIDs: newParents,
			AuthorName:        meta.AuthorName,
			AuthorEmail:       meta.AuthorEmail,
			Message:           meta.Message,
			Agent:             meta.Agent,
			CreatedAt:         createdAt,
			Files:             meta.Files,
			Size:              meta.Size,
		}

		if messageOverrides != nil {
			if msg, ok := messageOverrides[origID]; ok {
				newMeta.Message = msg
			}
		}

		if err := s.WriteSnapshotMeta(newMeta); err != nil {
			return nil, fmt.Errorf("failed to write new snapshot %s: %w", newID, err)
		}

		idMap[origID] = newID
		prevNewID = newID
	}

	return &RewriteResult{
		IDMap:     idMap,
		NewHeadID: prevNewID,
	}, nil
}

// EditSnapshotMessage updates the message field of an existing snapshot.
func (s *Store) EditSnapshotMessage(snapshotID, newMessage string) error {
	meta, err := s.LoadSnapshotMeta(snapshotID)
	if err != nil {
		return err
	}
	meta.Message = newMessage
	return s.WriteSnapshotMeta(meta)
}
