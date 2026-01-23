package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/sahilm/fuzzy"
	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	rootCmd.AddCommand(newSearchCmd())
}

func newSearchCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "search",
		Short: "Interactive search across projects and workspaces",
		Long: `Open an interactive TUI to search and navigate across all projects and workspaces.

Features:
- Fuzzy search by project or workspace name
- See drift status, agent, and last activity at a glance
- Quick actions: open, merge, status, diff

Keyboard shortcuts:
  ↑/↓ or j/k    Navigate list
  Enter         Open workspace (prints cd command)
  m             Merge into current workspace (same project only)
  s             Show detailed status
  d             Show diff
  o             Open in editor
  q or Esc      Quit`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSearch()
		},
	}

	return cmd
}

// workspaceItem represents a workspace in the search list
type workspaceItem struct {
	ProjectID     string
	ProjectName   string
	WorkspaceID   string
	WorkspaceName string
	Path          string
	Added         int
	Modified      int
	Deleted       int
	Agent         string
	LastActivity  time.Time
	IsCurrent     bool
	SameProject   bool // same project as current workspace
}

// String returns the searchable string for fuzzy matching
func (w workspaceItem) String() string {
	return fmt.Sprintf("%s %s %s", w.ProjectName, w.WorkspaceName, w.Agent)
}

// model is the Bubble Tea model
type model struct {
	textInput      textinput.Model
	items          []workspaceItem
	filtered       []workspaceItem
	cursor         int
	currentProject string
	currentWsName  string
	width          int
	height         int
	err            error
	action         string // action to perform after quit
	actionTarget   *workspaceItem
}

// Styles
var (
	titleStyle = lipgloss.NewStyle().
			Bold(true).
			Foreground(lipgloss.Color("205"))

	selectedStyle = lipgloss.NewStyle().
			Background(lipgloss.Color("236")).
			Foreground(lipgloss.Color("255"))

	projectStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("39"))

	workspaceStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("255")).
			Bold(true)

	addedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("82"))

	modifiedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("214"))

	deletedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("196"))

	agentStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("81"))

	timeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("242"))

	currentStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("82")).
			Bold(true)

	mergeableStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("82"))

	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color("242"))

	statusBarStyle = lipgloss.NewStyle().
			Background(lipgloss.Color("236")).
			Padding(0, 1)
)

func initialModel() model {
	ti := textinput.New()
	ti.Placeholder = "Search projects and workspaces..."
	ti.Focus()
	ti.CharLimit = 100
	ti.Width = 50

	m := model{
		textInput: ti,
		cursor:    0,
	}

	// Load current workspace info
	if cfg, err := config.Load(); err == nil {
		m.currentProject = cfg.ProjectID
		m.currentWsName = cfg.WorkspaceName
	}

	// Load all workspaces
	m.items = loadAllWorkspaces(m.currentProject)
	m.filtered = m.items

	return m
}

func loadAllWorkspaces(currentProjectID string) []workspaceItem {
	var items []workspaceItem

	registry, err := LoadRegistry()
	if err != nil {
		return items
	}

	// Group by project for better display
	projectNames := make(map[string]string) // projectID -> name (use first workspace's project)

	for _, ws := range registry.Workspaces {
		// Check if workspace still exists
		if _, err := os.Stat(filepath.Join(ws.Path, ".fst")); os.IsNotExist(err) {
			continue
		}

		item := workspaceItem{
			ProjectID:     ws.ProjectID,
			WorkspaceID:   ws.ID,
			WorkspaceName: ws.Name,
			Path:          ws.Path,
			SameProject:   ws.ProjectID == currentProjectID,
		}

		// Try to get project name from workspace config
		if _, err := config.LoadAt(ws.Path); err == nil {
			if projectNames[ws.ProjectID] == "" {
				// Use directory name as project name
				projectNames[ws.ProjectID] = filepath.Base(filepath.Dir(ws.Path))
			}
		}

		// Get drift info
		if changes, err := getWorkspaceChanges(ws); err == nil {
			item.Added = len(changes.FilesAdded)
			item.Modified = len(changes.FilesModified)
			item.Deleted = len(changes.FilesDeleted)
		}

		// Get agent and last activity from most recent snapshot
		snapshotsDir := config.GetSnapshotsDirAt(ws.Path)
		if entries, err := os.ReadDir(snapshotsDir); err == nil {
			var latestTime time.Time
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".meta.json") {
					metaPath := filepath.Join(snapshotsDir, entry.Name())
					if data, err := os.ReadFile(metaPath); err == nil {
						var meta SnapshotMeta
						if json.Unmarshal(data, &meta) == nil {
							if t, err := time.Parse(time.RFC3339, meta.CreatedAt); err == nil {
								if t.After(latestTime) {
									latestTime = t
									item.Agent = meta.Agent
									item.LastActivity = t
								}
							}
						}
					}
				}
			}
		}

		// Check if this is the current workspace
		if cwd, err := os.Getwd(); err == nil {
			if absPath, err := filepath.Abs(ws.Path); err == nil {
				if absCwd, err := filepath.Abs(cwd); err == nil {
					// Check if cwd is within this workspace
					if strings.HasPrefix(absCwd, absPath) || absCwd == absPath {
						item.IsCurrent = true
					}
				}
			}
		}

		items = append(items, item)
	}

	// Set project names
	for i := range items {
		if name, ok := projectNames[items[i].ProjectID]; ok {
			items[i].ProjectName = name
		} else {
			// Use shortened project ID
			items[i].ProjectName = items[i].ProjectID
			if len(items[i].ProjectName) > 12 {
				items[i].ProjectName = items[i].ProjectName[:12]
			}
		}
	}

	// Sort: current project first, then by last activity
	sort.Slice(items, func(i, j int) bool {
		if items[i].SameProject != items[j].SameProject {
			return items[i].SameProject
		}
		return items[i].LastActivity.After(items[j].LastActivity)
	})

	return items
}

func (m model) Init() tea.Cmd {
	return textinput.Blink
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c", "q", "esc":
			return m, tea.Quit

		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}

		case "down", "j":
			if m.cursor < len(m.filtered)-1 {
				m.cursor++
			}

		case "enter":
			if len(m.filtered) > 0 {
				m.action = "open"
				m.actionTarget = &m.filtered[m.cursor]
				return m, tea.Quit
			}

		case "m":
			if len(m.filtered) > 0 {
				item := &m.filtered[m.cursor]
				if item.SameProject && !item.IsCurrent {
					m.action = "merge"
					m.actionTarget = item
					return m, tea.Quit
				}
			}

		case "s":
			if len(m.filtered) > 0 {
				m.action = "status"
				m.actionTarget = &m.filtered[m.cursor]
				return m, tea.Quit
			}

		case "d":
			if len(m.filtered) > 0 {
				m.action = "diff"
				m.actionTarget = &m.filtered[m.cursor]
				return m, tea.Quit
			}

		case "o":
			if len(m.filtered) > 0 {
				m.action = "editor"
				m.actionTarget = &m.filtered[m.cursor]
				return m, tea.Quit
			}
		}

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.textInput.Width = msg.Width - 4
	}

	// Handle text input
	var cmd tea.Cmd
	m.textInput, cmd = m.textInput.Update(msg)

	// Filter items based on search
	m.filterItems()

	return m, cmd
}

func (m *model) filterItems() {
	query := m.textInput.Value()
	if query == "" {
		m.filtered = m.items
		return
	}

	// Convert items to strings for fuzzy matching
	var strs []string
	for _, item := range m.items {
		strs = append(strs, item.String())
	}

	matches := fuzzy.Find(query, strs)
	m.filtered = make([]workspaceItem, len(matches))
	for i, match := range matches {
		m.filtered[i] = m.items[match.Index]
	}

	// Reset cursor if out of bounds
	if m.cursor >= len(m.filtered) {
		m.cursor = max(0, len(m.filtered)-1)
	}
}

func (m model) View() string {
	var b strings.Builder

	// Title
	b.WriteString(titleStyle.Render("fst search"))
	b.WriteString("\n\n")

	// Search input
	b.WriteString(m.textInput.View())
	b.WriteString("\n\n")

	// Current workspace indicator
	if m.currentWsName != "" {
		b.WriteString(fmt.Sprintf("Current: %s\n\n", currentStyle.Render(m.currentWsName)))
	}

	// List items
	listHeight := m.height - 12 // Reserve space for header, input, footer
	if listHeight < 5 {
		listHeight = 5
	}

	start := 0
	if m.cursor >= listHeight {
		start = m.cursor - listHeight + 1
	}

	end := start + listHeight
	if end > len(m.filtered) {
		end = len(m.filtered)
	}

	if len(m.filtered) == 0 {
		b.WriteString(helpStyle.Render("  No workspaces found\n"))
	}

	for i := start; i < end; i++ {
		item := m.filtered[i]
		line := m.renderItem(item, i == m.cursor)
		b.WriteString(line)
		b.WriteString("\n")
	}

	// Padding
	for i := end - start; i < listHeight; i++ {
		b.WriteString("\n")
	}

	// Status bar
	b.WriteString("\n")
	statusLine := m.renderStatusBar()
	b.WriteString(statusLine)

	// Help
	b.WriteString("\n")
	helpLine := helpStyle.Render("↑↓ navigate  enter open  m merge  s status  d diff  o editor  q quit")
	b.WriteString(helpLine)

	return b.String()
}

func (m model) renderItem(item workspaceItem, selected bool) string {
	var parts []string

	// Cursor/current indicator
	indicator := "  "
	if item.IsCurrent {
		indicator = "▸ "
	} else if selected {
		indicator = "> "
	}

	// Project / Workspace
	projectPart := projectStyle.Render(item.ProjectName)
	workspacePart := workspaceStyle.Render(item.WorkspaceName)
	namePart := fmt.Sprintf("%s / %s", projectPart, workspacePart)

	// Pad name to fixed width
	nameWidth := 35
	nameLen := len(item.ProjectName) + 3 + len(item.WorkspaceName)
	if nameLen < nameWidth {
		namePart += strings.Repeat(" ", nameWidth-nameLen)
	}

	parts = append(parts, indicator+namePart)

	// Drift status
	if item.Added > 0 || item.Modified > 0 || item.Deleted > 0 {
		drift := ""
		if item.Added > 0 {
			drift += addedStyle.Render(fmt.Sprintf("+%d", item.Added)) + " "
		}
		if item.Modified > 0 {
			drift += modifiedStyle.Render(fmt.Sprintf("~%d", item.Modified)) + " "
		}
		if item.Deleted > 0 {
			drift += deletedStyle.Render(fmt.Sprintf("-%d", item.Deleted))
		}
		parts = append(parts, strings.TrimSpace(drift))
	} else {
		parts = append(parts, helpStyle.Render("clean"))
	}

	// Agent
	if item.Agent != "" {
		parts = append(parts, agentStyle.Render(fmt.Sprintf("[%s]", item.Agent)))
	}

	// Last activity
	if !item.LastActivity.IsZero() {
		timeAgo := formatTimeAgo(item.LastActivity)
		parts = append(parts, timeStyle.Render(timeAgo))
	}

	// Mergeable indicator
	if item.SameProject && !item.IsCurrent {
		parts = append(parts, mergeableStyle.Render("●"))
	}

	line := strings.Join(parts, "  ")

	if selected {
		line = selectedStyle.Render(line)
	}

	return line
}

func (m model) renderStatusBar() string {
	total := len(m.items)
	filtered := len(m.filtered)

	var status string
	if filtered == total {
		status = fmt.Sprintf("%d workspaces", total)
	} else {
		status = fmt.Sprintf("%d / %d workspaces", filtered, total)
	}

	if m.cursor < len(m.filtered) {
		item := m.filtered[m.cursor]
		if !item.SameProject {
			status += "  (different project - merge disabled)"
		} else if item.IsCurrent {
			status += "  (current workspace)"
		}
	}

	return statusBarStyle.Render(status)
}

func runSearch() error {
	p := tea.NewProgram(initialModel(), tea.WithAltScreen())
	finalModel, err := p.Run()
	if err != nil {
		return fmt.Errorf("error running search: %w", err)
	}

	m := finalModel.(model)

	// Handle action after TUI exits
	if m.actionTarget != nil {
		switch m.action {
		case "open":
			// Print cd command for user to copy/execute
			fmt.Printf("cd %s\n", m.actionTarget.Path)

		case "merge":
			fmt.Printf("Merging %s...\n\n", m.actionTarget.WorkspaceName)
			return runMerge(m.actionTarget.WorkspaceName, "", ConflictModeAgent, nil, false, false, false)

		case "status":
			// Change to workspace dir and run status
			originalDir, _ := os.Getwd()
			if err := os.Chdir(m.actionTarget.Path); err != nil {
				return fmt.Errorf("failed to change to workspace: %w", err)
			}
			err := runStatus(false)
			os.Chdir(originalDir)
			return err

		case "diff":
			// Show drift for the workspace
			originalDir, _ := os.Getwd()
			if err := os.Chdir(m.actionTarget.Path); err != nil {
				return fmt.Errorf("failed to change to workspace: %w", err)
			}
			err := runDrift("", false, false, false, false)
			os.Chdir(originalDir)
			return err

		case "editor":
			// Try to open in editor
			editor := os.Getenv("EDITOR")
			if editor == "" {
				editor = "code" // default to VS Code
			}
			fmt.Printf("%s %s\n", editor, m.actionTarget.Path)
		}
	}

	return nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
