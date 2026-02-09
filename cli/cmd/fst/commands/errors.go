package commands

// silentExitError signals a non-zero exit code without printing an error
// message. Use with cmd.SilenceErrors = true so Cobra doesn't print it.
type silentExitError struct {
	code int
}

func (e *silentExitError) Error() string { return "" }

// SilentExit returns an error that causes the process to exit with the
// given code without printing an error message. The caller must set
// cmd.SilenceErrors = true before returning this error.
func SilentExit(code int) error {
	return &silentExitError{code: code}
}

// ExitCode extracts the exit code from a silentExitError, or returns 0
// if the error is not a silentExitError.
func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	if se, ok := err.(*silentExitError); ok {
		return se.code
	}
	return 0
}
