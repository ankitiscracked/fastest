package workspace

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestAcquireBackendLock(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".fst"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	lock, err := AcquireBackendLock(root)
	if err != nil {
		t.Fatalf("AcquireBackendLock: %v", err)
	}
	if lock == nil {
		t.Fatalf("expected non-nil lock")
	}

	if err := lock.Release(); err != nil {
		t.Fatalf("Release: %v", err)
	}
}

func TestAcquireBackendLockReentrant(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".fst"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// Acquire and release, then acquire again — should work
	lock1, err := AcquireBackendLock(root)
	if err != nil {
		t.Fatalf("first AcquireBackendLock: %v", err)
	}
	lock1.Release()

	lock2, err := AcquireBackendLock(root)
	if err != nil {
		t.Fatalf("second AcquireBackendLock: %v", err)
	}
	lock2.Release()
}

func TestTryAcquireBackendLockFree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".fst"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	lock, err := TryAcquireBackendLock(root)
	if err != nil {
		t.Fatalf("TryAcquireBackendLock: %v", err)
	}
	if lock == nil {
		t.Fatalf("expected to acquire lock when free")
	}
	lock.Release()
}

func TestTryAcquireBackendLockContended(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".fst"), 0755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}

	// Hold the lock from a child process using a Go helper.
	// We use a simple Python one-liner that flocks and signals readiness via a file.
	readyFile := filepath.Join(root, "ready")
	lockPath := filepath.Join(root, ".fst", backendLockFile)
	script := `
import fcntl, time, os, sys
fd = open(sys.argv[1], 'w')
fcntl.flock(fd, fcntl.LOCK_EX)
open(sys.argv[2], 'w').close()
time.sleep(30)
`
	cmd := exec.Command("python3", "-c", script, lockPath, readyFile)
	if err := cmd.Start(); err != nil {
		t.Skipf("python3 not available: %v", err)
	}
	defer cmd.Process.Kill()

	// Wait for the child to signal it holds the lock
	for i := 0; i < 100; i++ {
		if _, err := os.Stat(readyFile); err == nil {
			break
		}
		exec.Command("sleep", "0.05").Run()
	}

	lock, _ := TryAcquireBackendLock(root)
	if lock != nil {
		lock.Release()
		t.Fatalf("expected TryAcquire to return nil when lock is held by another process")
	}
}

func TestReleaseNilLock(t *testing.T) {
	// Releasing a nil lock should not panic
	var lock *LockFile
	if err := lock.Release(); err != nil {
		t.Fatalf("Release on nil: %v", err)
	}
}
