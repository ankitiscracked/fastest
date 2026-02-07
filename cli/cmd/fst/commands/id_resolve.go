package commands

import (
	"fmt"
	"strings"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/index"
)

func resolveWorkspaceFromAPI(input string, workspaces []api.Workspace) (*api.Workspace, error) {
	if input == "" {
		return nil, fmt.Errorf("workspace is required")
	}
	for i := range workspaces {
		if workspaces[i].ID == input {
			return &workspaces[i], nil
		}
	}
	for i := range workspaces {
		if workspaces[i].Name == input {
			return &workspaces[i], nil
		}
	}
	if strings.HasPrefix(input, "ws-") {
		ids := make([]string, 0, len(workspaces))
		for _, ws := range workspaces {
			ids = append(ids, ws.ID)
		}
		if resolved, err := resolveIDPrefix(input, ids, "workspace"); err == nil {
			for i := range workspaces {
				if workspaces[i].ID == resolved {
					return &workspaces[i], nil
				}
			}
		} else if !strings.Contains(err.Error(), "not found") {
			return nil, err
		}
	}
	return nil, fmt.Errorf("workspace %q not found in project", input)
}

func resolveWorkspaceFromRegistry(input string, workspaces []index.WorkspaceEntry, projectID string) (*index.WorkspaceEntry, bool, error) {
	if input == "" {
		return nil, false, fmt.Errorf("workspace is required")
	}
	candidates := make([]index.WorkspaceEntry, 0, len(workspaces))
	for _, ws := range workspaces {
		if ws.ProjectID == projectID {
			candidates = append(candidates, ws)
		}
	}

	for i := range candidates {
		if candidates[i].WorkspaceID == input {
			return &candidates[i], true, nil
		}
	}
	for i := range candidates {
		if candidates[i].WorkspaceName == input {
			return &candidates[i], true, nil
		}
	}

	if strings.HasPrefix(input, "ws-") {
		ids := make([]string, 0, len(candidates))
		for _, ws := range candidates {
			ids = append(ids, ws.WorkspaceID)
		}
		if resolved, err := resolveIDPrefix(input, ids, "workspace"); err == nil {
			for i := range candidates {
				if candidates[i].WorkspaceID == resolved {
					return &candidates[i], true, nil
				}
			}
		} else if !strings.Contains(err.Error(), "not found") {
			return nil, false, err
		}
	}

	return nil, false, nil
}

func resolveProjectFromAPI(input string, projects []api.Project) (*api.Project, error) {
	if input == "" {
		return nil, fmt.Errorf("project is required")
	}
	for i := range projects {
		if projects[i].ID == input {
			return &projects[i], nil
		}
	}
	for i := range projects {
		if projects[i].Name == input {
			return &projects[i], nil
		}
	}
	if strings.HasPrefix(input, "proj-") {
		ids := make([]string, 0, len(projects))
		for _, p := range projects {
			ids = append(ids, p.ID)
		}
		if resolved, err := resolveIDPrefix(input, ids, "project"); err == nil {
			for i := range projects {
				if projects[i].ID == resolved {
					return &projects[i], nil
				}
			}
		} else if !strings.Contains(err.Error(), "not found") {
			return nil, err
		}
	}
	return nil, fmt.Errorf("project %q not found", input)
}
