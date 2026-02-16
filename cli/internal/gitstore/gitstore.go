// Package gitstore implements the bridge between fst's snapshot model
// (store, manifest) and git's commit model.  It contains export, import,
// mapping and metadata logic.
package gitstore

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/ankitiscracked/fastest/cli/internal/config"
	"github.com/ankitiscracked/fastest/cli/internal/gitutil"
	"github.com/ankitiscracked/fastest/cli/internal/manifest"
	"github.com/ankitiscracked/fastest/cli/internal/store"
)

// ---- Mapping ----

// GitMapping tracks which snapshots have been exported to which git commits.
type GitMapping struct {
	RepoPath  string            `json:"repo_path"`
	Snapshots map[string]string `json:"snapshots"` // snapshot_id -> git_commit_sha
}

// LoadGitMapping loads the git export mapping from the given config directory.
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

// SaveGitMapping saves the git export mapping to the given config directory.
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

// ---- Export metadata ----

const (
	FstMetaRef  = "refs/fst/meta"
	FstMetaPath = ".fst-export/meta.json"
)

// ExportMeta describes the exported project state stored in refs/fst/meta.
type ExportMeta struct {
	Version    int                              `json:"version"`
	UpdatedAt  string                           `json:"updated_at,omitempty"`
	ProjectID  string                           `json:"project_id,omitempty"`
	Workspaces map[string]ExportWorkspaceMeta   `json:"workspaces,omitempty"`
}

// ExportWorkspaceMeta describes a single workspace in the export metadata.
type ExportWorkspaceMeta struct {
	WorkspaceID   string `json:"workspace_id"`
	WorkspaceName string `json:"workspace_name,omitempty"`
	Branch        string `json:"branch"`
}

// UpdateExportMetadata adds/updates workspace info in the export metadata
// stored in refs/fst/meta.
func UpdateExportMetadata(g gitutil.Env, cfg *config.ProjectConfig, branchName string) error {
	if cfg == nil || cfg.WorkspaceID == "" {
		return fmt.Errorf("missing workspace id for export metadata")
	}

	meta, err := LoadExportMetadata(g)
	if err != nil && !os.IsNotExist(err) {
		return err
	}
	if meta == nil {
		meta = &ExportMeta{Version: 1, Workspaces: make(map[string]ExportWorkspaceMeta)}
	}
	if meta.Workspaces == nil {
		meta.Workspaces = make(map[string]ExportWorkspaceMeta)
	}

	meta.ProjectID = cfg.ProjectID
	meta.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	meta.Workspaces[cfg.WorkspaceID] = ExportWorkspaceMeta{
		WorkspaceID:   cfg.WorkspaceID,
		WorkspaceName: cfg.WorkspaceName,
		Branch:        branchName,
	}

	data, err := json.MarshalIndent(meta, "", "  ")
	if err != nil {
		return err
	}

	if err := os.MkdirAll(filepath.Join(g.WorkTree, ".fst-export"), 0755); err != nil {
		return err
	}
	metaPath := filepath.Join(g.WorkTree, FstMetaPath)
	if err := os.WriteFile(metaPath, data, 0644); err != nil {
		return err
	}

	if err := g.Run("add", "-A"); err != nil {
		return err
	}

	treeSHA, err := gitutil.TreeSHA(g)
	if err != nil {
		return err
	}

	parent, err := gitutil.RefSHA(g, FstMetaRef)
	if err != nil && !os.IsNotExist(err) {
		return err
	}

	parents := []string{}
	if parent != "" {
		parents = append(parents, parent)
	}

	metaCommit := &gitutil.CommitMeta{
		AuthorDate:    meta.UpdatedAt,
		CommitterDate: meta.UpdatedAt,
	}
	sha, err := gitutil.CreateCommitWithParents(g, treeSHA, "FST export metadata", parents, metaCommit)
	if err != nil {
		return err
	}

	return gitutil.UpdateRef(g, FstMetaRef, sha)
}

// LoadExportMetadata loads the export metadata from refs/fst/meta.
func LoadExportMetadata(g gitutil.Env) (*ExportMeta, error) {
	data, err := gitutil.ShowFileAtRef(g, FstMetaRef, FstMetaPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var meta ExportMeta
	if err := json.Unmarshal(data, &meta); err != nil {
		return nil, err
	}
	return &meta, nil
}

// LoadExportMetadataFromRepo loads export metadata by creating a temporary
// gitutil.Env for the given repo root.
func LoadExportMetadataFromRepo(repoRoot string) (*ExportMeta, error) {
	tempDir, err := os.MkdirTemp("", "fst-export-meta-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tempDir)

	indexPath := filepath.Join(tempDir, "index")
	git := gitutil.NewEnv(repoRoot, tempDir, indexPath)
	return LoadExportMetadata(git)
}

// CollectExportBranches returns the deduplicated list of branch names from
// export metadata.
func CollectExportBranches(meta *ExportMeta) []string {
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

// ---- Snapshot helpers ----

// CommitMetaFromSnapshot converts fst snapshot metadata into git commit
// metadata (author/committer env vars).
func CommitMetaFromSnapshot(snap *store.SnapshotMeta) *gitutil.CommitMeta {
	if snap.CreatedAt == "" && snap.Agent == "" && snap.AuthorName == "" {
		return nil
	}
	meta := &gitutil.CommitMeta{
		AuthorDate:    snap.CreatedAt,
		CommitterDate: snap.CreatedAt,
	}
	if snap.AuthorName != "" {
		meta.AuthorName = snap.AuthorName
		meta.AuthorEmail = snap.AuthorEmail
		meta.CommitterName = snap.AuthorName
		meta.CommitterEmail = snap.AuthorEmail
	} else if snap.Agent != "" {
		email := AgentEmail(snap.Agent)
		meta.AuthorName = snap.Agent
		meta.AuthorEmail = email
		meta.CommitterName = snap.Agent
		meta.CommitterEmail = email
	}
	return meta
}

// AgentEmail converts an agent name to an email address for git commits.
func AgentEmail(agent string) string {
	if agent == "" {
		return ""
	}
	normalized := strings.ToLower(agent)
	var b strings.Builder
	lastDash := false
	for _, r := range normalized {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') {
			b.WriteRune(r)
			lastDash = false
			continue
		}
		if !lastDash {
			b.WriteByte('-')
			lastDash = true
		}
	}
	slug := strings.Trim(b.String(), "-")
	if slug == "" {
		slug = "agent"
	}
	return slug + "@fastest.local"
}

// RestoreFilesFromManifest restores all files from a manifest using the
// store's blob cache.
func RestoreFilesFromManifest(root string, s *store.Store, m *manifest.Manifest) error {
	shouldExist := make(map[string]bool)
	for _, f := range m.FileEntries() {
		shouldExist[f.Path] = true
	}

	// Remove files that shouldn't exist (except .git and .fst)
	filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		relPath, _ := filepath.Rel(root, path)
		relPath = filepath.ToSlash(relPath)
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

	// Restore files from blobs
	for _, f := range m.FileEntries() {
		content, err := s.ReadBlob(f.Hash)
		if err != nil {
			return fmt.Errorf("blob not found for %s: %w", f.Path, err)
		}
		targetPath := filepath.Join(root, f.Path)
		if err := os.MkdirAll(filepath.Dir(targetPath), 0755); err != nil {
			return err
		}
		if err := os.WriteFile(targetPath, content, os.FileMode(f.Mode)); err != nil {
			return err
		}
	}
	return nil
}

// ResolveGitParentSHAs maps snapshot parent IDs to their corresponding git
// commit SHAs using the mapping.
func ResolveGitParentSHAs(g gitutil.Env, mapping *GitMapping, parentIDs []string) ([]string, error) {
	if len(parentIDs) == 0 {
		return nil, nil
	}
	seen := make(map[string]struct{}, len(parentIDs))
	parents := make([]string, 0, len(parentIDs))
	for _, id := range parentIDs {
		if id == "" {
			continue
		}
		if _, ok := seen[id]; ok {
			continue
		}
		seen[id] = struct{}{}
		sha, ok := mapping.Snapshots[id]
		if !ok {
			fmt.Printf("  warning: parent snapshot %s not exported (skipping)\n", id)
			continue
		}
		if !gitutil.CommitExists(g, sha) {
			fmt.Printf("  warning: parent commit missing for snapshot %s (skipping)\n", id)
			continue
		}
		parents = append(parents, sha)
	}
	return parents, nil
}

// BuildSnapshotDAG walks all reachable parents and returns snapshots in
// parent-before-child (topological) order.
func BuildSnapshotDAG(s *store.Store, startID string) ([]*store.SnapshotMeta, error) {
	if startID == "" {
		return nil, fmt.Errorf("empty snapshot id")
	}

	if _, err := s.LoadSnapshotMeta(startID); err != nil {
		return nil, fmt.Errorf("snapshot metadata not found for %s", startID)
	}

	state := make(map[string]uint8)
	infoByID := make(map[string]*store.SnapshotMeta)
	var ordered []*store.SnapshotMeta

	var visit func(string) error
	visit = func(id string) error {
		if id == "" {
			return nil
		}
		switch state[id] {
		case 1:
			return fmt.Errorf("cycle detected at snapshot %s", id)
		case 2:
			return nil
		}
		state[id] = 1

		info := infoByID[id]
		if info == nil {
			meta, err := s.LoadSnapshotMeta(id)
			if err != nil {
				if os.IsNotExist(err) {
					fmt.Printf("  warning: snapshot metadata missing for %s (skipping)\n", id)
					state[id] = 2
					return nil
				}
				return err
			}
			info = meta
			infoByID[id] = info
		}

		for _, parent := range info.ParentSnapshotIDs {
			if err := visit(parent); err != nil {
				return err
			}
		}

		state[id] = 2
		ordered = append(ordered, info)
		return nil
	}

	if err := visit(startID); err != nil {
		return nil, err
	}

	return ordered, nil
}

// CreateImportedSnapshot creates a snapshot from files in sourceRoot,
// writing blobs and metadata to the store.
func CreateImportedSnapshot(s *store.Store, sourceRoot string, cfg *config.ProjectConfig, parents []string, message, createdAt, authorName, authorEmail, agentName string) (string, error) {
	if message == "" {
		message = "Imported commit"
	}

	m, err := manifest.Generate(sourceRoot, false)
	if err != nil {
		return "", fmt.Errorf("failed to scan files: %w", err)
	}

	manifestHash, err := s.WriteManifest(m)
	if err != nil {
		return "", fmt.Errorf("failed to write manifest: %w", err)
	}

	if createdAt == "" {
		createdAt = time.Now().UTC().Format(time.RFC3339)
	}
	snapshotID := store.ComputeSnapshotID(manifestHash, parents, authorName, authorEmail, createdAt)

	for _, f := range m.FileEntries() {
		if s.BlobExists(f.Hash) {
			continue
		}
		srcPath := filepath.Join(sourceRoot, f.Path)
		content, err := os.ReadFile(srcPath)
		if err != nil {
			continue
		}
		_ = s.WriteBlob(f.Hash, content)
	}

	if err := s.WriteSnapshotMeta(&store.SnapshotMeta{
		ID:                snapshotID,
		WorkspaceID:       cfg.WorkspaceID,
		WorkspaceName:     cfg.WorkspaceName,
		ManifestHash:      manifestHash,
		ParentSnapshotIDs: parents,
		AuthorName:        authorName,
		AuthorEmail:       authorEmail,
		Message:           message,
		Agent:             agentName,
		CreatedAt:         createdAt,
		Files:             m.FileCount(),
		Size:              m.TotalSize(),
	}); err != nil {
		return "", fmt.Errorf("failed to save snapshot metadata: %w", err)
	}

	return snapshotID, nil
}

// PushExportToRemote pushes all exported workspace branches and metadata
// to the given remote. Returns gitutil.ErrPushRejected if a push is
// rejected due to non-fast-forward.
func PushExportToRemote(projectRoot string, remoteName string) error {
	meta, err := LoadExportMetadataFromRepo(projectRoot)
	if err != nil {
		return fmt.Errorf("failed to load export metadata: %w", err)
	}
	if meta == nil {
		return fmt.Errorf("missing export metadata in repo")
	}
	branches := CollectExportBranches(meta)

	for _, branch := range branches {
		if err := gitutil.Push(projectRoot, remoteName, branch); err != nil {
			return err
		}
	}
	if err := gitutil.Push(projectRoot, remoteName, FstMetaRef); err != nil {
		return err
	}

	return nil
}
