package auth

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

const (
	configDirName  = "fst"
	credentialFile = "credentials.json"
)

type credentials struct {
	AccessToken string `json:"access_token"`
}

// GetConfigDir returns the path to the fst config directory
func GetConfigDir() (string, error) {
	// Use XDG_CONFIG_HOME if set, otherwise ~/.config
	configHome := os.Getenv("XDG_CONFIG_HOME")
	if configHome == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("could not determine home directory: %w", err)
		}
		configHome = filepath.Join(home, ".config")
	}

	configDir := filepath.Join(configHome, configDirName)

	// Create directory if it doesn't exist
	if err := os.MkdirAll(configDir, 0700); err != nil {
		return "", fmt.Errorf("could not create config directory: %w", err)
	}

	return configDir, nil
}

// GetCredentialPath returns the path to the credentials file
func GetCredentialPath() (string, error) {
	configDir, err := GetConfigDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(configDir, credentialFile), nil
}

// SaveToken saves the access token to the credentials file
func SaveToken(token string) error {
	credPath, err := GetCredentialPath()
	if err != nil {
		return err
	}

	creds := credentials{
		AccessToken: token,
	}

	data, err := json.MarshalIndent(creds, "", "  ")
	if err != nil {
		return fmt.Errorf("failed to marshal credentials: %w", err)
	}

	// Write with restricted permissions (owner read/write only)
	if err := os.WriteFile(credPath, data, 0600); err != nil {
		return fmt.Errorf("failed to write credentials: %w", err)
	}

	return nil
}

// GetToken retrieves the access token from the credentials file
func GetToken() (string, error) {
	credPath, err := GetCredentialPath()
	if err != nil {
		return "", err
	}

	data, err := os.ReadFile(credPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", fmt.Errorf("failed to read credentials: %w", err)
	}

	var creds credentials
	if err := json.Unmarshal(data, &creds); err != nil {
		return "", fmt.Errorf("failed to parse credentials: %w", err)
	}

	return creds.AccessToken, nil
}

// ClearToken removes the credentials file
func ClearToken() error {
	credPath, err := GetCredentialPath()
	if err != nil {
		return err
	}

	if err := os.Remove(credPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("failed to remove credentials: %w", err)
	}

	return nil
}

// IsLoggedIn returns true if there is a saved token
func IsLoggedIn() bool {
	token, err := GetToken()
	return err == nil && token != ""
}
