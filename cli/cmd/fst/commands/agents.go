package commands

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
	"golang.org/x/term"

	"github.com/ankitiscracked/fastest/cli/internal/agent"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newAgentsCmd()) })
}

func newAgentsCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "agents",
		Short: "Manage coding agents",
		Long: `Detect and configure coding agents for LLM-powered features.

Fastest uses your locally installed coding agents (like Claude Code, Aider, etc.)
to generate natural language summaries and assist with merge conflict resolution.`,
		RunE: runAgentsList,
	}

	cmd.AddCommand(newAgentsListCmd())
	cmd.AddCommand(newAgentsSetCmd())

	return cmd
}

func newAgentsListCmd() *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Aliases: []string{"ls"},
		Short:   "List detected coding agents",
		RunE:    runAgentsList,
	}
}

func runAgentsList(cmd *cobra.Command, args []string) error {
	agents := agent.DetectAgents()
	config, _ := agent.LoadConfig()

	fmt.Println("Coding Agents:")
	fmt.Println()

	hasAvailable := false
	for _, a := range agents {
		status := "✗ not found"
		if a.Available {
			status = "✓ available"
			hasAvailable = true
		}

		preferred := ""
		if config != nil && config.PreferredAgent == a.Name {
			preferred = " (preferred)"
		} else if config != nil && config.PreferredAgent == "" && a.Available && !hasAvailable {
			// First available is default
			preferred = " (default)"
		}

		fmt.Printf("  %-10s  %-15s  %s%s\n", a.Name, status, a.Description, preferred)
	}

	fmt.Println()

	if !hasAvailable {
		fmt.Println("No coding agents detected.")
		fmt.Println()
		fmt.Println("Install one of the following:")
		fmt.Println("  • Claude Code: https://claude.ai/code")
		fmt.Println("  • Aider: pip install aider-chat")
		fmt.Println("  • Cursor: https://cursor.sh")
	} else {
		preferred, err := agent.GetPreferredAgent()
		if err == nil {
			fmt.Printf("Active agent: %s\n", preferred.Name)
		}
		fmt.Println()
		fmt.Println("Set preferred agent with: fst agents set-preferred [name]")
	}

	return nil
}

func newAgentsSetCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "set-preferred [agent-name]",
		Short: "Set the preferred coding agent",
		Args:  cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if !term.IsTerminal(int(os.Stdin.Fd())) && len(args) == 0 {
				return fmt.Errorf("agent name is required in non-interactive mode")
			}

			var name string
			if len(args) > 0 {
				name = args[0]
			} else {
				available := agent.GetAvailableAgents()
				if len(available) == 0 {
					return fmt.Errorf("no coding agents detected - install a supported agent first")
				}
				if len(available) == 1 {
					name = available[0].Name
				} else {
					chosen, err := agent.PromptAgentChoice(available)
					if err != nil {
						return err
					}
					name = chosen.Name
				}
			}

			if err := agent.SetPreferredAgent(name); err != nil {
				return err
			}

			fmt.Printf("✓ %s set as preferred agent\n", name)
			return nil
		},
	}
}
