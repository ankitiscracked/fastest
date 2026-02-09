package workspace

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

const (
	lockDirName       = ".fst"
	workspaceLockFile = "lock"
	gcLockFile        = "gc.lock"
)

// LockFile represents a held file lock (flock-based).
// Locks are advisory and automatically released if the process exits.
type LockFile struct {
	file *os.File
}

func acquireFlock(path string, lockType int) (*LockFile, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("failed to create lock directory: %w", err)
	}

	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0644)
	if err != nil {
		return nil, fmt.Errorf("failed to open lock file: %w", err)
	}

	if err := syscall.Flock(int(f.Fd()), lockType); err != nil {
		f.Close()
		return nil, fmt.Errorf("failed to acquire lock on %s: %w", path, err)
	}

	return &LockFile{file: f}, nil
}

// Release releases the held lock.
func (l *LockFile) Release() error {
	if l == nil || l.file == nil {
		return nil
	}
	_ = syscall.Flock(int(l.file.Fd()), syscall.LOCK_UN)
	return l.file.Close()
}

// AcquireWorkspaceLock acquires an exclusive lock on a workspace directory.
// This prevents concurrent fst operations on the same workspace from
// interleaving and producing corrupted state.
func AcquireWorkspaceLock(workspaceRoot string) (*LockFile, error) {
	path := filepath.Join(workspaceRoot, lockDirName, workspaceLockFile)
	lock, err := acquireFlock(path, syscall.LOCK_EX)
	if err != nil {
		return nil, fmt.Errorf("could not lock workspace %s (another fst operation may be running): %w", workspaceRoot, err)
	}
	return lock, nil
}

// AcquireProjectSharedLock acquires a shared lock at the project level.
// Multiple workspace operations can hold shared locks concurrently, but
// GC's exclusive lock will block until all shared locks are released.
// This prevents GC from deleting data needed by in-flight operations.
func AcquireProjectSharedLock(projectRoot string) (*LockFile, error) {
	path := filepath.Join(projectRoot, lockDirName, gcLockFile)
	lock, err := acquireFlock(path, syscall.LOCK_SH)
	if err != nil {
		return nil, fmt.Errorf("could not acquire project lock at %s: %w", projectRoot, err)
	}
	return lock, nil
}

// AcquireGCLock acquires an exclusive lock at the project level.
// This blocks until all workspace operations (shared locks) are released,
// ensuring GC doesn't delete data needed by in-flight operations.
func AcquireGCLock(projectRoot string) (*LockFile, error) {
	path := filepath.Join(projectRoot, lockDirName, gcLockFile)
	lock, err := acquireFlock(path, syscall.LOCK_EX)
	if err != nil {
		return nil, fmt.Errorf("could not acquire GC lock at %s (workspace operations may be running): %w", projectRoot, err)
	}
	return lock, nil
}
