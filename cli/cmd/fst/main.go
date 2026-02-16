package main

import (
	"os"

	"github.com/ankitiscracked/fastest/cli/cmd/fst/commands"
)

func main() {
	if err := commands.Execute(); err != nil {
		if code := commands.ExitCode(err); code != 0 {
			os.Exit(code)
		}
		os.Exit(1)
	}
}
