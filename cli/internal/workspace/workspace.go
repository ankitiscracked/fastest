// Package workspace provides workspace-level operations. A Workspace owns
// a single workspace's .fst/config.json, stat cache, and merge state, and
// references a project-level Store for snapshot/manifest/blob I/O.
//
// Commands should call Open(path) to get a Workspace, use its methods for
// high-level operations (Snapshot, Merge, Rollback, etc.), and defer Close.
package workspace

import (
	"fmt"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/store"
)

// Workspace represents an open workspace with its configuration and
// project store. Use Open or OpenAt to create one.
type Workspace struct {
	root  string                // workspace root directory
	cfg   *config.ProjectConfig // workspace config (.fst/config.json)
	store *store.Store          // project-level shared store
}

// Open loads the workspace rooted at the current working directory.
func Open() (*Workspace, error) {
	root, err := config.FindProjectRoot()
	if err != nil {
		return nil, fmt.Errorf("not in a workspace directory: %w", err)
	}
	return OpenAt(root)
}

// OpenAt loads the workspace rooted at the given path.
func OpenAt(root string) (*Workspace, error) {
	cfg, err := config.LoadAt(root)
	if err != nil {
		return nil, fmt.Errorf("failed to load workspace config: %w", err)
	}

	s := store.OpenFromWorkspace(root)

	// Register in project-level workspace registry (lazy migration).
	// Non-fatal — the registry is advisory; config.json remains canonical.
	_ = s.RegisterWorkspace(store.WorkspaceInfo{
		WorkspaceID:       cfg.WorkspaceID,
		WorkspaceName:     cfg.WorkspaceName,
		Path:              root,
		CurrentSnapshotID: cfg.CurrentSnapshotID,
		BaseSnapshotID:    cfg.BaseSnapshotID,
	})

	return &Workspace{
		root:  root,
		cfg:   cfg,
		store: s,
	}, nil
}

// Close releases any resources held by the workspace.
// Currently a no-op; will acquire/release locks in the future.
func (ws *Workspace) Close() error {
	return nil
}

// Root returns the workspace root directory.
func (ws *Workspace) Root() string { return ws.root }

// Config returns the workspace configuration. The returned pointer should
// not be modified directly — use workspace methods to mutate state.
func (ws *Workspace) Config() *config.ProjectConfig { return ws.cfg }

// Store returns the project-level shared store.
func (ws *Workspace) Store() *store.Store { return ws.store }

// ProjectID returns the project ID.
func (ws *Workspace) ProjectID() string { return ws.cfg.ProjectID }

// WorkspaceID returns the workspace ID.
func (ws *Workspace) WorkspaceID() string { return ws.cfg.WorkspaceID }

// WorkspaceName returns the workspace name.
func (ws *Workspace) WorkspaceName() string { return ws.cfg.WorkspaceName }

// CurrentSnapshotID returns the current head snapshot ID.
func (ws *Workspace) CurrentSnapshotID() string { return ws.cfg.CurrentSnapshotID }

// BaseSnapshotID returns the base (fork point) snapshot ID.
func (ws *Workspace) BaseSnapshotID() string { return ws.cfg.BaseSnapshotID }

// StatCachePath returns the path to the workspace's stat cache file.
func (ws *Workspace) StatCachePath() string {
	return config.GetStatCachePath(ws.root)
}

// SaveConfig writes the current workspace configuration to disk.
func (ws *Workspace) SaveConfig() error {
	return config.SaveAt(ws.root, ws.cfg)
}

// SetCurrentSnapshotID updates the current head snapshot and persists the config.
func (ws *Workspace) SetCurrentSnapshotID(id string) error {
	ws.cfg.CurrentSnapshotID = id
	return ws.SaveConfig()
}
