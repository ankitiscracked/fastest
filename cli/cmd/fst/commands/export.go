package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitstore"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

func newExportGitCmd() *cobra.Command {
	var initRepo bool
	var rebuild bool

	cmd := &cobra.Command{
		Use:   "export",
		Short: "Export project to Git repository",
		Long: `Export all workspace snapshots to Git commits.

Each workspace becomes a Git branch (named after the workspace).
The Git repository is created at the project root.

This will:
1. Walk the snapshot DAG for each workspace
2. Create Git commits preserving the snapshot history
3. Create one branch per workspace

The mapping is stored in .fst/export/git-map.json to enable incremental exports.
Subsequent exports only create commits for new snapshots.

Examples:
  fst git export                     # Export all workspaces
  fst git export --init              # Initialize git repo if needed
  fst git export --rebuild           # Rebuild all commits from scratch`,
		RunE: func(cmd *cobra.Command, args []string) error {
			return runExportGit(initRepo, rebuild)
		},
	}

	cmd.Flags().BoolVar(&initRepo, "init", false, "Initialize git repo if it doesn't exist")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild all commits from scratch (ignores existing mapping)")

	return cmd
}

func runExportGit(initRepo bool, rebuild bool) error {
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("failed to get current directory: %w", err)
	}

	projectRoot, _, err := config.FindParentRootFrom(cwd)
	if err != nil {
		if wsRoot, findErr := config.FindProjectRoot(); findErr == nil {
			projectRoot, _, err = config.FindParentRootFrom(wsRoot)
		}
		if err != nil {
			return fmt.Errorf("not in a project (no fst.json found): %w", err)
		}
	}

	return RunExportGitAt(projectRoot, initRepo, rebuild)
}

// RunExportGitAt exports all workspace snapshots to Git commits at the given project root.
func RunExportGitAt(projectRoot string, initRepo bool, rebuild bool) error {
	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to load project config: %w", err)
	}

	s := store.OpenAt(projectRoot)
	configDir := filepath.Join(projectRoot, ".fst")

	// Check if git repo exists
	gitDir := filepath.Join(projectRoot, ".git")
	if _, err := os.Stat(gitDir); os.IsNotExist(err) {
		if initRepo {
			fmt.Println("Initializing git repository...")
			if err := gitutil.RunCommand(projectRoot, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		} else {
			fmt.Println("No git repository found at project root.")
			fmt.Print("Initialize one? [Y/n] ")
			var response string
			fmt.Scanln(&response)
			response = strings.TrimSpace(strings.ToLower(response))
			if response != "" && response != "y" && response != "yes" {
				return fmt.Errorf("git repository required for export")
			}
			fmt.Println("Initializing git repository...")
			if err := gitutil.RunCommand(projectRoot, "init"); err != nil {
				return fmt.Errorf("failed to init git repo: %w", err)
			}
		}
	}

	tempDir, err := os.MkdirTemp("", "fst-export-git-")
	if err != nil {
		return fmt.Errorf("failed to create temp export directory: %w", err)
	}
	defer os.RemoveAll(tempDir)

	indexDir, err := os.MkdirTemp("", "fst-export-index-")
	if err != nil {
		return fmt.Errorf("failed to create temp index directory: %w", err)
	}
	defer os.RemoveAll(indexDir)

	indexPath := filepath.Join(indexDir, "index")
	git := gitutil.NewEnv(projectRoot, tempDir, indexPath)

	metaDir, err := os.MkdirTemp("", "fst-export-meta-")
	if err != nil {
		return fmt.Errorf("failed to create metadata work directory: %w", err)
	}
	defer os.RemoveAll(metaDir)

	metaIndexPath := filepath.Join(indexDir, "meta-index")
	metaGit := gitutil.NewEnv(projectRoot, metaDir, metaIndexPath)

	// Load or create mapping
	var mapping *gitstore.GitMapping
	if rebuild {
		mapping = &gitstore.GitMapping{RepoPath: projectRoot, Snapshots: make(map[string]string)}
	} else {
		mapping, err = gitstore.LoadGitMapping(configDir)
		if err != nil {
			return fmt.Errorf("failed to load git mapping: %w", err)
		}
		mapping.RepoPath = projectRoot
	}

	// List all workspaces
	workspaces, err := s.ListWorkspaces()
	if err != nil {
		return fmt.Errorf("failed to list workspaces: %w", err)
	}
	if len(workspaces) == 0 {
		return fmt.Errorf("no workspaces found in project")
	}

	totalNewCommits := 0
	exportedWorkspaces := 0

	for _, ws := range workspaces {
		if ws.CurrentSnapshotID == "" {
			fmt.Printf("Skipping workspace '%s' (no snapshots)\n", ws.WorkspaceName)
			continue
		}

		branchName := ws.WorkspaceName
		fmt.Printf("\n--- Workspace: %s (branch: %s) ---\n", ws.WorkspaceName, branchName)

		newCommits, err := exportWorkspaceSnapshots(exportWorkspaceParams{
			store:      s,
			git:        git,
			mapping:    mapping,
			branchName: branchName,
			snapshotID: ws.CurrentSnapshotID,
			wsName:     ws.WorkspaceName,
			rebuild:    rebuild,
		})
		if err != nil {
			// Save mapping so progress from previous workspaces isn't lost
			_ = gitstore.SaveGitMapping(configDir, mapping)
			return fmt.Errorf("failed to export workspace '%s': %w", ws.WorkspaceName, err)
		}
		totalNewCommits += newCommits
		exportedWorkspaces++

		// Update export metadata for this workspace
		wsCfg := &config.ProjectConfig{
			ProjectID:     parentCfg.ProjectID,
			WorkspaceID:   ws.WorkspaceID,
			WorkspaceName: ws.WorkspaceName,
		}
		if err := gitstore.UpdateExportMetadata(metaGit, wsCfg, branchName); err != nil {
			fmt.Printf("Warning: failed to update export metadata for %s: %v\n", ws.WorkspaceName, err)
		}
	}

	// Save mapping
	if err := gitstore.SaveGitMapping(configDir, mapping); err != nil {
		return fmt.Errorf("failed to save mapping: %w", err)
	}

	fmt.Println()
	if totalNewCommits > 0 {
		fmt.Printf("Exported %d new commits across %d workspaces\n", totalNewCommits, exportedWorkspaces)
	} else {
		fmt.Printf("All %d workspaces up to date\n", exportedWorkspaces)
	}

	return nil
}

type exportWorkspaceParams struct {
	store      *store.Store
	git        gitutil.Env
	mapping    *gitstore.GitMapping
	branchName string
	snapshotID string // workspace head
	wsName     string // for display
	rebuild    bool
}

func exportWorkspaceSnapshots(p exportWorkspaceParams) (int, error) {
	if p.rebuild {
		branchExists, err := gitutil.BranchExists(p.git, p.branchName)
		if err != nil {
			return 0, fmt.Errorf("failed to check branch: %w", err)
		}
		if branchExists {
			if err := gitutil.DeleteBranchRef(p.git, p.branchName); err != nil {
				return 0, fmt.Errorf("failed to reset branch '%s': %w", p.branchName, err)
			}
		}
	}

	// Build snapshot DAG
	chain, err := gitstore.BuildSnapshotDAG(p.store, p.snapshotID)
	if err != nil {
		return 0, fmt.Errorf("failed to build snapshot chain: %w", err)
	}

	if len(chain) == 0 {
		return 0, fmt.Errorf("no snapshots found")
	}

	fmt.Printf("Found %d snapshots\n", len(chain))

	newCommits := 0
	var lastCommitSHA string

	for _, snap := range chain {
		// Check if already exported
		if existingSHA, ok := p.mapping.Snapshots[snap.ID]; ok && !p.rebuild {
			if gitutil.CommitExists(p.git, existingSHA) {
				fmt.Printf("  %s: already exported (commit %s)\n", snap.ID[:12], existingSHA[:8])
				lastCommitSHA = existingSHA
				continue
			}
			fmt.Printf("  %s: mapped commit missing, re-exporting\n", snap.ID[:12])
		}

		// Load manifest
		m, err := p.store.LoadManifest(snap.ManifestHash)
		if err != nil {
			return 0, fmt.Errorf("failed to load manifest for %s: %w", snap.ID[:12], err)
		}

		// Restore files from blobs to temp working directory
		if err := gitstore.RestoreFilesFromManifest(p.git.WorkTree, p.store, m); err != nil {
			return 0, fmt.Errorf("failed to restore files for %s: %w", snap.ID[:12], err)
		}

		// Stage all files
		if err := p.git.Run("add", "-A"); err != nil {
			return 0, fmt.Errorf("failed to stage files: %w", err)
		}

		// Create commit
		commitMsg := snap.Message
		if commitMsg == "" {
			commitMsg = fmt.Sprintf("Snapshot %s", snap.ID[:12])
		}

		parentSHAs, err := gitstore.ResolveGitParentSHAs(p.git, p.mapping, snap.ParentSnapshotIDs)
		if err != nil {
			return 0, fmt.Errorf("failed to resolve parents for %s: %w", snap.ID[:12], err)
		}
		if len(parentSHAs) == 0 && len(snap.ParentSnapshotIDs) == 1 && lastCommitSHA != "" {
			parentSHAs = []string{lastCommitSHA}
		}

		treeSHA, err := gitutil.TreeSHA(p.git)
		if err != nil {
			return 0, fmt.Errorf("failed to write tree for %s: %w", snap.ID[:12], err)
		}

		meta := gitstore.CommitMetaFromSnapshot(snap)
		sha, err := gitutil.CreateCommitWithParents(p.git, treeSHA, commitMsg, parentSHAs, meta)
		if err != nil {
			return 0, fmt.Errorf("failed to create commit for %s: %w", snap.ID[:12], err)
		}
		if err := gitutil.UpdateBranchRef(p.git, p.branchName, sha); err != nil {
			return 0, fmt.Errorf("failed to update branch ref for %s: %w", snap.ID[:12], err)
		}

		p.mapping.Snapshots[snap.ID] = sha
		lastCommitSHA = sha
		newCommits++
		fmt.Printf("  %s: exported -> %s\n", snap.ID[:12], sha[:8])
	}

	// Always ensure the branch ref points to the tip commit.
	// This handles the case where all snapshots were already exported
	// (e.g., shared with another workspace that was exported first).
	if lastCommitSHA != "" {
		if err := gitutil.UpdateBranchRef(p.git, p.branchName, lastCommitSHA); err != nil {
			return 0, fmt.Errorf("failed to update branch ref: %w", err)
		}
	}

	return newCommits, nil
}

