package dag

import (
	"github.com/anthropics/fastest/cli/internal/store"
)

// GetMergeBase finds the most recent common ancestor between two snapshot heads.
// This is a convenience wrapper around store.Store.GetMergeBase.
func GetMergeBase(s *store.Store, targetHead, sourceHead string) (string, error) {
	return s.GetMergeBase(targetHead, sourceHead)
}
