package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/workspace"
	"github.com/charmbracelet/bubbles/textarea"
	tea "github.com/charmbracelet/bubbletea"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newSnapshotCmd()) })
}

func newSnapshotCmd() *cobra.Command {
	var message string
	var agentMessage bool

	cmd := &cobra.Command{
		Use:     "snapshot",
		Aliases: []string{"snap"},
		Short:   "Capture current state as a snapshot",
		Long: `Capture the current state of the project as an immutable snapshot.

This will:
1. Scan all files (respecting .fstignore)
2. Save the snapshot locally for rollback support
3. Optionally sync to cloud if authenticated
4. Update the workspace head to point to this snapshot

Use --agent-message to generate a description using your local coding agent.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSnapshot(message, agentMessage)
		},
	}

	cmd.Flags().StringVarP(&message, "message", "m", "", "Description for this snapshot")
	cmd.Flags().BoolVar(&agentMessage, "agent-message", false, "Generate description using local coding agent")

	return cmd
}

func runSnapshot(message string, agentMessage bool) error {
	ws, err := workspace.Open()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}
	defer ws.Close()

	if message != "" && agentMessage {
		return fmt.Errorf("cannot use --message with --agent-message")
	}
	if message == "" && !agentMessage {
		entered, err := promptSnapshotMessage("")
		if err != nil {
			return err
		}
		message = entered
	}

	// Resolve author identity (interactive — may prompt via TUI)
	author, err := resolveAuthor()
	if err != nil {
		return err
	}

	fmt.Println("Scanning files...")

	agentName := ""
	if agentMessage {
		preferredAgent, err := agent.GetPreferredAgent()
		if err != nil {
			return err
		}
		fmt.Println("Generating message...")
		summary, err := generateSnapshotSummary(ws.Root(), ws.Config(), preferredAgent)
		if err != nil {
			return fmt.Errorf("failed to generate message: %w", err)
		}
		message, err = promptSnapshotMessage(summary)
		if err != nil {
			return err
		}
		agentName = preferredAgent.Name
	}

	result, err := ws.Snapshot(workspace.SnapshotOpts{
		Message: message,
		Agent:   agentName,
		Author:  author,
	})
	if err != nil {
		return err
	}

	// Output result
	fmt.Printf("Found %d files (%s)\n", result.Files, formatBytesLong(result.Size))
	if result.BlobsCached > 0 {
		fmt.Printf("Cached %d new blobs.\n", result.BlobsCached)
	}
	fmt.Println()
	fmt.Println("✓ Snapshot created!")
	fmt.Println()
	fmt.Printf("  ID:       %s\n", result.SnapshotID)
	fmt.Printf("  Hash:     %s\n", result.ManifestHash[:16]+"...")
	fmt.Printf("  Files:    %d\n", result.Files)
	fmt.Printf("  Size:     %s\n", formatBytesLong(result.Size))
	if agentName != "" {
		fmt.Printf("  Agent:    %s\n", agentName)
	}
	if message != "" {
		fmt.Printf("  Message:  %s\n", message)
	}
	if ws.BaseSnapshotID() != "" {
		fmt.Printf("  Base:     %s\n", ws.BaseSnapshotID())
	}
	fmt.Println("  (local only - not synced to cloud)")

	return nil
}

func promptSnapshotMessage(summary string) (string, error) {
	m := newSnapshotMessageModel(summary)
	p := tea.NewProgram(m)
	final, err := p.Run()
	if err != nil {
		return "", err
	}
	model, ok := final.(snapshotMessageModel)
	if !ok {
		return "", fmt.Errorf("failed to read snapshot message")
	}
	if model.err != nil {
		return "", model.err
	}
	return strings.TrimSpace(model.input.Value()), nil
}

type snapshotMessageModel struct {
	input textarea.Model
	err   error
	done  bool
}

func newSnapshotMessageModel(initial string) snapshotMessageModel {
	input := textarea.New()
	input.SetValue(initial)
	input.Focus()
	input.Prompt = "> "
	input.ShowLineNumbers = false
	input.CharLimit = 1000
	input.SetWidth(80)
	input.SetHeight(6)
	return snapshotMessageModel{input: input}
}

func (m snapshotMessageModel) Init() tea.Cmd {
	return textarea.Blink
}

func (m snapshotMessageModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.err = fmt.Errorf("snapshot cancelled")
			m.done = true
			return m, tea.Quit
		case tea.KeyCtrlS:
			if strings.TrimSpace(m.input.Value()) == "" {
				m.err = fmt.Errorf("message cannot be empty")
				return m, nil
			}
			m.done = true
			return m, tea.Quit
		}
	}

	var cmd tea.Cmd
	m.input, cmd = m.input.Update(msg)
	return m, cmd
}

func (m snapshotMessageModel) View() string {
	if m.done {
		return ""
	}
	var b strings.Builder
	b.WriteString("Edit snapshot message (Ctrl+S to save, Ctrl+C to cancel):\n")
	b.WriteString(m.input.View())
	if m.err != nil {
		b.WriteString("\n")
		b.WriteString(m.err.Error())
	}
	b.WriteString("\n")
	b.WriteString("Ctrl+S to save, Ctrl+C to cancel")
	return b.String()
}

// CreateAutoSnapshot creates a snapshot silently (for use before merge/destructive operations).
// Returns the snapshot ID or empty string if no changes since the current snapshot.
func CreateAutoSnapshot(message string) (string, error) {
	ws, err := workspace.Open()
	if err != nil {
		return "", fmt.Errorf("not in a workspace directory")
	}
	defer ws.Close()

	return ws.AutoSnapshot(message)
}

// generateSnapshotSummary uses the coding agent to describe changes
func generateSnapshotSummary(root string, cfg *config.ProjectConfig, preferredAgent *agent.Agent) (string, error) {
	if preferredAgent == nil {
		return "", fmt.Errorf("no agent available")
	}

	// Compute changes since latest snapshot
	report, err := drift.ComputeFromLatestSnapshot(root)
	if err != nil {
		return "", fmt.Errorf("failed to compute changes: %w", err)
	}

	// If no changes, return simple message
	if !report.HasChanges() {
		return "No changes since last snapshot", nil
	}

	fmt.Printf("Using %s to generate message...\n", preferredAgent.Name)

	// Build context with file contents
	fileContents := make(map[string]string)
	for _, f := range report.FilesAdded {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}
	for _, f := range report.FilesModified {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}

	diffContext := agent.BuildDiffContext(
		report.FilesAdded,
		report.FilesModified,
		report.FilesDeleted,
		fileContents,
	)

	// Invoke agent for summary
	summary, err := agent.InvokeSummary(preferredAgent, diffContext)
	if err != nil {
		return "", err
	}

	return summary, nil
}

func uploadSnapshotToCloud(client *api.Client, root string, m *manifest.Manifest, manifestHash string, manifestJSON []byte) error {
	if len(m.FileEntries()) == 0 {
		return client.UploadManifest(manifestHash, manifestJSON)
	}

	hashToPath := make(map[string]string)
	hashes := make([]string, 0, len(m.FileEntries()))
	for _, f := range m.FileEntries() {
		if _, exists := hashToPath[f.Hash]; !exists {
			hashToPath[f.Hash] = f.Path
			hashes = append(hashes, f.Hash)
		}
	}

	missing := []string{}
	for i := 0; i < len(hashes); i += 100 {
		end := i + 100
		if end > len(hashes) {
			end = len(hashes)
		}
		batchMissing, err := client.BlobExists(hashes[i:end])
		if err != nil {
			return err
		}
		missing = append(missing, batchMissing...)
	}

	if len(missing) > 0 {
		for i := 0; i < len(missing); i += 100 {
			end := i + 100
			if end > len(missing) {
				end = len(missing)
			}
			urls, err := client.PresignUpload(missing[i:end])
			if err != nil {
				return err
			}
			for _, hash := range missing[i:end] {
				path, ok := hashToPath[hash]
				if !ok {
					continue
				}
				url, ok := urls[hash]
				if !ok || url == "" {
					return fmt.Errorf("missing upload URL for blob %s", hash)
				}
				content, err := os.ReadFile(filepath.Join(root, path))
				if err != nil {
					return fmt.Errorf("failed to read %s: %w", path, err)
				}
				if err := client.UploadBlob(url, content); err != nil {
					return err
				}
			}
		}
	}

	return client.UploadManifest(manifestHash, manifestJSON)
}

// escapeJSON escapes a string for JSON
func escapeJSON(s string) string {
	result := ""
	for _, c := range s {
		switch c {
		case '"':
			result += `\"`
		case '\\':
			result += `\\`
		case '\n':
			result += `\n`
		case '\r':
			result += `\r`
		case '\t':
			result += `\t`
		default:
			result += string(c)
		}
	}
	return result
}


func formatBytesLong(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	fb := float64(bytes)
	for fb >= k && i < len(sizes)-1 {
		fb /= k
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", bytes, sizes[i])
	}
	return fmt.Sprintf("%.2f %s", fb, sizes[i])
}
