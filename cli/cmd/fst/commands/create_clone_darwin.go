//go:build darwin

package commands

import "golang.org/x/sys/unix"

func cloneFileNative(src, dst string) error {
	return unix.Clonefile(src, dst, 0)
}
