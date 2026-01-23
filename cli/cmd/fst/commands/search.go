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
- Split view with preview pane showing drift status and file changes
- Quick actions: open, merge, open in editor

Keyboard shortcuts:
  ↑/↓ or j/k    Navigate list
  Enter         Open workspace (prints cd command)
  m             Merge into current workspace (same project only)
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
	AddedFiles    []string
	ModifiedFiles []string
	DeletedFiles  []string
	Agent         string
	LastActivity  time.Time
	IsCurrent     bool
	SameProject   bool // same project as current workspace
}

// String returns the searchable string for fuzzy matching
func (w workspaceItem) String() string {
	return fmt.Sprintf("%s %s %s", w.ProjectName, w.WorkspaceName, w.Agent)
}

// mergeResultInfo holds the result of a merge operation for display
type mergeResultInfo struct {
	workspaceName string
	success       bool
	applied       int
	conflicts     int
	failed        int
	errorMsg      string
}

// model is the Bubble Tea model
type model struct {
	textInput      textinput.Model
	items          []workspaceItem
	filtered       []workspaceItem
	cursor         int
	currentProject string
	currentWsName  string
	inWorkspace    bool // true if fst search was run from inside a workspace
	width          int
	height         int
	err            error
	action         string // action to perform after quit
	actionTarget   *workspaceItem
	showOverlay    bool            // true when showing merge result overlay
	mergeResult    *mergeResultInfo // result to display in overlay
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
		m.inWorkspace = true
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
			item.AddedFiles = changes.FilesAdded
			item.ModifiedFiles = changes.FilesModified
			item.DeletedFiles = changes.FilesDeleted
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

// mergeCompleteMsg is sent when a merge operation completes
type mergeCompleteMsg struct {
	result *mergeResultInfo
}

// refreshMsg triggers a refresh of the workspace list
type refreshMsg struct{}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case mergeCompleteMsg:
		m.mergeResult = msg.result
		m.showOverlay = true
		return m, nil

	case refreshMsg:
		m.items = loadAllWorkspaces(m.currentProject)
		m.filterItems()
		return m, nil

	case tea.KeyMsg:
		// If overlay is showing, any key dismisses it
		if m.showOverlay {
			m.showOverlay = false
			m.mergeResult = nil
			// Refresh the list after dismissing
			return m, func() tea.Msg { return refreshMsg{} }
		}

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
			if m.inWorkspace && len(m.filtered) > 0 {
				item := &m.filtered[m.cursor]
				if item.SameProject && !item.IsCurrent {
					// Run merge and show result in overlay
					return m, m.doMerge(item)
				}
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

	// Handle text input (only if overlay not showing)
	if !m.showOverlay {
		var cmd tea.Cmd
		m.textInput, cmd = m.textInput.Update(msg)
		m.filterItems()
		return m, cmd
	}

	return m, nil
}

// doMerge performs the merge operation and returns a command that sends the result
func (m model) doMerge(item *workspaceItem) tea.Cmd {
	return func() tea.Msg {
		result := &mergeResultInfo{
			workspaceName: item.WorkspaceName,
		}

		// Capture merge by running it and tracking results
		// We need to run the merge logic but capture the outcome
		err := runMergeForUI(item.WorkspaceName, item.Path)
		if err != nil {
			result.success = false
			result.errorMsg = err.Error()
		} else {
			result.success = true
			// For now, we don't have detailed counts from runMerge
			// We could enhance this later
			result.applied = item.Added + item.Modified
		}

		return mergeCompleteMsg{result: result}
	}
}

// runMergeForUI runs merge silently and returns error status
func runMergeForUI(workspaceName, workspacePath string) error {
	// Run merge with auto-snapshot, agent mode for conflicts
	return runMerge(workspaceName, "", ConflictModeAgent, nil, false, false, false)
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
	// Show overlay if merge result is pending
	if m.showOverlay && m.mergeResult != nil {
		return m.renderOverlay()
	}

	// Calculate layout dimensions
	leftWidth := 45
	rightWidth := m.width - leftWidth - 3 // 3 for border
	if rightWidth < 30 {
		rightWidth = 30
	}
	if m.width < 80 {
		// Fallback to single column on narrow terminals
		return m.viewSingleColumn()
	}

	listHeight := m.height - 8 // Reserve space for header, input, footer
	if listHeight < 5 {
		listHeight = 5
	}

	// Build left pane (search + list)
	leftPane := m.buildLeftPane(leftWidth, listHeight)

	// Build right pane (preview)
	rightPane := m.buildPreviewPane(rightWidth, listHeight)

	// Join panes side by side
	leftLines := strings.Split(leftPane, "\n")
	rightLines := strings.Split(rightPane, "\n")

	// Ensure same number of lines
	maxLines := max(len(leftLines), len(rightLines))
	for len(leftLines) < maxLines {
		leftLines = append(leftLines, strings.Repeat(" ", leftWidth))
	}
	for len(rightLines) < maxLines {
		rightLines = append(rightLines, "")
	}

	var b strings.Builder
	borderStyle := lipgloss.NewStyle().Foreground(lipgloss.Color("238"))
	border := borderStyle.Render("│")

	for i := 0; i < maxLines; i++ {
		left := leftLines[i]
		right := rightLines[i]

		// Pad left to fixed width
		leftRunes := []rune(stripAnsi(left))
		if len(leftRunes) < leftWidth {
			left += strings.Repeat(" ", leftWidth-len(leftRunes))
		}

		b.WriteString(left)
		b.WriteString(" ")
		b.WriteString(border)
		b.WriteString(" ")
		b.WriteString(right)
		b.WriteString("\n")
	}

	// Help bar
	b.WriteString("\n")
	var helpLine string
	if m.inWorkspace {
		helpLine = helpStyle.Render("↑↓ navigate  enter open  m merge  o editor  q quit")
	} else {
		helpLine = helpStyle.Render("↑↓ navigate  enter open  o editor  q quit")
	}
	b.WriteString(helpLine)

	return b.String()
}

func (m model) viewSingleColumn() string {
	var b strings.Builder

	b.WriteString(titleStyle.Render("fst search"))
	b.WriteString("\n\n")
	b.WriteString(m.textInput.View())
	b.WriteString("\n\n")

	listHeight := m.height - 8
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

	for i := start; i < end; i++ {
		b.WriteString(m.renderItem(m.filtered[i], i == m.cursor))
		b.WriteString("\n")
	}

	b.WriteString("\n")
	b.WriteString(helpStyle.Render("↑↓ nav  enter open  m merge  q quit"))

	return b.String()
}

func (m model) buildLeftPane(width, listHeight int) string {
	var b strings.Builder

	// Title
	b.WriteString(titleStyle.Render("fst search"))
	b.WriteString("\n\n")

	// Search input
	b.WriteString(m.textInput.View())
	b.WriteString("\n\n")

	// List
	start := 0
	if m.cursor >= listHeight {
		start = m.cursor - listHeight + 1
	}
	end := start + listHeight
	if end > len(m.filtered) {
		end = len(m.filtered)
	}

	if len(m.filtered) == 0 {
		b.WriteString(helpStyle.Render("  No workspaces found"))
		b.WriteString("\n")
	}

	for i := start; i < end; i++ {
		b.WriteString(m.renderItemCompact(m.filtered[i], i == m.cursor))
		b.WriteString("\n")
	}

	// Padding
	for i := end - start; i < listHeight; i++ {
		b.WriteString("\n")
	}

	// Status bar
	b.WriteString(m.renderStatusBar())

	return b.String()
}

func (m model) buildPreviewPane(width, height int) string {
	var b strings.Builder

	previewTitle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("255")).
		Background(lipgloss.Color("236")).
		Padding(0, 1).
		Width(width)

	sectionTitle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("81"))

	if len(m.filtered) == 0 || m.cursor >= len(m.filtered) {
		b.WriteString(previewTitle.Render("Preview"))
		b.WriteString("\n\n")
		b.WriteString(helpStyle.Render("  Select a workspace to see details"))
		return b.String()
	}

	item := m.filtered[m.cursor]

	// Header
	b.WriteString(previewTitle.Render(item.WorkspaceName))
	b.WriteString("\n\n")

	// Path
	b.WriteString(sectionTitle.Render("Path"))
	b.WriteString("\n")
	path := item.Path
	if len(path) > width-2 {
		path = "..." + path[len(path)-width+5:]
	}
	b.WriteString(helpStyle.Render("  " + path))
	b.WriteString("\n\n")

	// Status
	b.WriteString(sectionTitle.Render("Status"))
	b.WriteString("\n")
	if item.Added == 0 && item.Modified == 0 && item.Deleted == 0 {
		b.WriteString(currentStyle.Render("  ✓ Clean (no changes)"))
		b.WriteString("\n")
	} else {
		total := item.Added + item.Modified + item.Deleted
		b.WriteString(fmt.Sprintf("  %s files changed\n", modifiedStyle.Render(fmt.Sprintf("%d", total))))
	}
	b.WriteString("\n")

	// Files changed
	linesUsed := 8
	maxFileLines := height - linesUsed - 4

	if item.Added > 0 || item.Modified > 0 || item.Deleted > 0 {
		b.WriteString(sectionTitle.Render("Changes"))
		b.WriteString("\n")

		fileLines := 0

		// Added files
		for i, f := range item.AddedFiles {
			if fileLines >= maxFileLines {
				remaining := (len(item.AddedFiles) - i) + len(item.ModifiedFiles) + len(item.DeletedFiles)
				b.WriteString(helpStyle.Render(fmt.Sprintf("  ... and %d more\n", remaining)))
				break
			}
			fname := f
			if len(fname) > width-6 {
				fname = "..." + fname[len(fname)-width+9:]
			}
			b.WriteString(addedStyle.Render("  + " + fname))
			b.WriteString("\n")
			fileLines++
		}

		// Modified files
		if fileLines < maxFileLines {
			for i, f := range item.ModifiedFiles {
				if fileLines >= maxFileLines {
					remaining := (len(item.ModifiedFiles) - i) + len(item.DeletedFiles)
					b.WriteString(helpStyle.Render(fmt.Sprintf("  ... and %d more\n", remaining)))
					break
				}
				fname := f
				if len(fname) > width-6 {
					fname = "..." + fname[len(fname)-width+9:]
				}
				b.WriteString(modifiedStyle.Render("  ~ " + fname))
				b.WriteString("\n")
				fileLines++
			}
		}

		// Deleted files
		if fileLines < maxFileLines {
			for i, f := range item.DeletedFiles {
				if fileLines >= maxFileLines {
					remaining := len(item.DeletedFiles) - i
					b.WriteString(helpStyle.Render(fmt.Sprintf("  ... and %d more\n", remaining)))
					break
				}
				fname := f
				if len(fname) > width-6 {
					fname = "..." + fname[len(fname)-width+9:]
				}
				b.WriteString(deletedStyle.Render("  - " + fname))
				b.WriteString("\n")
				fileLines++
			}
		}
		b.WriteString("\n")
	}

	// Agent & Activity
	if item.Agent != "" || !item.LastActivity.IsZero() {
		b.WriteString(sectionTitle.Render("Info"))
		b.WriteString("\n")
		if item.Agent != "" {
			b.WriteString(fmt.Sprintf("  Agent: %s\n", agentStyle.Render(item.Agent)))
		}
		if !item.LastActivity.IsZero() {
			b.WriteString(fmt.Sprintf("  Last activity: %s\n", timeStyle.Render(formatTimeAgo(item.LastActivity))))
		}
		b.WriteString("\n")
	}

	// Merge hint
	if !m.inWorkspace {
		b.WriteString(helpStyle.Render("  Run from a workspace to enable merge"))
		b.WriteString("\n")
	} else if item.SameProject && !item.IsCurrent {
		b.WriteString(mergeableStyle.Render("  ● Press 'm' to merge into current"))
		b.WriteString("\n")
	} else if !item.SameProject {
		b.WriteString(helpStyle.Render("  Different project (merge disabled)"))
		b.WriteString("\n")
	} else if item.IsCurrent {
		b.WriteString(currentStyle.Render("  ▸ Current workspace"))
		b.WriteString("\n")
	}

	return b.String()
}

func (m model) renderItemCompact(item workspaceItem, selected bool) string {
	// Compact view for left pane
	indicator := "  "
	if item.IsCurrent {
		indicator = "▸ "
	} else if selected {
		indicator = "> "
	}

	// Project / Workspace (truncated)
	name := fmt.Sprintf("%s/%s", item.ProjectName, item.WorkspaceName)
	if len(name) > 25 {
		name = name[:22] + "..."
	}

	// Drift summary
	drift := ""
	if item.Added > 0 || item.Modified > 0 || item.Deleted > 0 {
		drift = fmt.Sprintf("+%d ~%d -%d", item.Added, item.Modified, item.Deleted)
	} else {
		drift = "clean"
	}

	// Mergeable indicator
	mergeInd := " "
	if item.SameProject && !item.IsCurrent {
		mergeInd = "●"
	}

	line := fmt.Sprintf("%s%-25s %s %s", indicator, name, drift, mergeInd)

	if selected {
		line = selectedStyle.Render(line)
	}

	return line
}

func (m model) renderOverlay() string {
	// Overlay dimensions
	overlayWidth := 45

	// Build overlay content
	var content strings.Builder

	borderStyle := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(lipgloss.Color("62")).
		Padding(1, 2).
		Width(overlayWidth)

	titleStyle := lipgloss.NewStyle().
		Bold(true).
		Foreground(lipgloss.Color("255"))

	result := m.mergeResult

	if result.success {
		content.WriteString(currentStyle.Render("✓"))
		content.WriteString(" ")
		content.WriteString(titleStyle.Render("Merged " + result.workspaceName))
		content.WriteString("\n\n")

		if result.applied > 0 {
			content.WriteString(fmt.Sprintf("  Applied: %s\n", addedStyle.Render(fmt.Sprintf("%d files", result.applied))))
		}
		if result.conflicts > 0 {
			content.WriteString(fmt.Sprintf("  Conflicts: %s\n", deletedStyle.Render(fmt.Sprintf("%d files", result.conflicts))))
		}
		if result.failed > 0 {
			content.WriteString(fmt.Sprintf("  Failed: %s\n", deletedStyle.Render(fmt.Sprintf("%d files", result.failed))))
		}
		if result.applied == 0 && result.conflicts == 0 {
			content.WriteString("  No changes to apply\n")
		}
	} else {
		content.WriteString(deletedStyle.Render("✗"))
		content.WriteString(" ")
		content.WriteString(titleStyle.Render("Merge failed"))
		content.WriteString("\n\n")

		errMsg := result.errorMsg
		if len(errMsg) > overlayWidth-6 {
			errMsg = errMsg[:overlayWidth-9] + "..."
		}
		content.WriteString(fmt.Sprintf("  %s\n", helpStyle.Render(errMsg)))
	}

	content.WriteString("\n")
	content.WriteString(helpStyle.Render("  Press any key to continue..."))

	box := borderStyle.Render(content.String())

	// Center vertically and horizontally
	lines := strings.Split(box, "\n")
	padTop := (m.height - len(lines)) / 2
	padLeft := (m.width - overlayWidth - 4) / 2

	if padTop < 0 {
		padTop = 0
	}
	if padLeft < 0 {
		padLeft = 0
	}

	var b strings.Builder

	// Top padding
	for i := 0; i < padTop; i++ {
		b.WriteString("\n")
	}

	// Box with left padding
	leftPad := strings.Repeat(" ", padLeft)
	for _, line := range lines {
		b.WriteString(leftPad)
		b.WriteString(line)
		b.WriteString("\n")
	}

	return b.String()
}

// stripAnsi removes ANSI escape codes for length calculation
func stripAnsi(s string) string {
	var result strings.Builder
	inEscape := false
	for _, r := range s {
		if r == '\033' {
			inEscape = true
			continue
		}
		if inEscape {
			if r == 'm' {
				inEscape = false
			}
			continue
		}
		result.WriteRune(r)
	}
	return result.String()
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

	if !m.inWorkspace {
		status += "  (not in workspace - merge disabled)"
	} else if m.cursor < len(m.filtered) {
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
