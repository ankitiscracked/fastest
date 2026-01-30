package commands

import (
	"testing"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
)

func TestLoginAlreadyLoggedIn(t *testing.T) {
	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "token", nil },
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"login"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("login already-logged-in should succeed: %v", err)
	}
}

func TestWhoamiNotLoggedIn(t *testing.T) {
	SetDeps(Deps{
		AuthGetToken: func() (string, error) { return "", nil },
		NewAPIClient: func(string, *config.ProjectConfig) *api.Client {
			t.Fatalf("NewAPIClient should not be called when not logged in")
			return nil
		},
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"whoami"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("whoami not-logged-in should succeed: %v", err)
	}
}
