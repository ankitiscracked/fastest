package commands

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ankitiscracked/fastest/cli/internal/agent"
	"github.com/ankitiscracked/fastest/cli/internal/config"
)

// mockAgent returns a fake agent for testing.
func mockAgent() *agent.Agent {
	return &agent.Agent{
		Name:        "mock",
		Command:     "echo",
		Path:        "/usr/bin/echo",
		Description: "Mock agent for testing",
		Available:   true,
	}
}

// --- Mock-based agent e2e tests ---

func TestMergeWithAgentResolvesConflicts(t *testing.T) {
	// Set up two workspaces with the SAME file modified differently (conflict).
	_, targetRoot, _ := setupProjectWithWorkspaces(t,
		map[string]string{"shared.txt": "target version of shared file\nline2\nline3\n"},
		map[string]string{"shared.txt": "source version of shared file\nline2\nline3\n"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	// Inject mock agent that returns merged content
	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return mockAgent(), nil
		},
		AgentInvoke: func(a *agent.Agent, prompt string) (string, error) {
			return "• Kept target header\n• Added source improvements\n\n---MERGED CODE---\nmerged: target + source version\nline2\nline3\n", nil
		},
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "ws-source", "--force"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("merge with agent failed: %v", err)
	}

	// Verify the conflicted file contains the agent-merged result
	content, err := os.ReadFile(filepath.Join(targetRoot, "shared.txt"))
	if err != nil {
		t.Fatalf("read merged file: %v", err)
	}
	if !strings.Contains(string(content), "merged: target + source version") {
		t.Fatalf("expected agent-merged content, got:\n%s", string(content))
	}
	// Verify no conflict markers remain
	if strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("conflict markers should not be present after agent merge")
	}
}

func TestSnapshotWithAgentMessage(t *testing.T) {
	root := setupWorkspace(t, "ws-agent-snap", map[string]string{
		"main.go": "package main\nfunc main() {}\n",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	// Create initial snapshot so there's a base to diff from
	SetDeps(Deps{})
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "initial"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("initial snapshot failed: %v", err)
	}
	ResetDeps()

	// Now add a change and snapshot with --agent-message
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\nfunc main() { fmt.Println(\"hello\") }\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return mockAgent(), nil
		},
		AgentInvoke: func(a *agent.Agent, prompt string) (string, error) {
			return "Added hello world print statement to main function", nil
		},
	})
	defer ResetDeps()

	// snapshot --agent-message triggers the TUI prompt which we can't drive in tests.
	// Instead, test the generateSnapshotSummary function directly.
	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	summary, err := generateSnapshotSummary(root, cfg, mockAgent(), deps.AgentInvoke)
	if err != nil {
		t.Fatalf("generateSnapshotSummary failed: %v", err)
	}
	if summary != "Added hello world print statement to main function" {
		t.Fatalf("expected agent summary, got: %q", summary)
	}
}

func TestDriftWithAgentSummary(t *testing.T) {
	_, targetRoot, _ := setupForkedWorkspaces(t,
		map[string]string{"a.txt": "one"},
		map[string]string{"b.txt": "two"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return mockAgent(), nil
		},
		AgentInvoke: func(a *agent.Agent, prompt string) (string, error) {
			return "Low risk: workspaces diverged on separate files with no overlap.", nil
		},
	})
	defer ResetDeps()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"drift", "ws-source", "--no-dirty", "--agent-summary"})
		return cmd.Execute()
	}, &output)
	// drift returns exit code 1 when drift is detected
	if err != nil {
		if code := ExitCode(err); code != 1 {
			t.Fatalf("drift failed unexpectedly: %v", err)
		}
	}

	if !strings.Contains(output, "Low risk: workspaces diverged") {
		t.Fatalf("expected agent summary in output, got:\n%s", output)
	}
}

func TestMergeDryRunShowsConflicts(t *testing.T) {
	// Verify that merge --dry-run with --agent-summary shows conflict info.
	// Note: The agent summary in printConflictDetails requires conflicts.Detect
	// to successfully analyze line-level conflicts, which needs the source workspace
	// to be accessible by path. We verify the merge plan output here.
	_, targetRoot, _ := setupForkedWorkspaces(t,
		map[string]string{"shared.txt": "target changes\nline2\nline3\n"},
		map[string]string{"shared.txt": "source changes\nline2\nline3\n"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return mockAgent(), nil
		},
		AgentInvoke: func(a *agent.Agent, prompt string) (string, error) {
			return "Both workspaces modified shared.txt.", nil
		},
	})
	defer ResetDeps()

	var output string
	err := captureStdout(func() error {
		cmd := NewRootCmd()
		cmd.SetArgs([]string{"merge", "ws-source", "--dry-run", "--agent-summary"})
		return cmd.Execute()
	}, &output)
	if err != nil {
		t.Fatalf("merge dry-run failed: %v", err)
	}

	if !strings.Contains(output, "Merge plan") {
		t.Fatalf("expected merge plan in output, got:\n%s", output)
	}
	if !strings.Contains(output, "Conflicts") {
		t.Fatalf("expected conflict info in output, got:\n%s", output)
	}
	if !strings.Contains(output, "shared.txt") {
		t.Fatalf("expected shared.txt in conflicts, got:\n%s", output)
	}
}

func TestAgentInvokeSummaryIntegration(t *testing.T) {
	// Test the agent.InvokeSummary function directly with a mock invoke.
	mockInvoke := func(a *agent.Agent, prompt string) (string, error) {
		if !strings.Contains(prompt, "Summarize") {
			t.Fatalf("expected summary prompt, got: %s", prompt[:50])
		}
		return "Refactored authentication module for better security", nil
	}

	result, err := agent.InvokeSummary(mockAgent(), "Added auth.go\nModified login.go", mockInvoke)
	if err != nil {
		t.Fatalf("InvokeSummary failed: %v", err)
	}
	if result != "Refactored authentication module for better security" {
		t.Fatalf("unexpected summary: %q", result)
	}
}

func TestAgentInvokeMergeIntegration(t *testing.T) {
	// Test the agent.InvokeMerge function directly with a mock invoke.
	mockInvoke := func(a *agent.Agent, prompt string) (string, error) {
		return "• Combined both changes\n\n---MERGED CODE---\nmerged content here", nil
	}

	result, err := agent.InvokeMerge(mockAgent(), "base", "current", "source", "test.txt", mockInvoke)
	if err != nil {
		t.Fatalf("InvokeMerge failed: %v", err)
	}
	if result.MergedCode != "merged content here" {
		t.Fatalf("unexpected merged code: %q", result.MergedCode)
	}
	if len(result.Strategy) == 0 {
		t.Fatal("expected strategy bullets")
	}
	if result.Strategy[0] != "Combined both changes" {
		t.Fatalf("unexpected strategy: %q", result.Strategy[0])
	}
}

func TestAgentInvokeConflictSummaryIntegration(t *testing.T) {
	mockInvoke := func(a *agent.Agent, prompt string) (string, error) {
		return "Two files have overlapping edits in the auth module.", nil
	}

	result, err := agent.InvokeConflictSummary(mockAgent(), "- auth.go\n- login.go", mockInvoke)
	if err != nil {
		t.Fatalf("InvokeConflictSummary failed: %v", err)
	}
	if result != "Two files have overlapping edits in the auth module." {
		t.Fatalf("unexpected result: %q", result)
	}
}

func TestAgentInvokeDriftSummaryIntegration(t *testing.T) {
	mockInvoke := func(a *agent.Agent, prompt string) (string, error) {
		return "Medium risk: overlapping changes in shared modules.", nil
	}

	result, err := agent.InvokeDriftSummary(mockAgent(), "drift data here", mockInvoke)
	if err != nil {
		t.Fatalf("InvokeDriftSummary failed: %v", err)
	}
	if result != "Medium risk: overlapping changes in shared modules." {
		t.Fatalf("unexpected result: %q", result)
	}
}

func TestMergeAgentFallsBackToManualOnError(t *testing.T) {
	// Verify that when the agent fails, merge falls back to manual conflict markers.
	_, targetRoot, _ := setupProjectWithWorkspaces(t,
		map[string]string{"shared.txt": "target version"},
		map[string]string{"shared.txt": "source version"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return nil, &agentUnavailableError{}
		},
	})
	defer ResetDeps()

	// Should fall back to manual markers since agent is unavailable
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "ws-source", "--force"})
	err := cmd.Execute()
	// Merge with manual conflicts returns exit code 1
	if err != nil {
		if code := ExitCode(err); code != 1 {
			t.Fatalf("merge fallback failed unexpectedly: %v", err)
		}
	}

	// Check that conflict markers were written
	content, err := os.ReadFile(filepath.Join(targetRoot, "shared.txt"))
	if err != nil {
		t.Fatalf("read shared.txt: %v", err)
	}
	if !strings.Contains(string(content), "<<<<<<<") {
		t.Fatalf("expected conflict markers in fallback mode, got:\n%s", string(content))
	}
}

type agentUnavailableError struct{}

func (e *agentUnavailableError) Error() string {
	return "no coding agents detected"
}

// --- Real-agent opt-in tests (gated by FST_TEST_AGENT env var) ---

// clearNestedSessionEnv unsets environment variables that prevent coding agents
// from running inside another session (e.g., CLAUDECODE for Claude Code).
func clearNestedSessionEnv(t *testing.T) {
	t.Helper()
	for _, key := range []string{"CLAUDECODE", "CLAUDE_CODE"} {
		if v, ok := os.LookupEnv(key); ok {
			t.Cleanup(func() { os.Setenv(key, v) })
			os.Unsetenv(key)
		}
	}
}

func TestRealAgentMerge(t *testing.T) {
	agentName := os.Getenv("FST_TEST_AGENT")
	if agentName == "" {
		t.Skip("FST_TEST_AGENT not set - skipping real agent test")
	}

	// Verify the agent binary exists
	if _, err := exec.LookPath(agentName); err != nil {
		t.Skipf("Agent %q not found on PATH: %v", agentName, err)
	}

	clearNestedSessionEnv(t)

	_, targetRoot, _ := setupProjectWithWorkspaces(t,
		map[string]string{"shared.txt": "function hello() {\n  return 'hello from target'\n}\n"},
		map[string]string{"shared.txt": "function hello() {\n  return 'hello from source'\n}\n"},
	)

	restoreCwd := chdir(t, targetRoot)
	defer restoreCwd()

	// Use the real agent with the real Invoke function
	realAgent := &agent.Agent{
		Name:      agentName,
		Command:   agentName,
		Available: true,
	}
	// Set the path
	if p, err := exec.LookPath(agentName); err == nil {
		realAgent.Path = p
	}

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return realAgent, nil
		},
		AgentInvoke: agent.Invoke,
	})
	defer ResetDeps()

	cmd := NewRootCmd()
	cmd.SetArgs([]string{"merge", "ws-source", "--force"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("merge with real agent failed: %v", err)
	}

	// Validate structural correctness (not exact content).
	// The real agent may produce various valid merge strategies, including
	// inserting conflict markers for the user to choose. We only verify that
	// the merge command completed and produced a non-empty file.
	content, err := os.ReadFile(filepath.Join(targetRoot, "shared.txt"))
	if err != nil {
		t.Fatalf("read merged file: %v", err)
	}

	if len(strings.TrimSpace(string(content))) == 0 {
		t.Fatal("merged file is empty")
	}

	// Should contain something related to the original code
	if !strings.Contains(string(content), "hello") {
		t.Fatalf("merged content doesn't reference original code:\n%s", string(content))
	}

	t.Logf("Real agent merge result:\n%s", string(content))
}

func TestRealAgentSnapshotMessage(t *testing.T) {
	agentName := os.Getenv("FST_TEST_AGENT")
	if agentName == "" {
		t.Skip("FST_TEST_AGENT not set - skipping real agent test")
	}

	if _, err := exec.LookPath(agentName); err != nil {
		t.Skipf("Agent %q not found on PATH: %v", agentName, err)
	}

	clearNestedSessionEnv(t)

	root := setupWorkspace(t, "ws-real-snap", map[string]string{
		"main.go": "package main\nfunc main() {}\n",
	})

	restoreCwd := chdir(t, root)
	defer restoreCwd()

	cacheDir := filepath.Join(root, "cache")
	setenv(t, "XDG_CACHE_HOME", cacheDir)

	// Create initial snapshot
	SetDeps(Deps{})
	cmd := NewRootCmd()
	cmd.SetArgs([]string{"snapshot", "-m", "initial"})
	if err := cmd.Execute(); err != nil {
		t.Fatalf("initial snapshot failed: %v", err)
	}
	ResetDeps()

	// Add changes
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\n\nimport \"fmt\"\n\nfunc main() {\n\tfmt.Println(\"hello world\")\n}\n"), 0644); err != nil {
		t.Fatalf("write: %v", err)
	}

	realAgent := &agent.Agent{
		Name:      agentName,
		Command:   agentName,
		Available: true,
	}
	if p, err := exec.LookPath(agentName); err == nil {
		realAgent.Path = p
	}

	SetDeps(Deps{
		AgentGetPreferred: func() (*agent.Agent, error) {
			return realAgent, nil
		},
		AgentInvoke: agent.Invoke,
	})
	defer ResetDeps()

	cfg, err := config.LoadAt(root)
	if err != nil {
		t.Fatalf("LoadAt: %v", err)
	}

	summary, err := generateSnapshotSummary(root, cfg, realAgent, agent.Invoke)
	if err != nil {
		t.Fatalf("generateSnapshotSummary with real agent failed: %v", err)
	}

	// Validate structural correctness
	if len(strings.TrimSpace(summary)) == 0 {
		t.Fatal("real agent returned empty summary")
	}

	t.Logf("Real agent summary: %s", summary)
}

func TestRealAgentDriftSummary(t *testing.T) {
	agentName := os.Getenv("FST_TEST_AGENT")
	if agentName == "" {
		t.Skip("FST_TEST_AGENT not set - skipping real agent test")
	}

	if _, err := exec.LookPath(agentName); err != nil {
		t.Skipf("Agent %q not found on PATH: %v", agentName, err)
	}

	clearNestedSessionEnv(t)

	realAgent := &agent.Agent{
		Name:      agentName,
		Command:   agentName,
		Available: true,
	}
	if p, err := exec.LookPath(agentName); err == nil {
		realAgent.Path = p
	}

	driftContext := agent.BuildDriftContext(
		"ws-target", "ws-source",
		[]string{"auth.go", "middleware.go"}, []string{"config.go"}, nil,
		[]string{"auth.go", "api.go"}, nil, []string{"old_handler.go"},
		[]agent.FileConflictSummary{{Path: "auth.go", ConflictCount: 2}},
		nil,
	)

	result, err := agent.InvokeDriftSummary(realAgent, driftContext, agent.Invoke)
	if err != nil {
		t.Fatalf("InvokeDriftSummary with real agent failed: %v", err)
	}

	if len(strings.TrimSpace(result)) == 0 {
		t.Fatal("real agent returned empty drift summary")
	}

	t.Logf("Real agent drift summary: %s", result)
}

func TestRealAgentConflictSummary(t *testing.T) {
	agentName := os.Getenv("FST_TEST_AGENT")
	if agentName == "" {
		t.Skip("FST_TEST_AGENT not set - skipping real agent test")
	}

	if _, err := exec.LookPath(agentName); err != nil {
		t.Skipf("Agent %q not found on PATH: %v", agentName, err)
	}

	clearNestedSessionEnv(t)

	realAgent := &agent.Agent{
		Name:      agentName,
		Command:   agentName,
		Available: true,
	}
	if p, err := exec.LookPath(agentName); err == nil {
		realAgent.Path = p
	}

	conflictContext := agent.BuildConflictContext([]agent.ConflictInfo{
		{
			Path:      "auth.go",
			HunkCount: 1,
			Hunks: []agent.HunkInfo{
				{
					StartLine:      10,
					EndLine:        15,
					CurrentPreview: []string{"func authenticate(token string) bool {", "  return validateJWT(token)"},
					SourcePreview:  []string{"func authenticate(token string) (bool, error) {", "  return validateOAuth(token)"},
				},
			},
		},
	})

	result, err := agent.InvokeConflictSummary(realAgent, conflictContext, agent.Invoke)
	if err != nil {
		t.Fatalf("InvokeConflictSummary with real agent failed: %v", err)
	}

	if len(strings.TrimSpace(result)) == 0 {
		t.Fatal("real agent returned empty conflict summary")
	}

	t.Logf("Real agent conflict summary: %s", result)
}
