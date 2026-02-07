package commands

import (
	"fmt"

	"github.com/anthropics/fastest/cli/internal/workspace"
)

func createInitialSnapshot(root, workspaceID, workspaceName string, cloudSynced bool) (string, error) {
	fmt.Println("Creating initial snapshot...")

	// Resolve author identity (interactive — may prompt via TUI)
	author, err := resolveAuthor()
	if err != nil {
		return "", err
	}

	ws, err := workspace.OpenAt(root)
	if err != nil {
		return "", fmt.Errorf("failed to open workspace: %w", err)
	}
	defer ws.Close()

	result, err := ws.Snapshot(workspace.SnapshotOpts{
		Message: "Initial snapshot",
		Author:  author,
	})
	if err != nil {
		return "", err
	}

	fmt.Printf("Captured %d files.\n", result.Files)

	// Set base snapshot and mode (not handled by workspace.Snapshot)
	cfg := ws.Config()
	cfg.BaseSnapshotID = result.SnapshotID
	cfg.Mode = modeString(cloudSynced)
	if err := ws.SaveConfig(); err != nil {
		return "", fmt.Errorf("failed to update config: %w", err)
	}

	return result.SnapshotID, nil
}
