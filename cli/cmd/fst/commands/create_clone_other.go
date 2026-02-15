//go:build !darwin && !linux

package commands

func cloneFileNative(src, dst string) error {
	return errCloneUnsupportedPlatform
}
