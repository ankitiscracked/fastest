package backend

import "errors"

// ErrNoRemote is returned when a backend has no remote to sync with.
var ErrNoRemote = errors.New("backend has no remote")

// ErrPushRejected is returned when a git push is rejected (non-fast-forward).
// This typically means the remote has new commits that need to be fetched first.
var ErrPushRejected = errors.New("push rejected (non-fast-forward)")

// DivergenceInfo describes a workspace where local and remote heads have diverged.
type DivergenceInfo struct {
	ProjectRoot   string
	WorkspaceName string
	WorkspaceRoot string
	LocalHead     string // local snapshot ID
	RemoteHead    string // imported remote snapshot ID
	MergeBase     string // common ancestor snapshot ID (may be empty)
}

// SyncOptions configures how sync handles divergence.
type SyncOptions struct {
	// OnDivergence is called when local and remote have diverged for a workspace.
	// It should merge the two heads and return the merged snapshot ID.
	// If nil, divergence is reported as an error.
	OnDivergence func(info DivergenceInfo) (mergedSnapshotID string, err error)
}

// Backend defines the interface for storage backends.
// Implementations persist snapshot data to a remote store.
type Backend interface {
	// Type returns the backend identifier ("github", "git", "cloud").
	Type() string

	// Push exports local snapshots to the remote.
	// Returns ErrNoRemote if the backend has no remote to push to.
	Push(projectRoot string) error

	// Pull fetches remote changes into the local store.
	// Returns ErrNoRemote if the backend has no remote.
	Pull(projectRoot string) error

	// Sync performs bidirectional sync with the remote.
	// If opts is nil or OnDivergence is nil, divergence is reported as an error.
	Sync(projectRoot string, opts *SyncOptions) error
}
