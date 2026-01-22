package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// Agent represents a detected coding agent
type Agent struct {
	Name        string `json:"name"`
	Command     string `json:"command"`
	Path        string `json:"path"`
	Description string `json:"description"`
	Available   bool   `json:"available"`
}

// KnownAgents lists all agents we know how to detect and invoke
var KnownAgents = []Agent{
	{
		Name:        "claude",
		Command:     "claude",
		Description: "Claude Code (Anthropic)",
	},
	{
		Name:        "aider",
		Command:     "aider",
		Description: "Aider - AI pair programming",
	},
	{
		Name:        "cursor",
		Command:     "cursor",
		Description: "Cursor IDE",
	},
	{
		Name:        "copilot",
		Command:     "gh copilot",
		Description: "GitHub Copilot CLI",
	},
}

// DetectAgents scans for installed coding agents
func DetectAgents() []Agent {
	var detected []Agent

	for _, agent := range KnownAgents {
		a := agent // copy
		// Check if command exists in PATH
		path, err := exec.LookPath(strings.Split(agent.Command, " ")[0])
		if err == nil {
			a.Path = path
			a.Available = true
		}
		detected = append(detected, a)
	}

	return detected
}

// GetAvailableAgents returns only agents that are installed
func GetAvailableAgents() []Agent {
	var available []Agent
	for _, a := range DetectAgents() {
		if a.Available {
			available = append(available, a)
		}
	}
	return available
}

// Config holds agent configuration
type Config struct {
	PreferredAgent string `json:"preferred_agent,omitempty"`
}

// GetConfigPath returns the path to the agent config file
func GetConfigPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "fst", "agents.json"), nil
}

// LoadConfig loads agent configuration
func LoadConfig() (*Config, error) {
	path, err := GetConfigPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &Config{}, nil
		}
		return nil, err
	}

	var config Config
	if err := json.Unmarshal(data, &config); err != nil {
		return nil, err
	}

	return &config, nil
}

// SaveConfig saves agent configuration
func SaveConfig(config *Config) error {
	path, err := GetConfigPath()
	if err != nil {
		return err
	}

	// Ensure directory exists
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

// GetPreferredAgent returns the preferred agent, or the first available one
func GetPreferredAgent() (*Agent, error) {
	config, err := LoadConfig()
	if err != nil {
		return nil, err
	}

	available := GetAvailableAgents()
	if len(available) == 0 {
		return nil, fmt.Errorf("no coding agents detected - install claude, aider, or another supported agent")
	}

	// If preferred is set and available, use it
	if config.PreferredAgent != "" {
		for _, a := range available {
			if a.Name == config.PreferredAgent {
				return &a, nil
			}
		}
	}

	// Otherwise return first available
	return &available[0], nil
}

// SetPreferredAgent sets the preferred agent
func SetPreferredAgent(name string) error {
	// Verify agent exists
	found := false
	for _, a := range KnownAgents {
		if a.Name == name {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("unknown agent: %s", name)
	}

	config, err := LoadConfig()
	if err != nil {
		config = &Config{}
	}

	config.PreferredAgent = name
	return SaveConfig(config)
}

// InvokeSummary invokes an agent to generate a summary of changes
func InvokeSummary(agent *Agent, diffContext string) (string, error) {
	prompt := fmt.Sprintf(`Summarize these code changes in 1-2 concise sentences. Focus on WHAT changed and WHY it matters, not listing files.

Changes:
%s

Summary:`, diffContext)

	return invokeAgent(agent, prompt)
}

// InvokeConflictSummary invokes an agent to summarize conflicts
func InvokeConflictSummary(agent *Agent, conflictContext string) (string, error) {
	prompt := fmt.Sprintf(`Summarize these git-style conflicts in 2-3 concise sentences. Describe what's conflicting and suggest resolution strategies.

Conflicts:
%s

Summary:`, conflictContext)

	return invokeAgent(agent, prompt)
}

// InvokeMerge invokes an agent to merge conflicting files
func InvokeMerge(agent *Agent, baseContent, localContent, remoteContent, filename string) (string, error) {
	prompt := fmt.Sprintf(`Merge these two versions of %s. Both diverged from a common base.

=== BASE VERSION ===
%s

=== LOCAL VERSION (keep this perspective) ===
%s

=== REMOTE VERSION (incorporate these changes) ===
%s

Output ONLY the merged file content, no explanations:`, filename, baseContent, localContent, remoteContent)

	return invokeAgent(agent, prompt)
}

// invokeAgent runs the agent with a prompt and returns the response
func invokeAgent(agent *Agent, prompt string) (string, error) {
	switch agent.Name {
	case "claude":
		return invokeClaude(prompt)
	case "aider":
		return invokeAider(prompt)
	default:
		return "", fmt.Errorf("agent %s invocation not implemented", agent.Name)
	}
}

// invokeClaude invokes Claude Code CLI
func invokeClaude(prompt string) (string, error) {
	// Claude Code CLI: claude -p "prompt"
	cmd := exec.Command("claude", "-p", prompt)
	cmd.Stdin = nil

	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("claude failed: %s", string(exitErr.Stderr))
		}
		return "", fmt.Errorf("failed to run claude: %w", err)
	}

	result := strings.TrimSpace(string(output))

	// Strip markdown code fences if present
	result = stripCodeFences(result)

	return result, nil
}

// stripCodeFences removes markdown code fence wrappers from text
func stripCodeFences(s string) string {
	lines := strings.Split(s, "\n")
	if len(lines) < 2 {
		return s
	}

	// Check if starts with code fence
	firstLine := strings.TrimSpace(lines[0])
	if !strings.HasPrefix(firstLine, "```") {
		return s
	}

	// Check if ends with code fence
	lastLine := strings.TrimSpace(lines[len(lines)-1])
	if lastLine != "```" {
		return s
	}

	// Remove first and last lines (the fences)
	return strings.Join(lines[1:len(lines)-1], "\n")
}

// invokeAider invokes Aider
func invokeAider(prompt string) (string, error) {
	// Aider can be invoked with --message for one-shot queries
	// Using --no-git to avoid git operations
	cmd := exec.Command("aider", "--no-git", "--message", prompt)
	cmd.Stdin = nil

	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("aider failed: %s", string(exitErr.Stderr))
		}
		return "", fmt.Errorf("failed to run aider: %w", err)
	}

	// Aider output needs parsing - extract the response
	return parseAiderOutput(string(output)), nil
}

// parseAiderOutput extracts the relevant response from Aider output
func parseAiderOutput(output string) string {
	// Aider has a lot of formatting - try to extract just the response
	lines := strings.Split(output, "\n")
	var result []string
	inResponse := false

	for _, line := range lines {
		// Skip aider UI elements
		if strings.HasPrefix(line, "Aider") || strings.HasPrefix(line, ">") || strings.HasPrefix(line, "─") {
			continue
		}
		if strings.TrimSpace(line) != "" {
			inResponse = true
		}
		if inResponse {
			result = append(result, line)
		}
	}

	return strings.TrimSpace(strings.Join(result, "\n"))
}

// InteractivePrompt sends a prompt and reads response interactively (for complex operations)
func InteractivePrompt(agent *Agent, prompt string) (string, error) {
	fmt.Printf("Invoking %s...\n", agent.Name)
	return invokeAgent(agent, prompt)
}

// BuildDiffContext creates a context string from drift report for LLM summarization
func BuildDiffContext(added, modified, deleted []string, fileContents map[string]string) string {
	var sb strings.Builder

	if len(added) > 0 {
		sb.WriteString("Added files:\n")
		for _, f := range added {
			sb.WriteString(fmt.Sprintf("  + %s\n", f))
			if content, ok := fileContents[f]; ok && len(content) < 2000 {
				sb.WriteString(fmt.Sprintf("    ```\n%s\n    ```\n", content))
			}
		}
	}

	if len(modified) > 0 {
		sb.WriteString("\nModified files:\n")
		for _, f := range modified {
			sb.WriteString(fmt.Sprintf("  ~ %s\n", f))
			if content, ok := fileContents[f]; ok && len(content) < 2000 {
				sb.WriteString(fmt.Sprintf("    ```\n%s\n    ```\n", content))
			}
		}
	}

	if len(deleted) > 0 {
		sb.WriteString("\nDeleted files:\n")
		for _, f := range deleted {
			sb.WriteString(fmt.Sprintf("  - %s\n", f))
		}
	}

	return sb.String()
}

// BuildConflictContext creates a context string from conflicts for LLM summarization
func BuildConflictContext(conflicts []ConflictInfo) string {
	var sb strings.Builder

	sb.WriteString(fmt.Sprintf("%d conflicting files:\n\n", len(conflicts)))

	for _, c := range conflicts {
		sb.WriteString(fmt.Sprintf("File: %s (%d conflicting regions)\n", c.Path, c.HunkCount))
		for i, h := range c.Hunks {
			sb.WriteString(fmt.Sprintf("  Conflict %d (lines %d-%d):\n", i+1, h.StartLine, h.EndLine))
			if len(h.LocalPreview) > 0 {
				sb.WriteString("    Local changes:\n")
				for _, line := range h.LocalPreview {
					sb.WriteString(fmt.Sprintf("      %s\n", line))
				}
			}
			if len(h.RemotePreview) > 0 {
				sb.WriteString("    Main changes:\n")
				for _, line := range h.RemotePreview {
					sb.WriteString(fmt.Sprintf("      %s\n", line))
				}
			}
		}
		sb.WriteString("\n")
	}

	return sb.String()
}

// ConflictInfo represents conflict data for LLM context
type ConflictInfo struct {
	Path      string
	HunkCount int
	Hunks     []HunkInfo
}

// HunkInfo represents a conflict hunk for LLM context
type HunkInfo struct {
	StartLine     int
	EndLine       int
	LocalPreview  []string
	RemotePreview []string
}

// ReadFileContent reads file content for diff context (with size limit)
func ReadFileContent(path string, maxSize int64) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}

	if info.Size() > maxSize {
		return fmt.Sprintf("[File too large: %d bytes]", info.Size()), nil
	}

	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	// Read first maxSize bytes
	scanner := bufio.NewScanner(file)
	var lines []string
	totalSize := int64(0)

	for scanner.Scan() {
		line := scanner.Text()
		totalSize += int64(len(line)) + 1
		if totalSize > maxSize {
			lines = append(lines, "[truncated...]")
			break
		}
		lines = append(lines, line)
	}

	return strings.Join(lines, "\n"), scanner.Err()
}
