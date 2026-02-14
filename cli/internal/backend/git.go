package backend

// GitBackend exports snapshots to a local git repository.
type GitBackend struct {
	ExportGit ExportFunc
}

func (b *GitBackend) Type() string { return "git" }

func (b *GitBackend) Push(projectRoot string) error {
	return b.ExportGit(projectRoot, false, false)
}

func (b *GitBackend) Pull(projectRoot string) error {
	return ErrNoRemote
}

func (b *GitBackend) Sync(projectRoot string, opts *SyncOptions) error {
	return b.Push(projectRoot)
}
