package gitutil

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// initRepo creates a bare-minimum git repo in dir and returns an Env.
func initRepo(t *testing.T) (Env, string) {
	t.Helper()
	repoDir := t.TempDir()
	workDir := t.TempDir()
	indexPath := filepath.Join(workDir, "index")

	cmd := exec.Command("git", "init", repoDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git init: %s", out)
	}
	cmd = exec.Command("git", "-C", repoDir, "config", "user.name", "Test")
	cmd.Run()
	cmd = exec.Command("git", "-C", repoDir, "config", "user.email", "test@test.com")
	cmd.Run()

	return NewEnv(repoDir, workDir, indexPath), repoDir
}

// commitFile creates a file, stages it, and creates a commit. Returns the commit SHA.
func commitFile(t *testing.T, g Env, name, content, message string) string {
	t.Helper()
	if err := os.WriteFile(filepath.Join(g.WorkTree, name), []byte(content), 0644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	if err := g.Run("add", "-A"); err != nil {
		t.Fatalf("git add: %v", err)
	}
	tree, err := TreeSHA(g)
	if err != nil {
		t.Fatalf("TreeSHA: %v", err)
	}
	// Get current branch tip as parent if it exists
	var parents []string
	if sha, err := RefSHA(g, "refs/heads/main"); err == nil {
		parents = []string{sha}
	}
	sha, err := CreateCommitWithParents(g, tree, message, parents, nil)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if err := UpdateBranchRef(g, "main", sha); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}
	return sha
}

func TestNewEnv(t *testing.T) {
	g := NewEnv("/repo", "/work", "/work/index")
	if g.RepoRoot != "/repo" {
		t.Fatalf("expected /repo, got %s", g.RepoRoot)
	}
	if g.WorkTree != "/work" {
		t.Fatalf("expected /work, got %s", g.WorkTree)
	}
	if g.IndexFile != "/work/index" {
		t.Fatalf("expected /work/index, got %s", g.IndexFile)
	}
	if g.GitDir() != "/repo/.git" {
		t.Fatalf("expected /repo/.git, got %s", g.GitDir())
	}
}

func TestCommitMetaEnv(t *testing.T) {
	m := &CommitMeta{
		AuthorName:     "Alice",
		AuthorEmail:    "alice@example.com",
		AuthorDate:     "2024-01-01T00:00:00Z",
		CommitterName:  "Bob",
		CommitterEmail: "bob@example.com",
		CommitterDate:  "2024-01-02T00:00:00Z",
	}
	env := m.Env()
	if env["GIT_AUTHOR_NAME"] != "Alice" {
		t.Fatalf("expected Alice, got %s", env["GIT_AUTHOR_NAME"])
	}
	if env["GIT_COMMITTER_EMAIL"] != "bob@example.com" {
		t.Fatalf("expected bob@example.com, got %s", env["GIT_COMMITTER_EMAIL"])
	}
	if len(env) != 6 {
		t.Fatalf("expected 6 env vars, got %d", len(env))
	}

	// Empty fields should not be included
	empty := &CommitMeta{}
	if len(empty.Env()) != 0 {
		t.Fatalf("expected 0 env vars for empty meta, got %d", len(empty.Env()))
	}
}

func TestBranchExists(t *testing.T) {
	g, _ := initRepo(t)
	commitFile(t, g, "file.txt", "hello", "initial")

	exists, err := BranchExists(g, "main")
	if err != nil {
		t.Fatalf("BranchExists: %v", err)
	}
	if !exists {
		t.Fatalf("expected main branch to exist")
	}

	exists, err = BranchExists(g, "nonexistent")
	if err != nil {
		t.Fatalf("BranchExists: %v", err)
	}
	if exists {
		t.Fatalf("expected nonexistent branch to not exist")
	}
}

func TestRefSHA(t *testing.T) {
	g, _ := initRepo(t)
	sha1 := commitFile(t, g, "file.txt", "hello", "initial")

	got, err := RefSHA(g, "refs/heads/main")
	if err != nil {
		t.Fatalf("RefSHA: %v", err)
	}
	if got != sha1 {
		t.Fatalf("expected %s, got %s", sha1, got)
	}

	// Non-existent ref
	_, err = RefSHA(g, "refs/heads/nonexistent")
	if !os.IsNotExist(err) {
		t.Fatalf("expected os.ErrNotExist, got %v", err)
	}
}

func TestCommitExists(t *testing.T) {
	g, _ := initRepo(t)
	sha := commitFile(t, g, "file.txt", "hello", "initial")

	if !CommitExists(g, sha) {
		t.Fatalf("expected commit to exist")
	}
	if CommitExists(g, "0000000000000000000000000000000000000000") {
		t.Fatalf("expected fake SHA to not exist")
	}
}

func TestCreateCommitWithParentsAndMeta(t *testing.T) {
	g, _ := initRepo(t)

	if err := os.WriteFile(filepath.Join(g.WorkTree, "file.txt"), []byte("v1"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := g.Run("add", "-A"); err != nil {
		t.Fatal(err)
	}
	tree, _ := TreeSHA(g)

	meta := &CommitMeta{
		AuthorName:  "Custom Author",
		AuthorEmail: "custom@test.com",
	}
	sha, err := CreateCommitWithParents(g, tree, "test commit", nil, meta)
	if err != nil {
		t.Fatalf("CreateCommitWithParents: %v", err)
	}
	if sha == "" {
		t.Fatal("expected non-empty SHA")
	}

	// Verify author was set
	info, err := ReadCommitInfo(g, sha)
	if err != nil {
		t.Fatalf("ReadCommitInfo: %v", err)
	}
	if info.AuthorName != "Custom Author" {
		t.Fatalf("expected Custom Author, got %s", info.AuthorName)
	}
	if info.AuthorEmail != "custom@test.com" {
		t.Fatalf("expected custom@test.com, got %s", info.AuthorEmail)
	}
	if info.Subject != "test commit" {
		t.Fatalf("expected 'test commit', got %s", info.Subject)
	}
}

func TestRevList(t *testing.T) {
	g, _ := initRepo(t)
	sha1 := commitFile(t, g, "file.txt", "v1", "first")
	sha2 := commitFile(t, g, "file.txt", "v2", "second")

	commits, err := RevList(g, "main")
	if err != nil {
		t.Fatalf("RevList: %v", err)
	}
	if len(commits) != 2 {
		t.Fatalf("expected 2 commits, got %d", len(commits))
	}
	// Topo order, oldest first
	if commits[0] != sha1 {
		t.Fatalf("expected first commit %s, got %s", sha1, commits[0])
	}
	if commits[1] != sha2 {
		t.Fatalf("expected second commit %s, got %s", sha2, commits[1])
	}
}

func TestReadCommitInfo(t *testing.T) {
	g, _ := initRepo(t)
	sha1 := commitFile(t, g, "file.txt", "v1", "first commit")
	sha2 := commitFile(t, g, "file.txt", "v2", "second commit")

	info, err := ReadCommitInfo(g, sha2)
	if err != nil {
		t.Fatalf("ReadCommitInfo: %v", err)
	}
	if info.Subject != "second commit" {
		t.Fatalf("expected 'second commit', got %s", info.Subject)
	}
	if len(info.Parents) != 1 || info.Parents[0] != sha1 {
		t.Fatalf("expected parent %s, got %v", sha1, info.Parents)
	}
	if info.AuthorName != "Test" {
		t.Fatalf("expected author 'Test', got %s", info.AuthorName)
	}

	// Root commit has no parents
	info1, _ := ReadCommitInfo(g, sha1)
	if len(info1.Parents) != 0 {
		t.Fatalf("expected no parents for root commit, got %v", info1.Parents)
	}
}

func TestCheckoutTree(t *testing.T) {
	g, _ := initRepo(t)
	commitFile(t, g, "a.txt", "aaa", "first")
	sha2 := commitFile(t, g, "b.txt", "bbb", "second")

	// Checkout second commit
	if err := CheckoutTree(g, sha2); err != nil {
		t.Fatalf("CheckoutTree: %v", err)
	}

	// Both files should exist
	if _, err := os.Stat(filepath.Join(g.WorkTree, "a.txt")); err != nil {
		t.Fatalf("expected a.txt to exist: %v", err)
	}
	if _, err := os.Stat(filepath.Join(g.WorkTree, "b.txt")); err != nil {
		t.Fatalf("expected b.txt to exist: %v", err)
	}
}

func TestIsAncestor(t *testing.T) {
	g, _ := initRepo(t)
	sha1 := commitFile(t, g, "file.txt", "v1", "first")
	sha2 := commitFile(t, g, "file.txt", "v2", "second")

	if !IsAncestor(g, sha1, sha2) {
		t.Fatalf("expected sha1 to be ancestor of sha2")
	}
	if IsAncestor(g, sha2, sha1) {
		t.Fatalf("expected sha2 NOT to be ancestor of sha1")
	}
	if !IsAncestor(g, sha1, sha1) {
		t.Fatalf("expected sha1 to be ancestor of itself")
	}
}

func TestUpdateAndDeleteBranchRef(t *testing.T) {
	g, _ := initRepo(t)
	sha := commitFile(t, g, "file.txt", "v1", "initial")

	// Create a new branch
	if err := UpdateBranchRef(g, "feature", sha); err != nil {
		t.Fatalf("UpdateBranchRef: %v", err)
	}
	got, err := RefSHA(g, "refs/heads/feature")
	if err != nil {
		t.Fatalf("RefSHA: %v", err)
	}
	if got != sha {
		t.Fatalf("expected %s, got %s", sha, got)
	}

	// Delete it
	if err := DeleteBranchRef(g, "feature"); err != nil {
		t.Fatalf("DeleteBranchRef: %v", err)
	}
	_, err = RefSHA(g, "refs/heads/feature")
	if !os.IsNotExist(err) {
		t.Fatalf("expected branch to be deleted, got %v", err)
	}
}

func TestShowFileAtRef(t *testing.T) {
	g, _ := initRepo(t)
	commitFile(t, g, "hello.txt", "world", "initial")

	data, err := ShowFileAtRef(g, "main", "hello.txt")
	if err != nil {
		t.Fatalf("ShowFileAtRef: %v", err)
	}
	if string(data) != "world" {
		t.Fatalf("expected 'world', got %q", string(data))
	}

	// Non-existent file
	_, err = ShowFileAtRef(g, "main", "nonexistent.txt")
	if !os.IsNotExist(err) {
		t.Fatalf("expected os.ErrNotExist for missing file, got %v", err)
	}

	// Non-existent ref
	_, err = ShowFileAtRef(g, "nonexistent-branch", "hello.txt")
	if !os.IsNotExist(err) {
		t.Fatalf("expected os.ErrNotExist for missing ref, got %v", err)
	}
}

func TestCommitTreeSHA(t *testing.T) {
	g, _ := initRepo(t)
	sha := commitFile(t, g, "file.txt", "data", "initial")

	treeSHA, err := CommitTreeSHA(g, sha)
	if err != nil {
		t.Fatalf("CommitTreeSHA: %v", err)
	}
	if treeSHA == "" || treeSHA == sha {
		t.Fatalf("expected a different tree SHA, got %s", treeSHA)
	}
}

func TestIsPushRejected(t *testing.T) {
	tests := []struct {
		output   string
		expected bool
	}{
		{"! [rejected] main -> main (non-fast-forward)\n", true},
		{"Updates were rejected because the tip is behind\n", true},
		{"! [rejected] main -> main (fetch first)\n", true},
		{"[rejected] something\n", true},
		{"fatal: repository not found\n", false},
		{"fatal: Authentication failed\n", false},
		{"Everything up-to-date\n", false},
		{"", false},
	}
	for _, tt := range tests {
		got := IsPushRejected(tt.output)
		if got != tt.expected {
			t.Errorf("IsPushRejected(%q) = %v, want %v", tt.output[:min(40, len(tt.output))], got, tt.expected)
		}
	}
}

func TestRunCommand(t *testing.T) {
	dir := t.TempDir()
	if err := RunCommand(dir, "init"); err != nil {
		t.Fatalf("RunCommand init: %v", err)
	}
	// .git should exist
	if _, err := os.Stat(filepath.Join(dir, ".git")); err != nil {
		t.Fatalf("expected .git after init: %v", err)
	}

	// Error case
	err := RunCommand(dir, "checkout", "nonexistent-branch-12345")
	if err == nil {
		t.Fatal("expected error for bad checkout")
	}
	if !strings.Contains(err.Error(), "git checkout") {
		t.Fatalf("expected error to mention git checkout, got: %v", err)
	}
}
