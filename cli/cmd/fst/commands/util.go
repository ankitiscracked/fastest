package commands

import (
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
)

func randomSuffix(length int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	if length <= 0 {
		return ""
	}

	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "rand"
	}
	for i := range bytes {
		bytes[i] = letters[int(bytes[i])%len(letters)]
	}
	return string(bytes)
}

// copyFile copies a single file from src to dst, creating parent directories.
func copyFile(src, dst string, mode os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(dst), 0755); err != nil {
		return err
	}

	source, err := os.Open(src)
	if err != nil {
		return err
	}
	defer source.Close()

	destination, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	defer destination.Close()

	_, err = io.Copy(destination, source)
	return err
}
