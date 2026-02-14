package commands

import (
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/backend"
	"github.com/anthropics/fastest/cli/internal/config"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newGitHubCmd()) })
}

func newGitHubCmd() *cobra.Command {
	cmd := &cobra.Command{
		Use:   "github",
		Short: "GitHub import/export tools",
		Long:  "Import and export workspace history to and from GitHub repositories.",
	}

	cmd.AddCommand(newGitHubExportCmd())
	cmd.AddCommand(newGitHubImportCmd())

	return cmd
}

func newGitHubExportCmd() *cobra.Command {
	var initRepo bool
	var rebuild bool
	var remoteName string
	var createRepo bool
	var privateRepo bool
	var forceRemote bool
	var noGH bool

	cmd := &cobra.Command{
		Use:   "export <owner>/<repo>",
		Short: "Export to a GitHub repository",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGitHubExport(args[0], initRepo, rebuild, remoteName, createRepo, privateRepo, forceRemote, noGH)
		},
	}

	cmd.Flags().BoolVar(&initRepo, "init", false, "Initialize git repo if it doesn't exist")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild all commits from scratch (ignores existing mapping)")
	cmd.Flags().StringVar(&remoteName, "remote", "origin", "Remote name to push to")
	cmd.Flags().BoolVar(&createRepo, "create", false, "Create the GitHub repo if it doesn't exist (requires gh)")
	cmd.Flags().BoolVar(&privateRepo, "private", false, "Create repo as private (requires --create)")
	cmd.Flags().BoolVar(&forceRemote, "force-remote", false, "Overwrite remote URL if it already exists")
	cmd.Flags().BoolVar(&noGH, "no-gh", false, "Disable gh CLI even if installed")

	return cmd
}

func newGitHubImportCmd() *cobra.Command {
	var projectName string
	var rebuild bool
	var noGH bool

	cmd := &cobra.Command{
		Use:   "import <owner>/<repo>",
		Short: "Import from a GitHub repository exported by fst",
		Args:  cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			return runGitHubImport(args[0], projectName, rebuild, noGH)
		},
	}

	cmd.Flags().StringVarP(&projectName, "project", "p", "", "Project name when creating a new project")
	cmd.Flags().BoolVar(&rebuild, "rebuild", false, "Rebuild snapshots from scratch (overwrites existing snapshot history)")
	cmd.Flags().BoolVar(&noGH, "no-gh", false, "Disable gh CLI even if installed")

	return cmd
}

func runGitHubExport(repo string, initRepo bool, rebuild bool, remoteName string, createRepo bool, privateRepo bool, forceRemote bool, noGH bool) error {
	// Find project root
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

	useGH := !noGH && hasGH()
	slug, remoteURL, err := parseGitHubRepo(repo)
	if err != nil {
		return err
	}

	if createRepo {
		if !useGH {
			return fmt.Errorf("gh CLI required to create repos (install gh or pass --no-gh=false)")
		}
		args := []string{"repo", "create", slug, "--confirm"}
		if privateRepo {
			args = append(args, "--private")
		} else {
			args = append(args, "--public")
		}
		if err := runGHCommand(projectRoot, args...); err != nil {
			return fmt.Errorf("failed to create repo: %w", err)
		}
	}

	if err := runExportGit(initRepo, rebuild); err != nil {
		return err
	}

	existingURL, exists, err := getGitRemoteURL(projectRoot, remoteName)
	if err != nil {
		return err
	}
	if exists {
		if existingURL != remoteURL {
			if !forceRemote {
				return fmt.Errorf("remote '%s' already set to %s (use --force-remote to override)", remoteName, existingURL)
			}
			if err := runGitCommand(projectRoot, "remote", "set-url", remoteName, remoteURL); err != nil {
				return fmt.Errorf("failed to update remote '%s': %w", remoteName, err)
			}
		}
	} else {
		if err := runGitCommand(projectRoot, "remote", "add", remoteName, remoteURL); err != nil {
			return fmt.Errorf("failed to add remote '%s': %w", remoteName, err)
		}
	}

	return PushExportToRemote(projectRoot, remoteName)
}

func runGitHubImport(repo string, projectName string, rebuild bool, noGH bool) error {
	useGH := !noGH && hasGH()
	_, remoteURL, err := parseGitHubRepo(repo)
	if err != nil {
		return err
	}

	tempRepoDir, err := os.MkdirTemp("", "fst-github-import-")
	if err != nil {
		return fmt.Errorf("failed to create temp import directory: %w", err)
	}
	defer os.RemoveAll(tempRepoDir)

	if useGH && isGitHubSlug(repo) {
		if err := runGHCommand("", "repo", "clone", repo, tempRepoDir); err != nil {
			return fmt.Errorf("failed to clone via gh: %w", err)
		}
	} else {
		if err := runGitCommand("", "clone", remoteURL, tempRepoDir); err != nil {
			return fmt.Errorf("failed to clone repo: %w", err)
		}
	}

	if err := runGitCommand(tempRepoDir, "fetch", "origin", "refs/fst/*:refs/fst/*"); err != nil {
		return fmt.Errorf("failed to fetch export metadata refs: %w", err)
	}

	return runImportGit(tempRepoDir, projectName, rebuild)
}

func hasGH() bool {
	_, err := exec.LookPath("gh")
	return err == nil
}

func runGHCommand(dir string, args ...string) error {
	cmd := exec.Command("gh", args...)
	if dir != "" {
		cmd.Dir = dir
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("gh %s: %s", strings.Join(args, " "), message)
	}
	return nil
}

func getGitRemoteURL(repoRoot, remote string) (string, bool, error) {
	cmd := exec.Command("git", "-C", repoRoot, "remote", "get-url", remote)
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if strings.Contains(message, "No such remote") || strings.Contains(message, "No remote") {
			return "", false, nil
		}
		if message == "" {
			message = err.Error()
		}
		return "", false, fmt.Errorf("git remote get-url %s: %s", remote, message)
	}
	return strings.TrimSpace(string(output)), true, nil
}

func isGitHubSlug(repo string) bool {
	trimmed := strings.TrimSpace(repo)
	if trimmed == "" {
		return false
	}
	if strings.Contains(trimmed, "://") || strings.Contains(trimmed, "@") {
		return false
	}
	parts := strings.Split(trimmed, "/")
	return len(parts) == 2 && parts[0] != "" && parts[1] != ""
}

func parseGitHubRepo(input string) (string, string, error) {
	repo := strings.TrimSpace(input)
	if repo == "" {
		return "", "", errors.New("repository is required")
	}

	if strings.HasPrefix(repo, "git@github.com:") {
		slug := strings.TrimPrefix(repo, "git@github.com:")
		slug = strings.TrimSuffix(slug, ".git")
		return slug, "https://github.com/" + slug + ".git", nil
	}

	if strings.HasPrefix(repo, "http://") || strings.HasPrefix(repo, "https://") {
		u, err := url.Parse(repo)
		if err != nil {
			return "", "", fmt.Errorf("invalid GitHub URL: %w", err)
		}
		if !isGitHubHost(u.Host) {
			return "", "", fmt.Errorf("unsupported GitHub host: %s", u.Host)
		}
		path := strings.Trim(u.Path, "/")
		path = strings.TrimSuffix(path, ".git")
		if path == "" {
			return "", "", fmt.Errorf("invalid GitHub URL path: %s", repo)
		}
		slug := path
		return slug, repo, nil
	}

	if strings.Contains(repo, "github.com/") {
		parts := strings.SplitN(repo, "github.com/", 2)
		path := strings.Trim(parts[1], "/")
		path = strings.TrimSuffix(path, ".git")
		if path == "" {
			return "", "", fmt.Errorf("invalid GitHub URL: %s", repo)
		}
		return path, "https://github.com/" + path + ".git", nil
	}

	if isGitHubSlug(repo) {
		return repo, "https://github.com/" + repo + ".git", nil
	}

	return "", "", fmt.Errorf("unsupported GitHub repo format: %s", repo)
}

func isGitHubHost(host string) bool {
	host = strings.ToLower(strings.TrimSpace(host))
	if host == "github.com" {
		return true
	}
	return strings.HasSuffix(host, ".github.com")
}

// PushExportToRemote pushes all exported workspace branches and metadata to the given remote.
// Returns backend.ErrPushRejected if a push is rejected due to non-fast-forward.
func PushExportToRemote(projectRoot string, remoteName string) error {
	meta, err := loadExportMetadataFromRepo(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return fmt.Errorf("missing export metadata in repo")
	}
	branches := collectExportBranches(meta)

	for _, branch := range branches {
		if err := runGitPush(projectRoot, remoteName, branch); err != nil {
			return err
		}
	}
	if err := runGitPush(projectRoot, remoteName, fstMetaRef); err != nil {
		return err
	}

	return nil
}

// runGitPush pushes a single refspec and returns backend.ErrPushRejected for
// non-fast-forward rejections, distinguishing them from auth/network errors.
func runGitPush(repoDir, remoteName, refspec string) error {
	cmd := exec.Command("git", "-C", repoDir, "push", remoteName, refspec)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := string(output)
	if isPushRejected(msg) {
		return fmt.Errorf("push rejected for '%s': %w", refspec, backend.ErrPushRejected)
	}
	trimmed := strings.TrimSpace(msg)
	if trimmed == "" {
		trimmed = err.Error()
	}
	return fmt.Errorf("failed to push '%s': %s", refspec, trimmed)
}

// isPushRejected checks if git push output indicates a non-fast-forward rejection.
func isPushRejected(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "[rejected]") ||
		strings.Contains(lower, "non-fast-forward") ||
		strings.Contains(lower, "fetch first") ||
		strings.Contains(lower, "were rejected")
}

func loadExportMetadataFromRepo(repoRoot string) (*exportMeta, error) {
	tempDir, err := os.MkdirTemp("", "fst-export-meta-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := newGitEnv(repoRoot, tempDir, indexPath)
	return loadExportMetadata(git)
}

func collectExportBranches(meta *exportMeta) []string {
	branches := make([]string, 0, len(meta.Workspaces))
	seen := make(map[string]struct{}, len(meta.Workspaces))
	for _, ws := range meta.Workspaces {
		if ws.Branch == "" {
			continue
		}
		if _, ok := seen[ws.Branch]; ok {
			continue
		}
		seen[ws.Branch] = struct{}{}
		branches = append(branches, ws.Branch)
	}
	return branches
}
