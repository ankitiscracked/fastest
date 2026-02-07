package commands

import (
	"fmt"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newConfigCmd()) })
}

func newConfigCmd() *cobra.Command {
	var global bool

	cmd := &cobra.Command{
		Use:   "config",
		Short: "Configure author identity",
		Long: `Configure your author identity (name and email) for snapshots.

With no arguments, opens an interactive form.
Use 'set' to set a specific field, 'get' to show fields.

Examples:
  fst config                              # interactive form (project-level)
  fst config --global                     # interactive form (global)
  fst config set name "John Doe"         # set project-level name
  fst config set email "john@example.com" # set project-level email
  fst config set --global name "John Doe" # set global name
  fst config get                          # show resolved author
  fst config get name                     # show specific field`,
		Args: cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runConfigInteractive(global)
		},
	}

	cmd.Flags().BoolVar(&global, "global", false, "Set globally (~/.config/fst/)")
	cmd.AddCommand(newConfigSetCmd())
	cmd.AddCommand(newConfigGetCmd())

	return cmd
}

func newConfigSetCmd() *cobra.Command {
	var global bool

	cmd := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "Set a config field",
		Long: `Set a specific author identity field.

Valid keys: name, email

Examples:
  fst config set name "John Doe"
  fst config set email "john@example.com"
  fst config set --global name "John Doe"`,
		Args: cobra.ExactArgs(2),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runConfigSet(args[0], args[1], global)
		},
	}

	cmd.Flags().BoolVar(&global, "global", false, "Set globally (~/.config/fst/)")

	return cmd
}

func newConfigGetCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "get [key]",
		Short: "Show config fields",
		Long: `Show resolved author identity fields.

Without a key, shows all fields. With a key, shows that specific field.

Valid keys: name, email

Examples:
  fst config get          # show all
  fst config get name     # show name only`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return runConfigShow()
			}
			return runConfigGetField(args[0])
		},
	}

	return cmd
}

func runConfigGetField(key string) error {
	author, err := config.LoadAuthor()
	if err != nil {
		return err
	}
	switch key {
	case "name":
		if author.Name == "" {
			fmt.Println("(not set)")
		} else {
			fmt.Println(author.Name)
		}
	case "email":
		if author.Email == "" {
			fmt.Println("(not set)")
		} else {
			fmt.Println(author.Email)
		}
	default:
		return fmt.Errorf("unknown config key: %s (valid keys: name, email)", key)
	}
	return nil
}

func runConfigShow() error {
	author, err := config.LoadAuthor()
	if err != nil {
		return err
	}
	if author.IsEmpty() {
		fmt.Println("No author configured. Run 'fst config' to set up.")
		return nil
	}
	fmt.Printf("  Name:  %s\n", author.Name)
	fmt.Printf("  Email: %s\n", author.Email)
	return nil
}

func runConfigSet(key, value string, global bool) error {
	var author *config.Author
	var err error

	if global {
		author, err = config.LoadGlobalAuthor()
	} else {
		author, err = config.LoadProjectAuthor()
	}
	if err != nil {
		author = &config.Author{}
	}

	switch key {
	case "name":
		author.Name = value
	case "email":
		author.Email = value
	default:
		return fmt.Errorf("unknown config key: %s (valid keys: name, email)", key)
	}

	if global {
		err = config.SaveGlobalAuthor(author)
	} else {
		err = config.SaveProjectAuthor(author)
	}
	if err != nil {
		return err
	}

	scope := "project"
	if global {
		scope = "global"
	}
	fmt.Printf("Set %s %s (%s).\n", key, value, scope)
	return nil
}

func runConfigInteractive(global bool) error {
	var existing *config.Author
	var err error

	if global {
		existing, err = config.LoadGlobalAuthor()
	} else {
		existing, err = config.LoadProjectAuthor()
	}
	if err != nil {
		existing = &config.Author{}
	}

	author, err := promptAuthor(existing)
	if err != nil {
		return err
	}

	if global {
		err = config.SaveGlobalAuthor(author)
	} else {
		err = config.SaveProjectAuthor(author)
	}
	if err != nil {
		return err
	}

	scope := "project"
	if global {
		scope = "global"
	}
	fmt.Printf("Saved author config (%s).\n", scope)
	return nil
}

// resolveAuthor loads author config and prompts interactively if missing.
// In non-interactive environments (CI, tests), returns empty author without error.
func resolveAuthor() (*config.Author, error) {
	author, err := config.LoadAuthor()
	if err == nil && !author.IsEmpty() {
		return author, nil
	}
	prompted, promptErr := promptAuthor(&config.Author{})
	if promptErr == nil {
		_ = config.SaveGlobalAuthor(prompted)
		return prompted, nil
	}
	if promptErr.Error() == "cancelled" {
		return nil, promptErr
	}
	// Non-interactive environment (TTY unavailable etc), continue without author
	if author != nil {
		return author, nil
	}
	return &config.Author{}, nil
}

// promptAuthor shows an interactive bubbletea form for author name and email.
func promptAuthor(existing *config.Author) (*config.Author, error) {
	m := newAuthorFormModel(existing)
	p := tea.NewProgram(m)
	final, err := p.Run()
	if err != nil {
		return nil, err
	}
	model, ok := final.(authorFormModel)
	if !ok {
		return nil, fmt.Errorf("failed to read author config")
	}
	if model.err != nil {
		return nil, model.err
	}
	return &config.Author{
		Name:  strings.TrimSpace(model.inputs[0].Value()),
		Email: strings.TrimSpace(model.inputs[1].Value()),
	}, nil
}

type authorFormModel struct {
	inputs  []textinput.Model
	focused int
	err     error
	done    bool
}

func newAuthorFormModel(existing *config.Author) authorFormModel {
	nameInput := textinput.New()
	nameInput.Placeholder = "Your Name"
	nameInput.CharLimit = 200
	nameInput.Width = 40
	if existing != nil && existing.Name != "" {
		nameInput.SetValue(existing.Name)
	}
	nameInput.Focus()

	emailInput := textinput.New()
	emailInput.Placeholder = "you@example.com"
	emailInput.CharLimit = 200
	emailInput.Width = 40
	if existing != nil && existing.Email != "" {
		emailInput.SetValue(existing.Email)
	}

	return authorFormModel{
		inputs:  []textinput.Model{nameInput, emailInput},
		focused: 0,
	}
}

func (m authorFormModel) Init() tea.Cmd {
	return textinput.Blink
}

func (m authorFormModel) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			m.err = fmt.Errorf("cancelled")
			m.done = true
			return m, tea.Quit
		case tea.KeyCtrlS:
			name := strings.TrimSpace(m.inputs[0].Value())
			email := strings.TrimSpace(m.inputs[1].Value())
			if name == "" || email == "" {
				m.err = fmt.Errorf("name and email are required")
				return m, nil
			}
			m.done = true
			return m, tea.Quit
		case tea.KeyTab, tea.KeyDown:
			m.focused = (m.focused + 1) % len(m.inputs)
			return m, m.updateFocus()
		case tea.KeyShiftTab, tea.KeyUp:
			m.focused = (m.focused - 1 + len(m.inputs)) % len(m.inputs)
			return m, m.updateFocus()
		}
	}

	var cmd tea.Cmd
	m.inputs[m.focused], cmd = m.inputs[m.focused].Update(msg)
	return m, cmd
}

func (m authorFormModel) updateFocus() tea.Cmd {
	var cmds []tea.Cmd
	for i := range m.inputs {
		if i == m.focused {
			cmds = append(cmds, m.inputs[i].Focus())
		} else {
			m.inputs[i].Blur()
		}
	}
	return tea.Batch(cmds...)
}

func (m authorFormModel) View() string {
	if m.done {
		return ""
	}
	var b strings.Builder
	b.WriteString("Author setup (Ctrl+S to save, Ctrl+C to cancel):\n\n")
	b.WriteString(fmt.Sprintf("  Name:  %s\n", m.inputs[0].View()))
	b.WriteString(fmt.Sprintf("  Email: %s\n", m.inputs[1].View()))
	if m.err != nil {
		b.WriteString(fmt.Sprintf("\n  %s\n", m.err.Error()))
	}
	b.WriteString("\n  Tab to switch fields, Ctrl+S to save")
	return b.String()
}
