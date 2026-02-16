package commands

import (
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/agent"
)

// Deps groups external dependencies so tests can inject fakes.
type Deps struct {
	Sleep func(time.Duration)
	Now   func() time.Time

	AgentGetPreferred func() (*agent.Agent, error)
	AgentInvoke       agent.InvokeFunc
}

var defaultDeps = Deps{
	Sleep:             time.Sleep,
	Now:               time.Now,
	AgentGetPreferred: agent.GetPreferredAgent,
	AgentInvoke:       agent.Invoke,
}

var deps = defaultDeps

func normalizeDeps(d Deps) Deps {
	if d.Sleep == nil {
		d.Sleep = defaultDeps.Sleep
	}
	if d.Now == nil {
		d.Now = defaultDeps.Now
	}
	if d.AgentGetPreferred == nil {
		d.AgentGetPreferred = defaultDeps.AgentGetPreferred
	}
	if d.AgentInvoke == nil {
		d.AgentInvoke = defaultDeps.AgentInvoke
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
