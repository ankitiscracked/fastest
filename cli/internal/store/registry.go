package store

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const workspacesDirName = "workspaces"

// WorkspaceInfo describes a workspace registered in the project.
// Each workspace is stored as a separate file under .fst/workspaces/<id>.json,
// so concurrent updates from different workspaces never conflict.
type WorkspaceInfo struct {
	WorkspaceID       string `json:"workspace_id"`
	WorkspaceName     string `json:"workspace_name"`
	Path              string `json:"path"`
	CurrentSnapshotID string `json:"current_snapshot_id,omitempty"`
	BaseSnapshotID    string `json:"base_snapshot_id,omitempty"`
	CreatedAt         string `json:"created_at,omitempty"`
}

func (s *Store) workspacesDir() string {
	return filepath.Join(s.root, configDirName, workspacesDirName)
}

func (s *Store) workspacePath(id string) string {
	return filepath.Join(s.workspacesDir(), id+".json")
}

// loadWorkspaceInfo reads a single workspace file.
func (s *Store) loadWorkspaceInfo(id string) (*WorkspaceInfo, error) {
	data, err := os.ReadFile(s.workspacePath(id))
	if err != nil {
		return nil, err
	}
	var info WorkspaceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

// saveWorkspaceInfo writes a single workspace file.
func (s *Store) saveWorkspaceInfo(info *WorkspaceInfo) error {
	dir := s.workspacesDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.workspacePath(info.WorkspaceID), data, 0644)
}

// RegisterWorkspace upserts a workspace entry by workspace ID.
// Existing fields are preserved if the new value is empty.
func (s *Store) RegisterWorkspace(info WorkspaceInfo) error {
	existing, err := s.loadWorkspaceInfo(info.WorkspaceID)
	if err != nil {
		if os.IsNotExist(err) {
			return s.saveWorkspaceInfo(&info)
		}
		return err
	}

	// Merge: only overwrite non-empty fields
	if info.WorkspaceName != "" {
		existing.WorkspaceName = info.WorkspaceName
	}
	if info.Path != "" {
		existing.Path = info.Path
	}
	if info.CurrentSnapshotID != "" {
		existing.CurrentSnapshotID = info.CurrentSnapshotID
	}
	if info.BaseSnapshotID != "" {
		existing.BaseSnapshotID = info.BaseSnapshotID
	}
	if info.CreatedAt != "" {
		existing.CreatedAt = info.CreatedAt
	}
	return s.saveWorkspaceInfo(existing)
}

// UpdateWorkspaceHead sets the CurrentSnapshotID for a workspace.
func (s *Store) UpdateWorkspaceHead(workspaceID, snapshotID string) error {
	existing, err := s.loadWorkspaceInfo(workspaceID)
	if err != nil {
		if os.IsNotExist(err) {
			return fmt.Errorf("workspace %s not found in registry", workspaceID)
		}
		return err
	}
	existing.CurrentSnapshotID = snapshotID
	return s.saveWorkspaceInfo(existing)
}

// FindWorkspaceByName returns the workspace with the given name, or error if not found.
func (s *Store) FindWorkspaceByName(name string) (*WorkspaceInfo, error) {
	entries, err := os.ReadDir(s.workspacesDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("workspace '%s' not found", name)
		}
		return nil, err
	}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		info, err := s.loadWorkspaceInfo(id)
		if err != nil {
			continue
		}
		if info.WorkspaceName == name {
			return info, nil
		}
	}
	return nil, fmt.Errorf("workspace '%s' not found", name)
}

// FindWorkspaceByID returns the workspace with the given ID, or error if not found.
func (s *Store) FindWorkspaceByID(id string) (*WorkspaceInfo, error) {
	info, err := s.loadWorkspaceInfo(id)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("workspace with ID '%s' not found", id)
		}
		return nil, err
	}
	return info, nil
}

// ListWorkspaces returns all registered workspaces.
func (s *Store) ListWorkspaces() ([]WorkspaceInfo, error) {
	entries, err := os.ReadDir(s.workspacesDir())
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var result []WorkspaceInfo
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".json") {
			continue
		}
		id := strings.TrimSuffix(e.Name(), ".json")
		info, err := s.loadWorkspaceInfo(id)
		if err != nil {
			continue
		}
		result = append(result, *info)
	}
	return result, nil
}
