package commands

import (
	"time"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/auth"
	"github.com/anthropics/fastest/cli/internal/config"
)

// Deps groups external dependencies so tests can inject fakes.
type Deps struct {
	AuthGetToken    func() (string, error)
	AuthSaveToken   func(string) error
	AuthClearToken  func() error
	AuthFormatError func(error) error
	NewAPIClient    func(string, *config.ProjectConfig) *api.Client
	OpenBrowser     func(string) error
	Sleep           func(time.Duration)
	Now             func() time.Time
}

var defaultDeps = Deps{
	AuthGetToken:    auth.GetToken,
	AuthSaveToken:   auth.SaveToken,
	AuthClearToken:  auth.ClearToken,
	AuthFormatError: auth.FormatKeyringError,
	NewAPIClient:    newAPIClient,
	OpenBrowser:     openBrowser,
	Sleep:           time.Sleep,
	Now:             time.Now,
}

var deps = defaultDeps

func normalizeDeps(d Deps) Deps {
	if d.AuthGetToken == nil {
		d.AuthGetToken = defaultDeps.AuthGetToken
	}
	if d.AuthSaveToken == nil {
		d.AuthSaveToken = defaultDeps.AuthSaveToken
	}
	if d.AuthClearToken == nil {
		d.AuthClearToken = defaultDeps.AuthClearToken
	}
	if d.AuthFormatError == nil {
		d.AuthFormatError = defaultDeps.AuthFormatError
	}
	if d.NewAPIClient == nil {
		d.NewAPIClient = defaultDeps.NewAPIClient
	}
	if d.OpenBrowser == nil {
		d.OpenBrowser = defaultDeps.OpenBrowser
	}
	if d.Sleep == nil {
		d.Sleep = defaultDeps.Sleep
	}
	if d.Now == nil {
		d.Now = defaultDeps.Now
	}
	return d
}

// SetDeps overrides command dependencies (use in tests).
func SetDeps(d Deps) {
	deps = normalizeDeps(d)
}

// ResetDeps restores default dependencies.
func ResetDeps() {
	deps = defaultDeps
}
