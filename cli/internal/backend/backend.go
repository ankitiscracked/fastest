package backend

import (
	"errors"

	"github.com/ankitiscracked/fastest/cli/internal/config"
)

// ErrNoRemote is returned when a backend has no remote to sync with.
var ErrNoRemote = errors.New("backend has no remote")

// ExportFunc exports local snapshots to git commits at the given project root.
type ExportFunc func(projectRoot string, initRepo, rebuild bool) error

// FromConfig creates a Backend from a BackendConfig.
// exportGit is the function used to export snapshots to git (typically RunExportGitAt).
func FromConfig(cfg *config.BackendConfig, exportGit ExportFunc) Backend {
	if cfg == nil {
		return nil
	}
	switch cfg.Type {
	case "github":
		remote := cfg.Remote
		if remote == "" {
			remote = "origin"
		}
		return &GitHubBackend{Repo: cfg.Repo, Remote: remote, ExportGit: exportGit}
	case "git":
		return &GitBackend{ExportGit: exportGit}
	default:
		return nil
	}
}

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
