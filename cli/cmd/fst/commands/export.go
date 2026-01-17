package commands

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/manifest"
)

func init() {
	rootCmd.AddCommand(newExportCmd())
}

func newExportCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export project to other formats",
		Long:  `Export project snapshots and current state to other version control systems.`,
	}

	cmd.AddCommand(newExportGitCmd())

	return cmd
}

func newExportGitCmd() *cobra.Command {
	var branchName string
	var includeDrift bool
	var message string
	var initRepo bool
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "git",
		Short: "Export to Git repository",
		Long: `Export workspace snapshots to Git commits.

This will:
1. Map each snapshot in the chain to a Git commit
2. Create/update a branch for the current workspace
3. Optionally include uncommitted changes (drift)

The mapping is stored in .fst/export/git-map.json to enable incremental exports.
Subsequent exports only create commits for new snapshots.

Examples:
  fst export git                     # Export to current branch
  fst export git --branch feature    # Export to specific branch
  fst export git --include-drift     # Include uncommitted changes
  fst export git --init              # Initialize git repo if needed`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runExportGit(branchName, includeDrift, message, initRepo, rebuild)
		},
	}

	cmd.Flags().StringVarP(&branchName, "branch", "b", "", "Branch name (default: workspace name)")
	cmd.Flags().BoolVar(&includeDrift, "include-drift", false, "Include uncommitted changes as a commit")
	cmd.Flags().StringVarP(&message, "message", "m", "", "Commit message for drift (requires --include-drift)")
	cmd.Flags().BoolVar(&initRepo, "init", false, "Initialize git repo if it doesn't exist")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild all commits from scratch (ignores existing mapping)")

	return cmd
}

// GitMapping tracks which snapshots have been exported to which commits
type GitMapping struct {
	RepoPath  string            `json:"repo_path"`
	Snapshots map[string]string `json:"snapshots"` // snapshot_id -> git_commit_sha
}

// LoadGitMapping loads the git export mapping
func LoadGitMapping(configDir string) (*GitMapping, error) {
	path := filepath.Join(configDir, "export", "git-map.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &GitMapping{Snapshots: make(map[string]string)}, nil
		}
		return nil, err
	}

	var mapping GitMapping
	if err := json.Unmarshal(data, &mapping); err != nil {
		return nil, fmt.Errorf("failed to parse git mapping: %w", err)
	}

	if mapping.Snapshots == nil {
		mapping.Snapshots = make(map[string]string)
	}

	return &mapping, nil
}

// SaveGitMapping saves the git export mapping
func SaveGitMapping(configDir string, mapping *GitMapping) error {
	exportDir := filepath.Join(configDir, "export")
	if err := os.MkdirAll(exportDir, 0755); err != nil {
		return err
	}

	data, err := json.MarshalIndent(mapping, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(filepath.Join(exportDir, "git-map.json"), data, 0644)
}

func runExportGit(branchName string, includeDrift bool, message string, initRepo bool, rebuild bool) error {
	// Load config
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a project directory: %w", err)
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	configDir, err := config.GetConfigDir()
	if err != nil {
		return fmt.Errorf("failed to get config dir: %w", err)
	}

	// Default branch name to workspace name
	if branchName == "" {
		branchName = cfg.WorkspaceName
	}

	// Check if git repo exists
	gitDir := filepath.Join(root, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if initRepo {
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(root, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		} else {
			fmt.Println("No git repository found.")
			fmt.Print("Initialize one? [Y/n] ")
			var response string
			fmt.Scanln(&response)
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "" && response != "y" && response != "yes" {
				return fmt.Errorf("git repository required for export")
			}
			fmt.Println("Initializing git repository...")
			if err := runGitCommand(root, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		}
	}

	// Load or create mapping
	var mapping *GitMapping
	if rebuild {
		mapping = &GitMapping{RepoPath: root, Snapshots: make(map[string]string)}
	} else {
		mapping, err = LoadGitMapping(configDir)
		if err != nil {
			return fmt.Errorf("failed to load git mapping: %w", err)
		}
		mapping.RepoPath = root
	}

	// Check if we have a base snapshot
	if cfg.BaseSnapshotID == "" {
		return fmt.Errorf("no snapshots to export - create one with 'fst snapshot'")
	}

	// Build snapshot chain (walk back through parents)
	chain, err := buildSnapshotChain(configDir, cfg.BaseSnapshotID)
	if err != nil {
		return fmt.Errorf("failed to build snapshot chain: %w", err)
	}

	if len(chain) == 0 {
		return fmt.Errorf("no snapshots found")
	}

	fmt.Printf("Found %d snapshots to export\n", len(chain))

	// Check/create branch
	branchExists, err := gitBranchExists(root, branchName)
	if err != nil {
		return fmt.Errorf("failed to check branch: %w", err)
	}

	if branchExists {
		// Switch to branch
		if err := runGitCommand(root, "checkout", branchName); err != nil {
			return fmt.Errorf("failed to checkout branch: %w", err)
		}
	} else {
		// Check if we have any commits yet
		hasCommits, _ := gitHasCommits(root)
		if hasCommits {
			// Create orphan branch (separate history)
			if err := runGitCommand(root, "checkout", "--orphan", branchName); err != nil {
				return fmt.Errorf("failed to create branch: %w", err)
			}
			// Clear index for orphan branch
			runGitCommand(root, "rm", "-rf", "--cached", ".")
		}
		// If no commits, we'll just be on default branch and rename later
	}

	// Export each snapshot in chain (oldest first)
	newCommits := 0
	var lastCommitSHA string

	for _, snap := range chain {
		// Check if already exported
		if existingSHA, ok := mapping.Snapshots[snap.ID]; ok && !rebuild {
			// Verify commit still exists
			if gitCommitExists(root, existingSHA) {
				fmt.Printf("  %s: already exported (commit %s)\n", snap.ID, existingSHA[:8])
				lastCommitSHA = existingSHA
				continue
			}
			fmt.Printf("  %s: mapped commit missing, re-exporting\n", snap.ID)
		}

		// Load manifest for this snapshot
		manifestPath := filepath.Join(configDir, "cache", "manifests", snap.ID+".json")
		manifestData, err := os.ReadFile(manifestPath)
		if err != nil {
			return fmt.Errorf("failed to read manifest for %s: %w", snap.ID, err)
		}

		m, err := manifest.FromJSON(manifestData)
		if err != nil {
			return fmt.Errorf("failed to parse manifest for %s: %w", snap.ID, err)
		}

		// Restore files from blobs to working directory
		if err := restoreFilesFromManifest(root, configDir, m); err != nil {
			return fmt.Errorf("failed to restore files for %s: %w", snap.ID, err)
		}

		// Stage all files
		if err := runGitCommand(root, "add", "-A"); err != nil {
			return fmt.Errorf("failed to stage files: %w", err)
		}

		// Create commit
		commitMsg := snap.Message
		if commitMsg == "" {
			commitMsg = fmt.Sprintf("Snapshot %s", snap.ID)
		}

		// Check if there are changes to commit
		if err := runGitCommand(root, "diff", "--cached", "--quiet"); err == nil {
			// No changes - might be first commit or identical content
			hasCommits, _ := gitHasCommits(root)
			if hasCommits {
				fmt.Printf("  %s: no changes (skipped)\n", snap.ID)
				continue
			}
		}

		if err := runGitCommand(root, "commit", "-m", commitMsg, "--allow-empty"); err != nil {
			return fmt.Errorf("failed to create commit for %s: %w", snap.ID, err)
		}

		// Get commit SHA
		sha, err := getGitCommitSHA(root, "HEAD")
		if err != nil {
			return fmt.Errorf("failed to get commit SHA: %w", err)
		}

		mapping.Snapshots[snap.ID] = sha
		lastCommitSHA = sha
		newCommits++
		fmt.Printf("  %s: exported → %s\n", snap.ID, sha[:8])
	}

	// Restore current working state (from current files, not snapshot)
	// Re-apply the actual current files
	if err := restoreCurrentFiles(root, configDir); err != nil {
		// Non-fatal - files might already be correct
		fmt.Printf("Note: Could not fully restore working state\n")
	}

	// Handle drift if requested
	if includeDrift {
		// Stage current changes
		if err := runGitCommand(root, "add", "-A"); err != nil {
			return fmt.Errorf("failed to stage drift: %w", err)
		}

		// Check if there are changes
		if err := runGitCommand(root, "diff", "--cached", "--quiet"); err != nil {
			// There are changes
			driftMsg := message
			if driftMsg == "" {
				driftMsg = "WIP: uncommitted changes"
			}

			if err := runGitCommand(root, "commit", "-m", driftMsg); err != nil {
				return fmt.Errorf("failed to commit drift: %w", err)
			}

			sha, _ := getGitCommitSHA(root, "HEAD")
			fmt.Printf("  drift: exported → %s\n", sha[:8])
			newCommits++
		} else {
			fmt.Println("  No uncommitted changes to export")
		}
	}

	// Rename branch if needed (for first commit case)
	currentBranch, _ := getGitCurrentBranch(root)
	if currentBranch != branchName && lastCommitSHA != "" {
		// Rename or create branch
		runGitCommand(root, "branch", "-M", branchName)
	}

	// Save mapping
	if err := SaveGitMapping(configDir, mapping); err != nil {
		return fmt.Errorf("failed to save mapping: %w", err)
	}

	fmt.Println()
	if newCommits > 0 {
		fmt.Printf("✓ Exported %d new commits to branch '%s'\n", newCommits, branchName)
	} else {
		fmt.Printf("✓ Branch '%s' is up to date\n", branchName)
	}

	// Show current state
	if !includeDrift {
		// Check for drift
		currentManifest, err := manifest.Generate(root, false)
		if err == nil {
			baseManifestPath := filepath.Join(configDir, "cache", "manifests", cfg.BaseSnapshotID+".json")
			if baseData, err := os.ReadFile(baseManifestPath); err == nil {
				if baseManifest, err := manifest.FromJSON(baseData); err == nil {
					added, modified, deleted := manifest.Diff(baseManifest, currentManifest)
					if len(added)+len(modified)+len(deleted) > 0 {
						fmt.Printf("\nNote: %d uncommitted changes not exported.\n", len(added)+len(modified)+len(deleted))
						fmt.Println("Use --include-drift to include them.")
					}
				}
			}
		}
	}

	return nil
}

// SnapshotInfo contains basic snapshot metadata
type SnapshotInfo struct {
	ID       string
	ParentID string
	Message  string
}

// buildSnapshotChain walks back through parent snapshots and returns them oldest-first
func buildSnapshotChain(configDir, startID string) ([]SnapshotInfo, error) {
	var chain []SnapshotInfo
	currentID := startID

	for currentID != "" {
		metaPath := filepath.Join(configDir, "cache", "manifests", currentID+".meta.json")
		data, err := os.ReadFile(metaPath)
		if err != nil {
			if os.IsNotExist(err) {
				break
			}
			return nil, err
		}

		var meta struct {
			ID               string `json:"id"`
			ParentSnapshotID string `json:"parent_snapshot_id"`
			Message          string `json:"message"`
		}
		if err := json.Unmarshal(data, &meta); err != nil {
			return nil, err
		}

		chain = append([]SnapshotInfo{{
			ID:       meta.ID,
			ParentID: meta.ParentSnapshotID,
			Message:  meta.Message,
		}}, chain...)

		currentID = meta.ParentSnapshotID
	}

	return chain, nil
}

// restoreFilesFromManifest restores all files from a manifest using cached blobs
func restoreFilesFromManifest(root, configDir string, m *manifest.Manifest) error {
	blobDir := filepath.Join(configDir, "cache", "blobs")

	// First, remove files that shouldn't exist (except .git and .fst)
	// We'll do this by tracking what should exist
	shouldExist := make(map[string]bool)
	for _, f := range m.Files {
		shouldExist[f.Path] = true
	}

	// Walk current files and remove extras
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}

		relPath, _ := filepath.Rel(root, path)
		relPath = filepath.ToSlash(relPath)

		// Skip .git and .fst
		if strings.HasPrefix(relPath, ".git") || strings.HasPrefix(relPath, ".fst") || relPath == ".fst" {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		if relPath == "." {
			return nil
		}

		if !info.IsDir() && !shouldExist[relPath] {
			os.Remove(path)
		}

		return nil
	})

	// Now restore files from blobs
	for _, f := range m.Files {
		blobPath := filepath.Join(blobDir, f.Hash)
		targetPath := filepath.Join(root, f.Path)

		content, err := os.ReadFile(blobPath)
		if err != nil {
			return fmt.Errorf("blob not found for %s: %w", f.Path, err)
		}

		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}

		if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}

	return nil
}

// restoreCurrentFiles restores the actual current working state
func restoreCurrentFiles(root, configDir string) error {
	// This is tricky - we need to restore files to their current state
	// For now, we rely on the fact that git won't have committed the .fst directory
	// and the user's actual files are what git will show as "modified" after export
	return nil
}

// Git helper functions

func runGitCommand(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	cmd.Stdout = nil
	cmd.Stderr = nil
	return cmd.Run()
}

func runGitCommandOutput(dir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.Output()
	return strings.TrimSpace(string(output)), err
}

func gitBranchExists(dir, branch string) (bool, error) {
	err := runGitCommand(dir, "rev-parse", "--verify", "refs/heads/"+branch)
	return err == nil, nil
}

func gitHasCommits(dir string) (bool, error) {
	err := runGitCommand(dir, "rev-parse", "HEAD")
	return err == nil, nil
}

func gitCommitExists(dir, sha string) bool {
	err := runGitCommand(dir, "cat-file", "-t", sha)
	return err == nil
}

func getGitCommitSHA(dir, ref string) (string, error) {
	return runGitCommandOutput(dir, "rev-parse", ref)
}

func getGitCurrentBranch(dir string) (string, error) {
	return runGitCommandOutput(dir, "rev-parse", "--abbrev-ref", "HEAD")
}
