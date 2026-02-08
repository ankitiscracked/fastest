package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	registryFileName       = "workspaces.json"
	currentRegistryVersion = 1
)

// WorkspaceRegistry holds the project-level workspace registry.
// Stored in .fst/workspaces.json alongside snapshots, manifests, and blobs.
type WorkspaceRegistry struct {
	Version    int             `json:"version"`
	Workspaces []WorkspaceInfo `json:"workspaces"`
}

// WorkspaceInfo describes a workspace registered in the project.
type WorkspaceInfo struct {
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceName     string `json:"workspace_name"`
	Path              string `json:"path"`
	CurrentSnapshotID string `json:"current_snapshot_id,omitempty"`
	BaseSnapshotID    string `json:"base_snapshot_id,omitempty"`
	CreatedAt         string `json:"created_at,omitempty"`
}

func (s *Store) registryPath() string {
	return filepath.Join(s.root, configDirName, registryFileName)
}

// LoadWorkspaceRegistry reads the project-level workspace registry.
// Returns an empty registry if the file doesn't exist.
func (s *Store) LoadWorkspaceRegistry() (*WorkspaceRegistry, error) {
	data, err := os.ReadFile(s.registryPath())
	if err != nil {
		if os.IsNotExist(err) {
			return &WorkspaceRegistry{Version: currentRegistryVersion}, nil
		}
		return nil, err
	}
	var reg WorkspaceRegistry
	if err := json.Unmarshal(data, &reg); err != nil {
		return nil, err
	}
	if reg.Version == 0 {
		reg.Version = currentRegistryVersion
	}
	return &reg, nil
}

// SaveWorkspaceRegistry writes the project-level workspace registry.
func (s *Store) SaveWorkspaceRegistry(reg *WorkspaceRegistry) error {
	if reg.Version == 0 {
		reg.Version = currentRegistryVersion
	}
	dir := filepath.Join(s.root, configDirName)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(reg, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.registryPath(), data, 0644)
}

// RegisterWorkspace upserts a workspace entry by workspace ID.
// Existing fields are preserved if the new value is empty.
func (s *Store) RegisterWorkspace(info WorkspaceInfo) error {
	reg, err := s.LoadWorkspaceRegistry()
	if err != nil {
		return err
	}
	updated := false
	for i := range reg.Workspaces {
		if reg.Workspaces[i].WorkspaceID == info.WorkspaceID {
			if info.WorkspaceName != "" {
				reg.Workspaces[i].WorkspaceName = info.WorkspaceName
			}
			if info.Path != "" {
				reg.Workspaces[i].Path = info.Path
			}
			if info.CurrentSnapshotID != "" {
				reg.Workspaces[i].CurrentSnapshotID = info.CurrentSnapshotID
			}
			if info.BaseSnapshotID != "" {
				reg.Workspaces[i].BaseSnapshotID = info.BaseSnapshotID
			}
			if info.CreatedAt != "" {
				reg.Workspaces[i].CreatedAt = info.CreatedAt
			}
			updated = true
			break
		}
	}
	if !updated {
		reg.Workspaces = append(reg.Workspaces, info)
	}
	return s.SaveWorkspaceRegistry(reg)
}

// UpdateWorkspaceHead sets the CurrentSnapshotID for a workspace.
func (s *Store) UpdateWorkspaceHead(workspaceID, snapshotID string) error {
	reg, err := s.LoadWorkspaceRegistry()
	if err != nil {
		return err
	}
	for i := range reg.Workspaces {
		if reg.Workspaces[i].WorkspaceID == workspaceID {
			reg.Workspaces[i].CurrentSnapshotID = snapshotID
			return s.SaveWorkspaceRegistry(reg)
		}
	}
	return fmt.Errorf("workspace %s not found in registry", workspaceID)
}

// FindWorkspaceByName returns the workspace with the given name, or error if not found.
func (s *Store) FindWorkspaceByName(name string) (*WorkspaceInfo, error) {
	reg, err := s.LoadWorkspaceRegistry()
	if err != nil {
		return nil, err
	}
	for i := range reg.Workspaces {
		if reg.Workspaces[i].WorkspaceName == name {
			return &reg.Workspaces[i], nil
		}
	}
	return nil, fmt.Errorf("workspace '%s' not found", name)
}

// FindWorkspaceByID returns the workspace with the given ID, or error if not found.
func (s *Store) FindWorkspaceByID(id string) (*WorkspaceInfo, error) {
	reg, err := s.LoadWorkspaceRegistry()
	if err != nil {
		return nil, err
	}
	for i := range reg.Workspaces {
		if reg.Workspaces[i].WorkspaceID == id {
			return &reg.Workspaces[i], nil
		}
	}
	return nil, fmt.Errorf("workspace with ID '%s' not found", id)
}

// ListWorkspaces returns all registered workspaces.
func (s *Store) ListWorkspaces() ([]WorkspaceInfo, error) {
	reg, err := s.LoadWorkspaceRegistry()
	if err != nil {
		return nil, err
	}
	return reg.Workspaces, nil
}
