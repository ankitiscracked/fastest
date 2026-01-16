package main

import (
	"os"

	"github.com/anthropics/fastest/cli/cmd/fst/commands"
)

func main() {
	if err := commands.Execute(); err != nil {
		os.Exit(1)
	}
}
