// Package gitutil provides low-level git helpers used by the export, import,
// and backend subsystems.  All functions are pure git operations with no
// dependency on fst domain types (store, manifest, config, etc.).
package gitutil

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// ErrPushRejected is returned when a git push is rejected (non-fast-forward).
// This typically means the remote has new commits that need to be fetched first.
var ErrPushRejected = errors.New("push rejected (non-fast-forward)")

// Env bundles the paths needed for git plumbing commands that operate on a
// separate work tree and index (e.g. during export/import).
type Env struct {
	RepoRoot  string
	WorkTree  string
	IndexFile string
}

// NewEnv creates a new Env.
func NewEnv(repoRoot, workTree, indexFile string) Env {
	return Env{
		RepoRoot:  repoRoot,
		WorkTree:  workTree,
		IndexFile: indexFile,
	}
}

// GitDir returns the path to the .git directory.
func (g Env) GitDir() string {
	return filepath.Join(g.RepoRoot, ".git")
}

// CommandWithEnv builds an exec.Cmd for a git subcommand, injecting the
// GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE env vars plus any extras.
func (g Env) CommandWithEnv(extra map[string]string, args ...string) *exec.Cmd {
	cmd := exec.Command("git", args...)
	cmd.Dir = g.WorkTree
	cmd.Env = append(os.Environ(),
		"GIT_DIR="+g.GitDir(),
		"GIT_WORK_TREE="+g.WorkTree,
		"GIT_INDEX_FILE="+g.IndexFile,
	)
	for key, value := range extra {
		cmd.Env = append(cmd.Env, key+"="+value)
	}
	return cmd
}

// Command builds an exec.Cmd for a git subcommand.
func (g Env) Command(args ...string) *exec.Cmd {
	return g.CommandWithEnv(nil, args...)
}

// Run executes a git subcommand and returns an error on failure.
func (g Env) Run(args ...string) error {
	cmd := g.Command(args...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return nil
}

// Output executes a git subcommand and returns its trimmed stdout.
func (g Env) Output(args ...string) (string, error) {
	return g.OutputWithEnv(nil, args...)
}

// OutputWithEnv executes a git subcommand with extra env vars and returns
// its trimmed stdout.
func (g Env) OutputWithEnv(extra map[string]string, args ...string) (string, error) {
	cmd := g.CommandWithEnv(extra, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return strings.TrimSpace(string(output)), nil
}

// ---------------- query helpers ----------------

// CommitExists returns true if the given SHA exists in the repo.
func CommitExists(g Env, sha string) bool {
	return g.Run("cat-file", "-t", sha) == nil
}

// BranchExists returns true if refs/heads/<branch> exists.
func BranchExists(g Env, branch string) (bool, error) {
	cmd := g.Command("show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	if err := cmd.Run(); err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return false, nil
		}
		return false, err
	}
	return true, nil
}

// RefSHA returns the SHA for the given ref, or os.ErrNotExist if the ref
// does not exist.
func RefSHA(g Env, ref string) (string, error) {
	cmd := g.Command("show-ref", "--verify", "--hash", ref)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	output, err := cmd.Output()
	if err != nil {
		if _, ok := err.(*exec.ExitError); ok {
			return "", os.ErrNotExist
		}
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = err.Error()
		}
		return "", fmt.Errorf("git show-ref --verify --hash %s: %s", ref, message)
	}
	return strings.TrimSpace(string(output)), nil
}

// CurrentBranch returns the current branch name (abbrev-ref HEAD).
func CurrentBranch(g Env) (string, error) {
	return g.Output("rev-parse", "--abbrev-ref", "HEAD")
}

// TreeSHA writes the index to a tree object and returns the tree SHA.
func TreeSHA(g Env) (string, error) {
	return g.Output("write-tree")
}

// CommitTreeSHA returns the tree SHA for a given commit.
func CommitTreeSHA(g Env, sha string) (string, error) {
	return g.Output("rev-parse", sha+"^{tree}")
}

// ShowFileAtRef returns the contents of a file at a given ref. Returns
// os.ErrNotExist if the ref or path does not exist.
func ShowFileAtRef(g Env, ref, path string) ([]byte, error) {
	content, err := g.Output("show", ref+":"+path)
	if err != nil {
		msg := err.Error()
		if strings.Contains(msg, "Path") ||
			strings.Contains(msg, "not a valid object name") ||
			strings.Contains(msg, "invalid object name") ||
			strings.Contains(msg, "unknown revision") ||
			strings.Contains(msg, "bad object") {
			return nil, os.ErrNotExist
		}
		return nil, err
	}
	return []byte(content), nil
}

// ---------------- mutation helpers ----------------

// CommitMeta holds author/committer env overrides for a git commit.
type CommitMeta struct {
	AuthorName     string
	AuthorEmail    string
	AuthorDate     string
	CommitterName  string
	CommitterEmail string
	CommitterDate  string
}

// Env returns a map of GIT_AUTHOR_* / GIT_COMMITTER_* env vars.
func (m *CommitMeta) Env() map[string]string {
	env := map[string]string{}
	if m.AuthorName != "" {
		env["GIT_AUTHOR_NAME"] = m.AuthorName
	}
	if m.AuthorEmail != "" {
		env["GIT_AUTHOR_EMAIL"] = m.AuthorEmail
	}
	if m.AuthorDate != "" {
		env["GIT_AUTHOR_DATE"] = m.AuthorDate
	}
	if m.CommitterName != "" {
		env["GIT_COMMITTER_NAME"] = m.CommitterName
	}
	if m.CommitterEmail != "" {
		env["GIT_COMMITTER_EMAIL"] = m.CommitterEmail
	}
	if m.CommitterDate != "" {
		env["GIT_COMMITTER_DATE"] = m.CommitterDate
	}
	return env
}

// CreateCommitWithParents creates a git commit object from the given tree,
// message, parent SHAs, and optional metadata.  Returns the new commit SHA.
func CreateCommitWithParents(g Env, treeSHA, message string, parents []string, meta *CommitMeta) (string, error) {
	args := []string{"commit-tree", treeSHA, "-m", message}
	for _, p := range parents {
		args = append(args, "-p", p)
	}
	env := map[string]string{}
	if meta != nil {
		for key, value := range meta.Env() {
			if value != "" {
				env[key] = value
			}
		}
	}
	return g.OutputWithEnv(env, args...)
}

// UpdateBranchRef sets refs/heads/<branch> to the given SHA.
func UpdateBranchRef(g Env, branch, sha string) error {
	return UpdateRef(g, "refs/heads/"+branch, sha)
}

// UpdateRef sets an arbitrary ref to the given SHA.
func UpdateRef(g Env, ref, sha string) error {
	return g.Run("update-ref", ref, sha)
}

// DeleteBranchRef deletes refs/heads/<branch>.
func DeleteBranchRef(g Env, branch string) error {
	return DeleteRef(g, "refs/heads/"+branch)
}

// DeleteRef deletes an arbitrary ref.
func DeleteRef(g Env, ref string) error {
	return g.Run("update-ref", "-d", ref)
}

// ---------------- higher-level helpers ----------------

// CommitInfo holds parsed information about a git commit.
type CommitInfo struct {
	Parents     []string
	Subject     string
	AuthorName  string
	AuthorEmail string
	AuthorDate  string
}

// RevList returns all commits reachable from ref in topological order
// (oldest first).
func RevList(g Env, ref string) ([]string, error) {
	out, err := g.Output("rev-list", "--topo-order", "--reverse", ref)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(out) == "" {
		return nil, nil
	}
	return strings.Split(out, "\n"), nil
}

// ReadCommitInfo parses metadata (parents, author, subject) for a commit.
func ReadCommitInfo(g Env, sha string) (CommitInfo, error) {
	format := "%H%n%P%n%an%n%ae%n%ad%n%s"
	out, err := g.Output("show", "-s", "--format="+format, "--date=iso-strict", sha)
	if err != nil {
		return CommitInfo{}, err
	}
	lines := strings.Split(out, "\n")
	if len(lines) < 6 {
		return CommitInfo{}, fmt.Errorf("unexpected commit info for %s", sha)
	}
	parents := []string{}
	if strings.TrimSpace(lines[1]) != "" {
		parents = strings.Split(strings.TrimSpace(lines[1]), " ")
	}
	return CommitInfo{
		Parents:     parents,
		AuthorName:  lines[2],
		AuthorEmail: lines[3],
		AuthorDate:  lines[4],
		Subject:     lines[5],
	}, nil
}

// CheckoutTree replaces the work tree with the tree of the given commit.
func CheckoutTree(g Env, commit string) error {
	if err := g.Run("clean", "-fdx"); err != nil {
		return err
	}
	return g.Run("checkout", "-f", commit, "--", ".")
}

// RunCommand executes a plain `git <args...>` command in the given directory
// (without the GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE overrides that Env uses).
func RunCommand(dir string, args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	output, err := cmd.CombinedOutput()
	if err != nil {
		message := strings.TrimSpace(string(output))
		if message == "" {
			message = err.Error()
		}
		return fmt.Errorf("git %s: %s", strings.Join(args, " "), message)
	}
	return nil
}

// IsAncestor returns true if ancestorSHA is an ancestor of descendantSHA.
func IsAncestor(g Env, ancestorSHA, descendantSHA string) bool {
	cmd := g.Command("merge-base", "--is-ancestor", ancestorSHA, descendantSHA)
	return cmd.Run() == nil
}

// Push pushes a single refspec to the named remote. Returns ErrPushRejected
// (wrapped) for non-fast-forward rejections, distinguishing them from
// auth/network errors.
func Push(repoDir, remoteName, refspec string) error {
	cmd := exec.Command("git", "-C", repoDir, "push", remoteName, refspec)
	output, err := cmd.CombinedOutput()
	if err == nil {
		return nil
	}
	msg := string(output)
	if IsPushRejected(msg) {
		return fmt.Errorf("push rejected for '%s': %w", refspec, ErrPushRejected)
	}
	trimmed := strings.TrimSpace(msg)
	if trimmed == "" {
		trimmed = err.Error()
	}
	return fmt.Errorf("failed to push '%s': %s", refspec, trimmed)
}

// IsPushRejected checks if git push output indicates a non-fast-forward
// rejection.
func IsPushRejected(output string) bool {
	lower := strings.ToLower(output)
	return strings.Contains(lower, "[rejected]") ||
		strings.Contains(lower, "non-fast-forward") ||
		strings.Contains(lower, "fetch first") ||
		strings.Contains(lower, "were rejected")
}
