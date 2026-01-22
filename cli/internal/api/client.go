package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	DefaultBaseURL = "http://localhost:8787"
)

// Client is the API client for the Fastest API
type Client struct {
	baseURL    string
	token      string
	httpClient *http.Client
}

// NewClient creates a new API client
func NewClient(token string) *Client {
	return &Client{
		baseURL: DefaultBaseURL,
		token:   token,
		httpClient: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// SetBaseURL sets the base URL for the API
func (c *Client) SetBaseURL(url string) {
	c.baseURL = url
}

// Device flow types

type DeviceFlowResponse struct {
	DeviceCode              string `json:"device_code"`
	UserCode                string `json:"user_code"`
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

type TokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
	User        User   `json:"user"`
}

type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type OAuthError struct {
	ErrorCode        string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

func (e *OAuthError) Error() string {
	return fmt.Sprintf("%s: %s", e.ErrorCode, e.ErrorDescription)
}

// StartDeviceFlow initiates the OAuth device flow
func (c *Client) StartDeviceFlow() (*DeviceFlowResponse, error) {
	resp, err := c.httpClient.Post(
		c.baseURL+"/v1/oauth/device",
		"application/json",
		nil,
	)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result DeviceFlowResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// PollForToken polls the token endpoint during device flow
func (c *Client) PollForToken(deviceCode string) (*TokenResponse, error) {
	body := map[string]string{
		"grant_type":  "urn:ietf:params:oauth:grant-type:device_code",
		"device_code": deviceCode,
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	resp, err := c.httpClient.Post(
		c.baseURL+"/v1/oauth/token",
		"application/json",
		bytes.NewReader(jsonBody),
	)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK {
		// Try to parse as OAuth error
		var oauthErr OAuthError
		if err := json.Unmarshal(respBody, &oauthErr); err == nil && oauthErr.ErrorCode != "" {
			return nil, &oauthErr
		}
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result TokenResponse
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result, nil
}

// GetMe returns the current authenticated user
func (c *Client) GetMe() (*User, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/v1/auth/me", nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("not authenticated")
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		User User `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result.User, nil
}

// Project types

type Project struct {
	ID             string  `json:"id"`
	OwnerUserID    string  `json:"owner_user_id"`
	Name           string  `json:"name"`
	CreatedAt      string  `json:"created_at"`
	UpdatedAt      string  `json:"updated_at"`
	LastSnapshotID *string `json:"last_snapshot_id"`
}

type Workspace struct {
	ID             string  `json:"id"`
	ProjectID      string  `json:"project_id"`
	Name           string  `json:"name"`
	MachineID      *string `json:"machine_id"`
	BaseSnapshotID *string `json:"base_snapshot_id"`
	LocalPath      *string `json:"local_path"`
	LastSeenAt     *string `json:"last_seen_at"`
	CreatedAt      string  `json:"created_at"`
}

type CreateProjectRequest struct {
	Name string `json:"name"`
}

type CreateWorkspaceRequest struct {
	Name           string  `json:"name"`
	MachineID      *string `json:"machine_id,omitempty"`
	BaseSnapshotID *string `json:"base_snapshot_id,omitempty"`
	LocalPath      *string `json:"local_path,omitempty"`
}

// CreateProject creates a new project
func (c *Client) CreateProject(name string) (*Project, error) {
	body := CreateProjectRequest{Name: name}
	jsonBody, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}

	req, err := http.NewRequest("POST", c.baseURL+"/v1/projects", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("not authenticated - run 'fst login' first")
	}

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create project: %s", string(respBody))
	}

	var result struct {
		Project Project `json:"project"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result.Project, nil
}

// ListProjects returns all projects for the authenticated user
func (c *Client) ListProjects() ([]Project, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/v1/projects", nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("not authenticated - run 'fst login' first")
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		Projects []Project `json:"projects"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return result.Projects, nil
}

// GetProject returns a project by ID
func (c *Client) GetProject(projectID string) (*Project, []Workspace, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/v1/projects/"+projectID, nil)
	if err != nil {
		return nil, nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, nil, fmt.Errorf("not authenticated - run 'fst login' first")
	}

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil, fmt.Errorf("project not found")
	}

	if resp.StatusCode != http.StatusOK {
		return nil, nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		Project    Project     `json:"project"`
		Workspaces []Workspace `json:"workspaces"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result.Project, result.Workspaces, nil
}

// CreateWorkspace creates a new workspace for a project
func (c *Client) CreateWorkspace(projectID string, req CreateWorkspaceRequest) (*Workspace, error) {
	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, err
	}

	httpReq, err := http.NewRequest("POST", c.baseURL+"/v1/projects/"+projectID+"/workspaces", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, err
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("not authenticated - run 'fst login' first")
	}

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusCreated {
		return nil, fmt.Errorf("failed to create workspace: %s", string(respBody))
	}

	var result struct {
		Workspace Workspace `json:"workspace"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result.Workspace, nil
}

// SendHeartbeat sends a heartbeat for a workspace
func (c *Client) SendHeartbeat(workspaceID string) error {
	req, err := http.NewRequest("POST", c.baseURL+"/v1/workspaces/"+workspaceID+"/heartbeat", nil)
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("heartbeat failed: status %d", resp.StatusCode)
	}

	return nil
}

// Snapshot types

type Snapshot struct {
	ID               string  `json:"id"`
	ProjectID        string  `json:"project_id"`
	ContentHash      string  `json:"content_hash"`
	ParentSnapshotID *string `json:"parent_snapshot_id"`
	Source           string  `json:"source"`
	CreatedAt        string  `json:"created_at"`
}

type CreateSnapshotRequest struct {
	ContentHash      string  `json:"content_hash"`
	ParentSnapshotID *string `json:"parent_snapshot_id,omitempty"`
	Source           string  `json:"source,omitempty"`
}

// CreateSnapshot creates a new snapshot for a project
func (c *Client) CreateSnapshot(projectID, manifestHash string, parentSnapshotID string) (*Snapshot, bool, error) {
	req := CreateSnapshotRequest{
		ContentHash: manifestHash,
		Source:      "cli",
	}
	if parentSnapshotID != "" {
		req.ParentSnapshotID = &parentSnapshotID
	}

	jsonBody, err := json.Marshal(req)
	if err != nil {
		return nil, false, err
	}

	httpReq, err := http.NewRequest("POST", c.baseURL+"/v1/projects/"+projectID+"/snapshots", bytes.NewReader(jsonBody))
	if err != nil {
		return nil, false, err
	}

	httpReq.Header.Set("Authorization", "Bearer "+c.token)
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(httpReq)
	if err != nil {
		return nil, false, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusUnauthorized {
		return nil, false, fmt.Errorf("not authenticated - run 'fst login' first")
	}

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		return nil, false, fmt.Errorf("failed to create snapshot: %s", string(respBody))
	}

	var result struct {
		Snapshot Snapshot `json:"snapshot"`
		Created  bool     `json:"created"`
	}
	if err := json.Unmarshal(respBody, &result); err != nil {
		return nil, false, fmt.Errorf("failed to decode response: %w", err)
	}

	return &result.Snapshot, result.Created, nil
}

// DriftReport represents drift data from the cloud
type DriftReport struct {
	ID            string   `json:"id"`
	WorkspaceID   string   `json:"workspace_id"`
	FilesAdded    []string `json:"files_added"`
	FilesModified []string `json:"files_modified"`
	FilesDeleted  []string `json:"files_deleted"`
	BytesChanged  int64    `json:"bytes_changed"`
	Summary       string   `json:"summary"`
	ReportedAt    string   `json:"reported_at"`
}

// GetWorkspaceDrift gets the latest drift report for a workspace
func (c *Client) GetWorkspaceDrift(workspaceID string) (*DriftReport, error) {
	req, err := http.NewRequest("GET", c.baseURL+"/v1/workspaces/"+workspaceID+"/drift", nil)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotFound {
		return nil, nil // No drift data
	}

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected status: %d", resp.StatusCode)
	}

	var result struct {
		DriftReports []DriftReport `json:"drift_reports"`
		Latest       *DriftReport  `json:"latest"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("failed to decode response: %w", err)
	}

	return result.Latest, nil
}

// ReportDrift reports drift for a workspace
func (c *Client) ReportDrift(workspaceID string, filesAdded, filesModified, filesDeleted int, bytesChanged int64, summary string) error {
	body := map[string]interface{}{
		"files_added":    filesAdded,
		"files_modified": filesModified,
		"files_deleted":  filesDeleted,
		"bytes_changed":  bytesChanged,
	}
	if summary != "" {
		body["summary"] = summary
	}

	jsonBody, err := json.Marshal(body)
	if err != nil {
		return err
	}

	req, err := http.NewRequest("POST", c.baseURL+"/v1/workspaces/"+workspaceID+"/drift", bytes.NewReader(jsonBody))
	if err != nil {
		return err
	}

	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK && resp.StatusCode != http.StatusCreated {
		respBody, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("failed to report drift: %s", string(respBody))
	}

	return nil
}
