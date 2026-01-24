package commands

import (
	"os"

	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
)

func apiBaseURL(cfg *config.ProjectConfig) string {
	if envURL := os.Getenv("FST_API_URL"); envURL != "" {
		return envURL
	}
	if cfg != nil && cfg.APIURL != "" {
		return cfg.APIURL
	}
	return ""
}

func newAPIClient(token string, cfg *config.ProjectConfig) *api.Client {
	client := api.NewClient(token)
	if baseURL := apiBaseURL(cfg); baseURL != "" {
		client.SetBaseURL(baseURL)
	}
	return client
}
