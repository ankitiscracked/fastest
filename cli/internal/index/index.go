package index

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/anthropics/fastest/cli/internal/config"
)

const (
	indexFileName        = "index.json"
	legacyWorkspacesFile = "workspaces.json"
	currentIndexVersion  = 1
	timeFormatRFC3339    = time.RFC3339
)

type Index struct {
	Version    int              `json:"version"`
	Projects   []ProjectEntry   `json:"projects,omitempty"`
	Workspaces []WorkspaceEntry `json:"workspaces,omitempty"`
}

type ProjectEntry struct {
	ProjectID   string `json:"project_id"`
	ProjectName string `json:"project_name"`
	ProjectPath string `json:"project_path,omitempty"`
	CreatedAt   string `json:"created_at,omitempty"`
	LastSeenAt  string `json:"last_seen_at,omitempty"`
	LocalOnly   bool   `json:"local_only,omitempty"`
}

type WorkspaceEntry struct {
	WorkspaceID    string `json:"workspace_id"`
	WorkspaceName  string `json:"workspace_name"`
	ProjectID      string `json:"project_id"`
	Path           string `json:"path"`
	ForkSnapshotID string `json:"fork_snapshot_id,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
	LastSeenAt     string `json:"last_seen_at,omitempty"`
	MachineID      string `json:"machine_id,omitempty"`
	LocalOnly      bool   `json:"local_only,omitempty"`
}

type legacyRegistry struct {
	Workspaces []legacyWorkspace `json:"workspaces"`
}

type legacyWorkspace struct {
	ID             string `json:"id"`
	ProjectID      string `json:"project_id"`
	Name           string `json:"name"`
	Path           string `json:"path"`
	ForkSnapshotID string `json:"fork_snapshot_id,omitempty"`
	CreatedAt      string `json:"created_at,omitempty"`
}

func GetIndexPath() (string, error) {
	configDir, err := config.GetGlobalConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, indexFileName), nil
}

func getLegacyPath() (string, error) {
	configDir, err := config.GetGlobalConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, legacyWorkspacesFile), nil
}

func Load() (*Index, error) {
	path, err := GetIndexPath()
	if err != nil {
		return nil, err
	}
	if data, err := os.ReadFile(path); err == nil {
		var idx Index
		if err := json.Unmarshal(data, &idx); err != nil {
			return nil, err
		}
		if idx.Version == 0 {
			idx.Version = currentIndexVersion
		}
		return &idx, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	legacyPath, err := getLegacyPath()
	if err != nil {
		return nil, err
	}
	if data, err := os.ReadFile(legacyPath); err == nil {
		var legacy legacyRegistry
		if err := json.Unmarshal(data, &legacy); err != nil {
			return nil, err
		}
		idx := &Index{
			Version:    currentIndexVersion,
			Projects:   []ProjectEntry{},
			Workspaces: []WorkspaceEntry{},
		}
		for _, ws := range legacy.Workspaces {
			idx.Workspaces = append(idx.Workspaces, WorkspaceEntry{
				WorkspaceID:    ws.ID,
				WorkspaceName:  ws.Name,
				ProjectID:      ws.ProjectID,
				Path:           ws.Path,
				ForkSnapshotID: ws.ForkSnapshotID,
				CreatedAt:      ws.CreatedAt,
				LocalOnly:      true,
			})
		}
		return idx, nil
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	return &Index{Version: currentIndexVersion}, nil
}

func Save(idx *Index) error {
	if idx == nil {
		return fmt.Errorf("index is nil")
	}
	if idx.Version == 0 {
		idx.Version = currentIndexVersion
	}
	path, err := GetIndexPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	data, err := json.MarshalIndent(idx, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0644)
}

func UpsertProject(entry ProjectEntry) error {
	idx, err := Load()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(timeFormatRFC3339)
	updated := false
	for i := range idx.Projects {
		if idx.Projects[i].ProjectID == entry.ProjectID {
			if entry.ProjectName != "" {
				idx.Projects[i].ProjectName = entry.ProjectName
			}
			if entry.ProjectPath != "" {
				idx.Projects[i].ProjectPath = entry.ProjectPath
			}
			if entry.CreatedAt != "" {
				idx.Projects[i].CreatedAt = entry.CreatedAt
			}
			idx.Projects[i].LocalOnly = entry.LocalOnly
			idx.Projects[i].LastSeenAt = now
			updated = true
			break
		}
	}
	if !updated {
		entry.LastSeenAt = now
		idx.Projects = append(idx.Projects, entry)
	}
	return Save(idx)
}

func UpsertWorkspace(entry WorkspaceEntry, oldPath string) error {
	idx, err := Load()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(timeFormatRFC3339)
	updated := false
	filtered := make([]WorkspaceEntry, 0, len(idx.Workspaces))
	for _, ws := range idx.Workspaces {
		if ws.WorkspaceID == entry.WorkspaceID || ws.Path == oldPath || ws.Path == entry.Path {
			if !updated {
				if entry.WorkspaceName == "" {
					entry.WorkspaceName = ws.WorkspaceName
				}
				if entry.ProjectID == "" {
					entry.ProjectID = ws.ProjectID
				}
				if entry.ForkSnapshotID == "" {
					entry.ForkSnapshotID = ws.ForkSnapshotID
				}
				if entry.CreatedAt == "" {
					entry.CreatedAt = ws.CreatedAt
				}
				entry.LastSeenAt = now
				filtered = append(filtered, entry)
				updated = true
			}
			continue
		}
		filtered = append(filtered, ws)
	}
	if !updated {
		entry.LastSeenAt = now
		filtered = append(filtered, entry)
	}
	idx.Workspaces = filtered
	return Save(idx)
}

func TouchWorkspace(workspaceID string) error {
	idx, err := Load()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(timeFormatRFC3339)
	for i := range idx.Workspaces {
		if idx.Workspaces[i].WorkspaceID == workspaceID {
			idx.Workspaces[i].LastSeenAt = now
			return Save(idx)
		}
	}
	return nil
}

func TouchProject(projectID string) error {
	idx, err := Load()
	if err != nil {
		return err
	}
	now := time.Now().UTC().Format(timeFormatRFC3339)
	for i := range idx.Projects {
		if idx.Projects[i].ProjectID == projectID {
			idx.Projects[i].LastSeenAt = now
			return Save(idx)
		}
	}
	return nil
}
