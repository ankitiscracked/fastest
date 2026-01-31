package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/agent"
	"github.com/anthropics/fastest/cli/internal/api"
	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newSnapshotCmd()) })
}

func newSnapshotCmd() *cobra.Command {
	var message string
	var autoSummary bool
	var agentName string

	cmd := &cobra.Command{
		Use:   "snapshot",
		Short: "Capture current state as a snapshot",
		Long: `Capture the current state of the project as an immutable snapshot.

This will:
1. Scan all files (respecting .fstignore)
2. Save the snapshot locally for rollback support
3. Optionally sync to cloud if authenticated
4. Set this as the new base for drift calculations

Use --summary to auto-generate a description using your coding agent.
Use --agent to record which AI agent made these changes.`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runSnapshot(message, autoSummary, agentName)
		},
	}

	cmd.Flags().StringVarP(&message, "message", "m", "", "Description for this snapshot")
	cmd.Flags().BoolVar(&autoSummary, "summary", false, "Auto-generate description using coding agent")
	cmd.Flags().StringVar(&agentName, "agent", "", "Name of the AI agent (auto-detected if not specified)")

	return cmd
}

func runSnapshot(message string, autoSummary bool, agentName string) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	// Detect agent if not specified
	if agentName == "" {
		agentName = detectAgent()
	}

	fmt.Println("Scanning files...")

	// Generate manifest (without mod times for reproducibility)
	m, err := manifest.Generate(root, false)
	if err != nil {
		return fmt.Errorf("failed to scan files: %w", err)
	}

	fmt.Printf("Found %d files (%s)\n", m.FileCount(), formatBytesLong(m.TotalSize()))

	// Compute manifest hash (snapshot ID is generated separately)
	manifestHash, err := m.Hash()
	if err != nil {
		return fmt.Errorf("failed to create snapshot: %w", err)
	}

	// Create a new snapshot ID (history entry)
	snapshotID := generateSnapshotID()

	// Check if this exact snapshot already exists in local snapshots dir
	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return fmt.Errorf("failed to get snapshots directory: %w", err)
	}

	manifestsDir, err := config.GetManifestsDir()
	if err != nil {
		return fmt.Errorf("failed to get manifests directory: %w", err)
	}

	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	manifestExists := false
	if _, err := os.Stat(manifestPath); err == nil {
		manifestExists = true
	}

	// Generate summary if requested
	if autoSummary && message == "" {
		fmt.Println("Generating summary...")
		summary, err := generateSnapshotSummary(root, cfg)
		if err != nil {
			fmt.Printf("Warning: Could not generate summary: %v\n", err)
		} else {
			message = summary
		}
	}

	// Cache blobs (file contents) in global cache for rollback support
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return fmt.Errorf("failed to get global blob directory: %w", err)
	}

	blobsCached := 0
	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		// Skip if blob already cached
		if _, err := os.Stat(blobPath); err == nil {
			continue
		}

		// Read file content and cache it
		srcPath := filepath.Join(root, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			fmt.Printf("Warning: Could not cache %s: %v\n", f.Path, err)
			continue
		}

		if err := os.WriteFile(blobPath, content, 0644); err != nil {
			fmt.Printf("Warning: Could not cache %s: %v\n", f.Path, err)
			continue
		}
		blobsCached++
	}

	if blobsCached > 0 {
		fmt.Printf("Cached %d new blobs.\n", blobsCached)
	}

	// Serialize manifest once (used for local save and cloud upload)
	manifestJSON, err := m.ToJSON()
	if err != nil {
		return fmt.Errorf("failed to save snapshot: %w", err)
	}

	// Save snapshot locally
	if !manifestExists {
		if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
			return fmt.Errorf("failed to save snapshot: %w", err)
		}
	}

	// Save snapshot metadata
	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	parentSnapshotID := cfg.CurrentSnapshotID
	metadata := fmt.Sprintf(`{
  "id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_id": "%s",
  "message": "%s",
  "agent": "%s",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, cfg.WorkspaceID, escapeJSON(cfg.WorkspaceName), manifestHash, parentSnapshotID, escapeJSON(message),
		escapeJSON(agentName), time.Now().UTC().Format(time.RFC3339), m.FileCount(), m.TotalSize())

	if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
		return fmt.Errorf("failed to save metadata: %w", err)
	}

	// Try to sync to cloud if authenticated
	token, err := deps.AuthGetToken()
	if err != nil {
		fmt.Printf("Warning: %v\n", deps.AuthFormatError(err))
	}
	cloudSynced := false
	if token != "" {
		client := deps.NewAPIClient(token, cfg)
		if err := uploadSnapshotToCloud(client, root, m, manifestHash, manifestJSON); err != nil {
			fmt.Printf("Warning: Cloud upload failed: %v\n", err)
		} else {
			_, created, err := client.CreateSnapshot(cfg.ProjectID, snapshotID, manifestHash, parentSnapshotID, cfg.WorkspaceID)
			if err == nil {
				cloudSynced = true
				if created {
					fmt.Println("Synced to cloud.")
				}
			} else {
				fmt.Printf("Warning: Cloud snapshot record failed: %v\n", err)
			}
		}
	}

	cfg.CurrentSnapshotID = snapshotID

	// Save config
	if err := config.Save(cfg); err != nil {
		return fmt.Errorf("failed to update config: %w", err)
	}

	// Output result
	fmt.Println()
	fmt.Println("✓ Snapshot created!")
	fmt.Println()
	fmt.Printf("  ID:       %s\n", snapshotID)
	fmt.Printf("  Hash:     %s\n", manifestHash[:16]+"...")
	fmt.Printf("  Files:    %d\n", m.FileCount())
	fmt.Printf("  Size:     %s\n", formatBytesLong(m.TotalSize()))
	if agentName != "" {
		fmt.Printf("  Agent:    %s\n", agentName)
	}
	if message != "" {
		fmt.Printf("  Message:  %s\n", message)
	}
	if cfg.ForkSnapshotID != "" {
		fmt.Printf("  Fork:     %s\n", cfg.ForkSnapshotID)
	}
	if !cloudSynced && token == "" {
		fmt.Println("  (local only - not synced to cloud)")
	}

	return nil
}

// CreateAutoSnapshot creates a snapshot silently (for use before merge/destructive operations)
// Returns the snapshot ID or empty string if snapshot already exists (no changes)
func CreateAutoSnapshot(message string) (string, error) {
	cfg, err := config.Load()
	if err != nil {
		return "", fmt.Errorf("not in a workspace directory")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return "", fmt.Errorf("failed to find project root: %w", err)
	}

	// Generate manifest
	m, err := manifest.Generate(root, false)
	if err != nil {
		return "", fmt.Errorf("failed to scan files: %w", err)
	}

	// Compute manifest hash
	manifestHash, err := m.Hash()
	if err != nil {
		return "", fmt.Errorf("failed to create snapshot: %w", err)
	}

	// Skip if no changes since current snapshot
	if cfg.CurrentSnapshotID != "" {
		if currentHash, err := config.ManifestHashFromSnapshotIDAt(root, cfg.CurrentSnapshotID); err == nil && currentHash == manifestHash {
			return "", nil
		}
	}

	snapshotID := generateSnapshotID()

	// Check if snapshot already exists
	snapshotsDir, err := config.GetSnapshotsDir()
	if err != nil {
		return "", fmt.Errorf("failed to get snapshots directory: %w", err)
	}

	manifestsDir, err := config.GetManifestsDir()
	if err != nil {
		return "", fmt.Errorf("failed to get manifests directory: %w", err)
	}
	manifestPath := filepath.Join(manifestsDir, manifestHash+".json")
	manifestExists := false
	if _, err := os.Stat(manifestPath); err == nil {
		manifestExists = true
	}

	// Cache blobs
	blobDir, err := config.GetGlobalBlobDir()
	if err != nil {
		return "", fmt.Errorf("failed to get global blob directory: %w", err)
	}

	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		if _, err := os.Stat(blobPath); err == nil {
			continue
		}

		srcPath := filepath.Join(root, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			continue
		}

		os.WriteFile(blobPath, content, 0644)
	}

	// Save manifest
	manifestJSON, err := m.ToJSON()
	if err != nil {
		return "", fmt.Errorf("failed to serialize snapshot: %w", err)
	}

	if !manifestExists {
		if err := os.WriteFile(manifestPath, manifestJSON, 0644); err != nil {
			return "", fmt.Errorf("failed to save snapshot: %w", err)
		}
	}

	// Save metadata
	metadataPath := filepath.Join(snapshotsDir, snapshotID+".meta.json")
	metadata := fmt.Sprintf(`{
  "id": "%s",
  "workspace_id": "%s",
  "workspace_name": "%s",
  "manifest_hash": "%s",
  "parent_snapshot_id": "%s",
  "message": "%s",
  "agent": "",
  "created_at": "%s",
  "files": %d,
  "size": %d
}`, snapshotID, cfg.WorkspaceID, escapeJSON(cfg.WorkspaceName), manifestHash, cfg.CurrentSnapshotID, escapeJSON(message),
		time.Now().UTC().Format(time.RFC3339), m.FileCount(), m.TotalSize())

	if err := os.WriteFile(metadataPath, []byte(metadata), 0644); err != nil {
		return "", fmt.Errorf("failed to save metadata: %w", err)
	}

	// Config doesn't need updating - last snapshot is derived from snapshots dir

	return snapshotID, nil
}

// detectAgent attempts to auto-detect the coding agent from environment
func detectAgent() string {
	// Check explicit FST_AGENT env var first
	if agent := os.Getenv("FST_AGENT"); agent != "" {
		return agent
	}

	// Claude Code sets CLAUDE_CODE=1 when running
	if os.Getenv("CLAUDE_CODE") == "1" {
		return "claude"
	}

	// Check for Claude Code's session ID (also indicates Claude Code)
	if os.Getenv("CLAUDE_SESSION_ID") != "" {
		return "claude"
	}

	// Aider sets AIDER=1 when running
	if os.Getenv("AIDER") == "1" {
		return "aider"
	}

	// Cursor sets CURSOR=1 when in Cursor terminal
	if os.Getenv("CURSOR") == "1" {
		return "cursor"
	}

	// Check for Cursor's terminal integration
	if os.Getenv("TERM_PROGRAM") == "cursor" {
		return "cursor"
	}

	// Check for VS Code Copilot
	if os.Getenv("TERM_PROGRAM") == "vscode" && os.Getenv("GITHUB_COPILOT") != "" {
		return "copilot"
	}

	// Check for Windsurf
	if os.Getenv("WINDSURF") == "1" {
		return "windsurf"
	}

	// Check for Cline
	if os.Getenv("CLINE") == "1" {
		return "cline"
	}

	return ""
}

// generateSnapshotSummary uses the coding agent to describe changes
func generateSnapshotSummary(root string, cfg *config.ProjectConfig) (string, error) {
	// Get preferred agent
	preferredAgent, err := agent.GetPreferredAgent()
	if err != nil {
		return "", err
	}

	// Compute drift from base
	report, err := drift.ComputeFromCache(root)
	if err != nil {
		return "", fmt.Errorf("failed to compute drift: %w", err)
	}

	// If no changes, return simple message
	if !report.HasChanges() {
		return "No changes from previous snapshot", nil
	}

	fmt.Printf("Using %s to generate summary...\n", preferredAgent.Name)

	// Build context with file contents
	fileContents := make(map[string]string)
	for _, f := range report.FilesAdded {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}
	for _, f := range report.FilesModified {
		content, err := agent.ReadFileContent(filepath.Join(root, f), 4000)
		if err == nil {
			fileContents[f] = content
		}
	}

	diffContext := agent.BuildDiffContext(
		report.FilesAdded,
		report.FilesModified,
		report.FilesDeleted,
		fileContents,
	)

	// Invoke agent for summary
	summary, err := agent.InvokeSummary(preferredAgent, diffContext)
	if err != nil {
		return "", err
	}

	return summary, nil
}

func uploadSnapshotToCloud(client *api.Client, root string, m *manifest.Manifest, manifestHash string, manifestJSON []byte) error {
	if len(m.Files) == 0 {
		return client.UploadManifest(manifestHash, manifestJSON)
	}

	hashToPath := make(map[string]string)
	hashes := make([]string, 0, len(m.Files))
	for _, f := range m.Files {
		if _, exists := hashToPath[f.Hash]; !exists {
			hashToPath[f.Hash] = f.Path
			hashes = append(hashes, f.Hash)
		}
	}

	missing := []string{}
	for i := 0; i < len(hashes); i += 100 {
		end := i + 100
		if end > len(hashes) {
			end = len(hashes)
		}
		batchMissing, err := client.BlobExists(hashes[i:end])
		if err != nil {
			return err
		}
		missing = append(missing, batchMissing...)
	}

	if len(missing) > 0 {
		for i := 0; i < len(missing); i += 100 {
			end := i + 100
			if end > len(missing) {
				end = len(missing)
			}
			urls, err := client.PresignUpload(missing[i:end])
			if err != nil {
				return err
			}
			for _, hash := range missing[i:end] {
				path, ok := hashToPath[hash]
				if !ok {
					continue
				}
				url, ok := urls[hash]
				if !ok || url == "" {
					return fmt.Errorf("missing upload URL for blob %s", hash)
				}
				content, err := os.ReadFile(filepath.Join(root, path))
				if err != nil {
					return fmt.Errorf("failed to read %s: %w", path, err)
				}
				if err := client.UploadBlob(url, content); err != nil {
					return err
				}
			}
		}
	}

	return client.UploadManifest(manifestHash, manifestJSON)
}

// escapeJSON escapes a string for JSON
func escapeJSON(s string) string {
	result := ""
	for _, c := range s {
		switch c {
		case '"':
			result += `\"`
		case '\\':
			result += `\\`
		case '\n':
			result += `\n`
		case '\r':
			result += `\r`
		case '\t':
			result += `\t`
		default:
			result += string(c)
		}
	}
	return result
}

func formatBytesLong(bytes int64) string {
	if bytes == 0 {
		return "0 B"
	}
	const k = 1024
	sizes := []string{"B", "KB", "MB", "GB", "TB"}
	i := 0
	fb := float64(bytes)
	for fb >= k && i < len(sizes)-1 {
		fb /= k
		i++
	}
	if i == 0 {
		return fmt.Sprintf("%d %s", bytes, sizes[i])
	}
	return fmt.Sprintf("%.2f %s", fb, sizes[i])
}
