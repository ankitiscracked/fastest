//go:build linux

package commands

import (
	"os"

	"golang.org/x/sys/unix"
)

func cloneFileNative(src, dst string) error {
	srcFile, err := os.Open(src)
	if err != nil {
		return err
	}
	defer srcFile.Close()

	dstFile, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		return err
	}
	defer dstFile.Close()

	return unix.IoctlFileClone(int(dstFile.Fd()), int(srcFile.Fd()))
}
