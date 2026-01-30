package commands

import "testing"

func TestVersionCommandRuns(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"version"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("version command failed: %v", err)
	}
}

func TestCloneRequiresArg(t *testing.T) {
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"clone"})
	if err := cmd.Execute(); err == nil {
		t.Fatalf("expected clone without args to fail")
	}
}
