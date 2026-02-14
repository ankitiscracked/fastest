package backend

import "errors"

// ErrNoRemote is returned when a backend has no remote to sync with.
var ErrNoRemote = errors.New("backend has no remote")

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
	// Returns ErrNoRemote if the backend has no remote to sync with.
	Sync(projectRoot string) error
}
