package commands

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestStatusJSONOutput(t *testing.T) {
	root := setupWorkspace(t, "ws-json", map[string]string{
		"file.txt": "ok",
	})

	if err := os.MkdirAll(filepath.Join(root, ".fst", "snapshots"), 0755); err != nil {
		t.Fatalf("mkdir snapshots: %v", err)
	}
	if _, err := createInitialSnapshot(root, "ws-json-id", "ws-json", false); err != nil {
		t.Fatalf("createInitialSnapshot: %v", err)
	}

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"status", "--json"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("status --json failed: %v", err)
	}

	var payload map[string]interface{}
	if err := json.Unmarshal([]byte(strings.TrimSpace(output)), &payload); err != nil {
		t.Fatalf("invalid JSON output: %v\noutput: %s", err, output)
	}
	if payload["workspace_name"] != "ws-json" {
		t.Fatalf("workspace_name mismatch: %v", payload["workspace_name"])
	}
	if payload["latest_snapshot_id"] == "" {
		t.Fatalf("expected latest_snapshot_id to be set")
	}
	if payload["latest_snapshot_time"] == "" {
		t.Fatalf("expected latest_snapshot_time to be set")
	}
}
