package agent

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"golang.org/x/term"
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
		Name:        "codex",
		Command:     "codex",
		Description: "OpenAI Codex CLI",
	},
	{
		Name:        "amp",
		Command:     "amp",
		Description: "Amp CLI",
	},
	{
		Name:        "agent",
		Command:     "agent",
		Description: "Cursor Agent CLI",
	},
	{
		Name:        "gemini",
		Command:     "gemini",
		Description: "Gemini CLI",
	},
	{
		Name:        "droid",
		Command:     "droid",
		Description: "Factory Droid CLI",
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
		return nil, fmt.Errorf("no coding agents detected - install a supported agent or set one with 'fst agents set <name>'")
	}

	// If preferred is set and available, use it
	if config.PreferredAgent != "" {
		for _, a := range available {
			if a.Name == config.PreferredAgent {
				return &a, nil
			}
		}
	}

	if len(available) == 1 {
		return &available[0], nil
	}

	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return nil, fmt.Errorf("multiple coding agents detected - set preferred with 'fst agents set <name>'")
	}

	chosen, err := PromptAgentChoice(available)
	if err != nil {
		return nil, err
	}

	return &chosen, nil
}

// SetPreferredAgent sets the preferred agent
func SetPreferredAgent(name string) error {
	if name == "" {
		return fmt.Errorf("agent name is required")
	}

	available := GetAvailableAgents()
	found := false
	for _, a := range available {
		if a.Name == name {
			found = true
			break
		}
	}
	if !found {
		return fmt.Errorf("agent %s is not installed or not on PATH", name)
	}

	config, err := LoadConfig()
	if err != nil {
		config = &Config{}
	}

	config.PreferredAgent = name
	return SaveConfig(config)
}

func PromptAgentChoice(available []Agent) (Agent, error) {
	model := agentChoiceModel{
		agents: available,
	}
	p := tea.NewProgram(model)
	final, err := p.Run()
	if err != nil {
		return Agent{}, err
	}
	m, ok := final.(agentChoiceModel)
	if !ok {
		return Agent{}, fmt.Errorf("failed to read agent choice")
	}
	if m.err != nil {
		return Agent{}, m.err
	}
	if m.choice == nil {
		return Agent{}, fmt.Errorf("no agent selected")
	}
	return *m.choice, nil
}

type agentChoiceModel struct {
	agents []Agent
	cursor int
	choice *Agent
	err    error
	done   bool
}

func (m agentChoiceModel) Init() tea.Cmd {
	return nil
}

func (m agentChoiceModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.err = fmt.Errorf("selection cancelled")
			m.done = true
			return m, tea.Quit
		case tea.KeyUp:
			if m.cursor > 0 {
				m.cursor--
			}
		case tea.KeyDown:
			if m.cursor < len(m.agents)-1 {
				m.cursor++
			}
		case tea.KeyEnter:
			if len(m.agents) == 0 {
				m.err = fmt.Errorf("no agents available")
				m.done = true
				return m, tea.Quit
			}
			m.choice = &m.agents[m.cursor]
			m.done = true
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m agentChoiceModel) View() string {
	if m.done {
		return ""
	}
	var b strings.Builder
	b.WriteString("Multiple coding agents detected. Choose one:\n\n")
	for i, a := range m.agents {
		cursor := " "
		if m.cursor == i {
			cursor = ">"
		}
		b.WriteString(fmt.Sprintf(" %s %s\n", cursor, a.Name))
	}
	b.WriteString("\nUse \u2191/\u2193 and Enter to select. Ctrl+C to cancel.\n")
	return b.String()
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

// MergeResult contains the agent's merge output
type MergeResult struct {
	Strategy   []string // Bullet points explaining merge decisions
	MergedCode string   // The merged file content
}

// InvokeMerge invokes an agent to merge conflicting files
func InvokeMerge(agent *Agent, baseContent, currentContent, sourceContent, filename string) (*MergeResult, error) {
	prompt := fmt.Sprintf(`Merge these two versions of %s. Both diverged from a common base.

=== BASE VERSION (common ancestor) ===
%s

=== CURRENT VERSION (the workspace we're merging into) ===
%s

=== SOURCE VERSION (the workspace we're merging from) ===
%s

First, briefly explain your merge strategy (2-3 bullet points starting with "• ").
Then output the merged code after a line containing only "---MERGED CODE---".

Example format:
• Kept X from current because...
• Added Y from source because...
• Combined Z by...

---MERGED CODE---
<merged file content here>`, filename, baseContent, currentContent, sourceContent)

	output, err := invokeAgent(agent, prompt)
	if err != nil {
		return nil, err
	}

	return parseMergeOutput(output)
}

// parseMergeOutput separates strategy bullets from merged code
func parseMergeOutput(output string) (*MergeResult, error) {
	// Look for the separator
	separator := "---MERGED CODE---"
	parts := strings.SplitN(output, separator, 2)

	result := &MergeResult{}

	if len(parts) == 2 {
		// Parse strategy bullets
		strategyPart := strings.TrimSpace(parts[0])
		for _, line := range strings.Split(strategyPart, "\n") {
			line = strings.TrimSpace(line)
			if strings.HasPrefix(line, "•") || strings.HasPrefix(line, "-") || strings.HasPrefix(line, "*") {
				// Clean up the bullet point
				line = strings.TrimPrefix(line, "•")
				line = strings.TrimPrefix(line, "-")
				line = strings.TrimPrefix(line, "*")
				line = strings.TrimSpace(line)
				if line != "" {
					result.Strategy = append(result.Strategy, line)
				}
			}
		}

		// Get merged code
		result.MergedCode = strings.TrimSpace(parts[1])
		// Strip code fences if present
		result.MergedCode = stripCodeFences(result.MergedCode)
	} else {
		// No separator found - treat entire output as code (fallback)
		result.MergedCode = stripCodeFences(strings.TrimSpace(output))
		result.Strategy = []string{"Agent did not provide merge strategy"}
	}

	if result.MergedCode == "" {
		return nil, fmt.Errorf("agent returned empty merged code")
	}

	return result, nil
}

// invokeAgent runs the agent with a prompt and returns the response
func invokeAgent(agent *Agent, prompt string) (string, error) {
	switch agent.Name {
	case "claude":
		return invokeClaude(prompt)
	case "codex":
		return invokeCodex(prompt)
	case "amp":
		return invokeAmp(prompt)
	case "agent":
		return invokeCursorAgent(prompt)
	case "gemini":
		return invokeGemini(prompt)
	case "droid":
		return invokeDroid(prompt)
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

func invokeCodex(prompt string) (string, error) {
	// Codex CLI: codex exec "prompt"
	cmd := exec.Command("codex", "exec", prompt)
	cmd.Stdin = nil
	return runAgentCommand(cmd, "codex")
}

func invokeAmp(prompt string) (string, error) {
	// Amp CLI: amp -x "prompt"
	cmd := exec.Command("amp", "-x", prompt)
	cmd.Stdin = nil
	return runAgentCommand(cmd, "amp")
}

func invokeCursorAgent(prompt string) (string, error) {
	// Cursor Agent CLI: agent -p "prompt"
	cmd := exec.Command("agent", "-p", prompt)
	cmd.Stdin = nil
	return runAgentCommand(cmd, "agent")
}

func invokeGemini(prompt string) (string, error) {
	// Gemini CLI: gemini -p "prompt"
	cmd := exec.Command("gemini", "-p", prompt)
	cmd.Stdin = nil
	return runAgentCommand(cmd, "gemini")
}

func invokeDroid(prompt string) (string, error) {
	// Factory Droid CLI: droid exec "prompt"
	cmd := exec.Command("droid", "exec", prompt)
	cmd.Stdin = nil
	return runAgentCommand(cmd, "droid")
}

func runAgentCommand(cmd *exec.Cmd, name string) (string, error) {
	output, err := cmd.Output()
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			return "", fmt.Errorf("%s failed: %s", name, string(exitErr.Stderr))
		}
		return "", fmt.Errorf("failed to run %s: %w", name, err)
	}

	result := strings.TrimSpace(string(output))
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
			if len(h.CurrentPreview) > 0 {
				sb.WriteString("    Current workspace:\n")
				for _, line := range h.CurrentPreview {
					sb.WriteString(fmt.Sprintf("      %s\n", line))
				}
			}
			if len(h.SourcePreview) > 0 {
				sb.WriteString("    Source workspace:\n")
				for _, line := range h.SourcePreview {
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
	StartLine      int
	EndLine        int
	CurrentPreview []string
	SourcePreview  []string
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
