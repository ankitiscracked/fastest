package auth

import (
	"errors"
	"fmt"
	"strings"

	"github.com/zalando/go-keyring"
)

const (
	keyringService = "fst"
	keyringUser    = "access_token"
)

// SaveToken saves the access token to the credentials file
func SaveToken(token string) error {
	if err := keyring.Set(keyringService, keyringUser, token); err != nil {
		return fmt.Errorf("failed to store token in OS keychain: %w", err)
	}
	return nil
}

// GetToken retrieves the access token from the credentials file
func GetToken() (string, error) {
	token, err := keyring.Get(keyringService, keyringUser)
	if err == keyring.ErrNotFound {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("failed to read token from OS keychain: %w", err)
	}
	return token, nil
}

// ClearToken removes the credentials file
func ClearToken() error {
	if err := keyring.Delete(keyringService, keyringUser); err != nil && err != keyring.ErrNotFound {
		return fmt.Errorf("failed to remove token from OS keychain: %w", err)
	}
	return nil
}

// FormatKeyringError adds platform-specific hints for common keyring failures.
func FormatKeyringError(err error) error {
	if err == nil {
		return nil
	}
	msg := err.Error()
	hint := ""

	switch {
	case strings.Contains(msg, "No such file or directory") || strings.Contains(msg, "org.freedesktop.secrets"):
		hint = "On Linux, install and run a Secret Service provider (e.g., GNOME Keyring or KWallet) and ensure DBus is available."
	case strings.Contains(msg, "User interaction is not allowed"):
		hint = "The OS keychain may be locked. Unlock it and try again."
	case strings.Contains(msg, "Access denied") || strings.Contains(msg, "denied"):
		hint = "The OS keychain denied access. Check keychain permissions."
	}

	if hint == "" {
		return err
	}
	return errors.New(fmt.Sprintf("%s\nHint: %s", msg, hint))
}

// IsLoggedIn returns true if there is a saved token
func IsLoggedIn() bool {
	token, err := GetToken()
	return err == nil && token != ""
}
