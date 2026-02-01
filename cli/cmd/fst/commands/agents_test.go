package commands

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAgentsSetPreferredRequiresNameInNonInteractiveMode(t *testing.T) {
	root := t.TempDir()
	restoreCwd := chdir(t, root)
	defer restoreCwd()

	setenv(t, "XDG_CONFIG_HOME", filepath.Join(root, "config"))

	r, w, err := os.Pipe()
	if err != nil {
		t.Fatalf("pipe: %v", err)
	}
	defer r.Close()
	defer w.Close()

	oldStdin := os.Stdin
	os.Stdin = r
	defer func() { os.Stdin = oldStdin }()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"agents", "set-preferred"})
	err = cmd.Execute()
	if err == nil {
		t.Fatalf("expected error, got nil")
	}
	if err.Error() != "agent name is required in non-interactive mode" {
		t.Fatalf("unexpected error: %v", err)
	}
}
