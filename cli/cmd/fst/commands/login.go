package commands

import (
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/ui"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newLoginCmd()) })
	register(func(root *cobra.Command) { root.AddCommand(newLogoutCmd()) })
	register(func(root *cobra.Command) { root.AddCommand(newWhoamiCmd()) })
}

func newLoginCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "login",
		Short: "Log in to Fastest cloud",
		Long: `Authenticate with Fastest using the device authorization flow.

This will open a browser window where you can enter the code displayed
in your terminal to complete authentication.`,
		RunE: runLogin,
	}
}

func runLogin(cmd *cobra.Command, args []string) error {
	// Check if already logged in
	token, err := deps.AuthGetToken()
	if err != nil {
		return deps.AuthFormatError(err)
	}
	if token != "" {
		fmt.Println("Already logged in. Use 'fst logout' first to log in as a different user.")
		return nil
	}

	client := deps.NewAPIClient("", nil)

	// Start device flow
	fmt.Println("Starting login...")
	deviceResp, err := client.StartDeviceFlow()
	if err != nil {
		return fmt.Errorf("failed to start login: %w", err)
	}

	// Display the code and URL
	fmt.Println()
	fmt.Println("To authenticate, visit:")
	fmt.Printf("  %s\n", ui.Bold(deviceResp.VerificationURI))
	fmt.Println()
	fmt.Println("And enter code:")
	fmt.Printf("  %s\n", ui.BoldCyan(deviceResp.UserCode))
	fmt.Println()

	// Try to open browser automatically
	if err := deps.OpenBrowser(deviceResp.VerificationURIComplete); err != nil {
		fmt.Println("(Could not open browser automatically)")
	} else {
		fmt.Println("(Browser opened automatically)")
	}

	fmt.Println()
	fmt.Print("Waiting for authentication...")

	// Poll for token
	interval := time.Duration(deviceResp.Interval) * time.Second
	if interval < time.Second {
		interval = 5 * time.Second
	}

	deadline := deps.Now().Add(time.Duration(deviceResp.ExpiresIn) * time.Second)
	spinner := []string{"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"}
	spinIdx := 0

	for deps.Now().Before(deadline) {
		// Show spinner
		fmt.Printf("\r\033[KWaiting for authentication... %s", spinner[spinIdx%len(spinner)])
		spinIdx++

		deps.Sleep(interval)

		tokenResp, err := client.PollForToken(deviceResp.DeviceCode)
		if err != nil {
			// Check if it's a "keep polling" error
			if apiErr, ok := err.(*api.OAuthError); ok {
				switch apiErr.ErrorCode {
				case "authorization_pending":
					continue
				case "slow_down":
					interval += time.Second
					continue
				case "expired_token":
					fmt.Println("\r\033[K")
					return fmt.Errorf("login timed out - please try again")
				case "access_denied":
					fmt.Println("\r\033[K")
					return fmt.Errorf("login was denied")
				}
			}
			continue
		}

		// Success! Save the token
		fmt.Println("\r\033[K")
		fmt.Printf("✓ Logged in as %s\n", ui.Bold(tokenResp.User.Email))

		if err := deps.AuthSaveToken(tokenResp.AccessToken); err != nil {
			return fmt.Errorf("logged in but failed to save token: %w", deps.AuthFormatError(err))
		}

		return nil
	}

	fmt.Println("\r\033[K")
	return fmt.Errorf("login timed out - please try again")
}

func newLogoutCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "logout",
		Short: "Log out of Fastest cloud",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := deps.AuthClearToken(); err != nil {
				return fmt.Errorf("failed to clear credentials: %w", deps.AuthFormatError(err))
			}
			fmt.Println("Logged out successfully.")
			return nil
		},
	}
}

func newWhoamiCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "Show current user",
		RunE: func(cmd *cobra.Command, args []string) error {
			token, err := deps.AuthGetToken()
			if err != nil {
				return deps.AuthFormatError(err)
			}
			if token == "" {
				fmt.Println("Not logged in. Run 'fst login' to authenticate.")
				return nil
			}

			client := deps.NewAPIClient(token, nil)
			user, err := client.GetMe()
			if err != nil {
				return fmt.Errorf("failed to get user info: %w", err)
			}

			fmt.Printf("Logged in as: %s\n", user.Email)
			fmt.Printf("User ID: %s\n", user.ID)
			return nil
		},
	}
}

func openBrowser(url string) error {
	var cmd *exec.Cmd

	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "linux":
		cmd = exec.Command("xdg-open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", url)
	default:
		return fmt.Errorf("unsupported platform")
	}

	cmd.Stdin = nil
	cmd.Stdout = nil
	cmd.Stderr = nil

	return cmd.Start()
}
