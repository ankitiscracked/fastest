package backend

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/gitstore"
	"github.com/anthropics/fastest/cli/internal/gitutil"
	"github.com/anthropics/fastest/cli/internal/store"
)

// GitHubBackend exports snapshots to git and syncs with a GitHub remote.
type GitHubBackend struct {
	Repo      string // "owner/repo"
	Remote    string // git remote name
	ExportGit ExportFunc
}

func (b *GitHubBackend) Type() string { return "github" }

func (b *GitHubBackend) Push(projectRoot string) error {
	if err := b.ExportGit(projectRoot, false, false); err != nil {
		return err
	}
	return gitstore.PushExportToRemote(projectRoot, b.Remote)
}

func (b *GitHubBackend) Sync(projectRoot string, opts *SyncOptions) error {
	// Export any new local snapshots
	if err := b.ExportGit(projectRoot, false, false); err != nil {
		return err
	}

	// Optimistic push — try pushing first
	pushErr := gitstore.PushExportToRemote(projectRoot, b.Remote)
	if pushErr == nil {
		return nil
	}

	// Only fall back to fetch+import if push was rejected (non-fast-forward).
	// Auth errors, network errors, etc. should be surfaced directly.
	if !errors.Is(pushErr, gitutil.ErrPushRejected) {
		return pushErr
	}

	// Push was rejected — fetch, import, merge diverged, re-export, push
	fmt.Println("Push rejected, fetching remote changes...")
	if err := FetchFromRemote(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fetch from remote: %w", err)
	}

	if err := FastForwardBranches(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fast-forward branches: %w", err)
	}

	result, err := IncrementalImportFromGit(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to import remote changes: %w", err)
	}

	// Handle diverged workspaces
	for _, div := range result.Diverged {
		if opts == nil || opts.OnDivergence == nil {
			return fmt.Errorf("workspace '%s' has diverged from remote; run 'fst sync' interactively to resolve", div.WorkspaceName)
		}
		mergedID, mergeErr := opts.OnDivergence(div)
		if mergeErr != nil {
			return fmt.Errorf("failed to merge diverged workspace '%s': %w", div.WorkspaceName, mergeErr)
		}
		// Update workspace config with merged snapshot
		wsCfg, loadErr := config.LoadAt(div.WorkspaceRoot)
		if loadErr != nil {
			return fmt.Errorf("failed to load workspace config for '%s': %w", div.WorkspaceName, loadErr)
		}
		wsCfg.CurrentSnapshotID = mergedID
		if saveErr := config.SaveAt(div.WorkspaceRoot, wsCfg); saveErr != nil {
			return fmt.Errorf("failed to save workspace config for '%s': %w", div.WorkspaceName, saveErr)
		}
		s := store.OpenAt(projectRoot)
		_ = s.RegisterWorkspace(store.WorkspaceInfo{
			WorkspaceID:       wsCfg.WorkspaceID,
			WorkspaceName:     wsCfg.WorkspaceName,
			Path:              div.WorkspaceRoot,
			CurrentSnapshotID: mergedID,
			BaseSnapshotID:    wsCfg.BaseSnapshotID,
			CreatedAt:         time.Now().UTC().Format(time.RFC3339),
		})
	}

	// Re-export with the new imported/merged snapshots as parents
	if err := b.ExportGit(projectRoot, false, false); err != nil {
		return err
	}

	return gitstore.PushExportToRemote(projectRoot, b.Remote)
}

func (b *GitHubBackend) Pull(projectRoot string) error {
	if err := FetchFromRemote(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fetch from remote: %w", err)
	}

	if err := FastForwardBranches(projectRoot, b.Remote); err != nil {
		return fmt.Errorf("failed to fast-forward branches: %w", err)
	}

	_, err := IncrementalImportFromGit(projectRoot)
	return err
}

// FetchFromRemote fetches all branches and fst metadata from the remote.
func FetchFromRemote(projectRoot, remoteName string) error {
	if err := gitutil.RunCommand(projectRoot, "fetch", remoteName); err != nil {
		return err
	}
	return gitutil.RunCommand(projectRoot, "fetch", remoteName, "refs/fst/*:refs/fst/*")
}

// FastForwardBranches updates local branch refs to match remote tracking branches
// only when the remote is strictly ahead (fast-forward). If branches have diverged,
// the branch is left unchanged — the subsequent import + merge will handle it.
func FastForwardBranches(projectRoot, remoteName string) error {
	tempDir, err := os.MkdirTemp("", "fst-ff-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := gitutil.NewEnv(projectRoot, tempDir, indexPath)

	meta, err := gitstore.LoadExportMetadata(git)
	if err != nil {
		return fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return nil
	}

	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}
		remoteRef := remoteName + "/" + ws.Branch
		remoteSHA, err := git.Output("rev-parse", "--verify", remoteRef)
		if err != nil {
			continue // remote branch doesn't exist
		}
		remoteSHA = strings.TrimSpace(remoteSHA)
		if remoteSHA == "" {
			continue
		}

		localSHA, err := gitutil.RefSHA(git, "refs/heads/"+ws.Branch)
		if err != nil {
			// Local branch doesn't exist yet — create it at remote
			_ = gitutil.UpdateBranchRef(git, ws.Branch, remoteSHA)
			continue
		}

		if localSHA == remoteSHA {
			continue // already in sync
		}

		// Check if local is ancestor of remote (remote is ahead → fast-forward)
		if gitutil.IsAncestor(git, localSHA, remoteSHA) {
			_ = gitutil.UpdateBranchRef(git, ws.Branch, remoteSHA)
			continue
		}

		// Check if remote is ancestor of local (local is ahead → nothing to do)
		if gitutil.IsAncestor(git, remoteSHA, localSHA) {
			continue
		}

		// Branches have diverged — skip; import + merge will handle this
		fmt.Printf("  Branch %s has diverged from remote, will reconcile during sync\n", ws.Branch)
	}
	return nil
}

// ImportResult contains the outcome of an incremental import.
type ImportResult struct {
	NewSnapshots int
	Diverged     []DivergenceInfo
}

// IncrementalImportFromGit imports new git commits that aren't yet mapped to snapshots.
// Returns divergence info for workspaces where the local head has drifted.
func IncrementalImportFromGit(projectRoot string) (*ImportResult, error) {
	result := &ImportResult{}

	configDir := filepath.Join(projectRoot, ".fst")
	mapping, err := gitstore.LoadGitMapping(configDir)
	if err != nil {
		return nil, fmt.Errorf("failed to load git mapping: %w", err)
	}

	// Build reverse map: commit SHA → snapshot ID
	commitToSnapshot := make(map[string]string, len(mapping.Snapshots))
	for snapID, commitSHA := range mapping.Snapshots {
		commitToSnapshot[commitSHA] = snapID
	}

	// Keep a snapshot of the original map to detect which commits were already known
	originalCommitToSnapshot := make(map[string]string, len(commitToSnapshot))
	for k, v := range commitToSnapshot {
		originalCommitToSnapshot[k] = v
	}

	tempDir, err := os.MkdirTemp("", "fst-incr-import-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := gitutil.NewEnv(projectRoot, tempDir, indexPath)

	meta, err := gitstore.LoadExportMetadata(git)
	if err != nil {
		return nil, fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return nil, fmt.Errorf("no export metadata found")
	}

	parentCfg, err := config.LoadParentConfigAt(projectRoot)
	if err != nil {
		return nil, fmt.Errorf("failed to load project config: %w", err)
	}

	s := store.OpenAt(projectRoot)

	workTempDir, err := os.MkdirTemp("", "fst-incr-worktree-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(workTempDir)

	importIndex := filepath.Join(workTempDir, "index")
	importGit := gitutil.NewEnv(projectRoot, workTempDir, importIndex)

	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}

		commits, err := gitutil.RevList(importGit, ws.Branch)
		if err != nil {
			return nil, fmt.Errorf("failed to list commits for branch %s: %w", ws.Branch, err)
		}

		// Filter to only new commits
		var newCommits []string
		for _, commit := range commits {
			if _, known := commitToSnapshot[commit]; !known {
				newCommits = append(newCommits, commit)
			}
		}

		if len(newCommits) == 0 {
			continue
		}

		fmt.Printf("Importing %d new commits from branch %s\n", len(newCommits), ws.Branch)

		wsName := ws.WorkspaceName
		if wsName == "" {
			wsName = ws.Branch
		}

		// Find or create workspace config
		wsRoot := filepath.Join(projectRoot, wsName)
		wsCfg, err := ensureWorkspaceForImport(wsRoot, parentCfg.ProjectID, ws.WorkspaceID, wsName)
		if err != nil {
			return nil, err
		}

		for _, commit := range newCommits {
			info, err := gitutil.ReadCommitInfo(importGit, commit)
			if err != nil {
				return nil, err
			}
			if err := gitutil.CheckoutTree(importGit, commit); err != nil {
				return nil, err
			}

			// Resolve parent snapshots from commit parents
			parentSnapshots := make([]string, 0, len(info.Parents))
			for _, parent := range info.Parents {
				if snapID, ok := commitToSnapshot[parent]; ok {
					parentSnapshots = append(parentSnapshots, snapID)
				}
			}

			agentName := ""
			if strings.HasSuffix(strings.ToLower(info.AuthorEmail), "@fastest.local") {
				agentName = info.AuthorName
			}

			snapshotID, err := gitstore.CreateImportedSnapshot(s, workTempDir, wsCfg, parentSnapshots, info.Subject, info.AuthorDate, info.AuthorName, info.AuthorEmail, agentName)
			if err != nil {
				return nil, err
			}

			// Update both maps
			commitToSnapshot[commit] = snapshotID
			mapping.Snapshots[snapshotID] = commit
			result.NewSnapshots++
		}

		// Update workspace head to branch tip, but only if the current head
		// is still what we expect (no local drift since last sync).
		tipCommit := commits[len(commits)-1]
		tipSnapID, ok := commitToSnapshot[tipCommit]
		if !ok {
			continue
		}

		// Reload config to get the freshest head
		freshCfg, loadErr := config.LoadAt(wsRoot)
		if loadErr != nil {
			freshCfg = wsCfg
		}
		currentHead := freshCfg.CurrentSnapshotID

		// Find the previous tip (the last commit we already knew about)
		previousTipSnap := ""
		for i := len(commits) - 1; i >= 0; i-- {
			snap, known := commitToSnapshot[commits[i]]
			if known && snap != "" {
				if _, wasKnown := originalCommitToSnapshot[commits[i]]; wasKnown {
					previousTipSnap = snap
					break
				}
			}
		}

		// Only update if head hasn't drifted (matches previous tip or is empty)
		if currentHead == "" || currentHead == previousTipSnap || currentHead == tipSnapID {
			freshCfg.CurrentSnapshotID = tipSnapID
			if err := config.SaveAt(wsRoot, freshCfg); err != nil {
				return nil, fmt.Errorf("failed to save workspace config: %w", err)
			}
			_ = s.RegisterWorkspace(store.WorkspaceInfo{
				WorkspaceID:       freshCfg.WorkspaceID,
				WorkspaceName:     freshCfg.WorkspaceName,
				Path:              wsRoot,
				CurrentSnapshotID: tipSnapID,
				BaseSnapshotID:    freshCfg.BaseSnapshotID,
				CreatedAt:         time.Now().UTC().Format(time.RFC3339),
			})
		} else {
			// Local head has diverged — report for merge
			result.Diverged = append(result.Diverged, DivergenceInfo{
				ProjectRoot:   projectRoot,
				WorkspaceName: wsName,
				WorkspaceRoot: wsRoot,
				LocalHead:     currentHead,
				RemoteHead:    tipSnapID,
				MergeBase:     previousTipSnap,
			})
		}
	}

	// Save updated mapping
	if err := gitstore.SaveGitMapping(configDir, mapping); err != nil {
		return nil, fmt.Errorf("failed to save git mapping: %w", err)
	}

	if result.NewSnapshots > 0 {
		fmt.Printf("Imported %d new snapshots\n", result.NewSnapshots)
	} else {
		fmt.Println("Already up to date")
	}

	return result, nil
}

// ensureWorkspaceForImport finds or creates a workspace directory and config.
func ensureWorkspaceForImport(wsRoot, projectID, workspaceID, wsName string) (*config.ProjectConfig, error) {
	if _, err := os.Stat(filepath.Join(wsRoot, ".fst", "config.json")); err == nil {
		// Workspace exists
		return config.LoadAt(wsRoot)
	}

	// Create workspace
	if err := os.MkdirAll(wsRoot, 0755); err != nil {
		return nil, fmt.Errorf("failed to create workspace directory: %w", err)
	}
	if workspaceID == "" {
		workspaceID = generateWorkspaceID()
	}
	if err := config.InitAt(wsRoot, projectID, workspaceID, wsName, ""); err != nil {
		return nil, fmt.Errorf("failed to initialize workspace: %w", err)
	}
	return config.LoadAt(wsRoot)
}

func generateWorkspaceID() string {
	bytes := make([]byte, 8)
	rand.Read(bytes)
	return "ws-" + hex.EncodeToString(bytes)
}
