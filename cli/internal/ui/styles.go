// Package ui provides centralized text styling for CLI output.
//
// All functions return styled strings using lipgloss, which automatically
// respects NO_COLOR env, non-TTY output, and terminal color capabilities.
// Call Disable() to force plain text output (e.g. for --no-color flags).
package ui

import "github.com/charmbracelet/lipgloss"

var disabled bool

var (
	bold     = lipgloss.NewStyle().Bold(true)
	green    = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	red      = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	yellow   = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	cyan     = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	dim      = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	boldCyan = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("6"))
)

func render(style lipgloss.Style, s string) string {
	if disabled {
		return s
	}
	return style.Render(s)
}

func Bold(s string) string     { return render(bold, s) }
func Green(s string) string    { return render(green, s) }
func Red(s string) string      { return render(red, s) }
func Yellow(s string) string   { return render(yellow, s) }
func Cyan(s string) string     { return render(cyan, s) }
func Dim(s string) string      { return render(dim, s) }
func BoldCyan(s string) string { return render(boldCyan, s) }

// Disable forces all render functions to return plain text.
// Call before producing output when the user passes --no-color.
func Disable() { disabled = true }

// Reset re-enables styling. Useful in tests to avoid state leaking.
func Reset() { disabled = false }
