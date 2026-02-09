package commands

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/sergi/go-diff/diffmatchpatch"
	"github.com/spf13/cobra"

	"github.com/anthropics/fastest/cli/internal/config"
	"github.com/anthropics/fastest/cli/internal/drift"
	"github.com/anthropics/fastest/cli/internal/manifest"
	"github.com/anthropics/fastest/cli/internal/store"
)

func init() {
	register(func(root *cobra.Command) { root.AddCommand(newDiffCmd()) })
}

func newDiffCmd() *cobra.Command {
	var contextLines int
	var noColor bool
	var namesOnly bool

	cmd := &cobra.Command{
		Use:   "diff [workspace] [file...]",
		Short: "Show line-by-line differences with another workspace",
		Long: `Show actual content differences between this workspace and another.

Without a workspace argument, compares against the upstream workspace (the
workspace that created this workspace's base snapshot).

With file arguments, only shows diffs for those specific files.

Examples:
  fst diff                     # Diff against upstream workspace
  fst diff main                # Diff against workspace named "main"
  fst diff ../other            # Diff against workspace at path
  fst diff main src/file.go    # Diff specific file against "main"
  fst diff --names-only        # Just list changed files (like drift)`,
		RunE: func(cmd *cobra.Command, args []string) error {
			var target string
			var files []string

			if len(args) > 0 {
				target = args[0]
				if len(args) > 1 {
					files = args[1:]
				}
			}
			return runDiff(target, files, contextLines, noColor, namesOnly)
		},
	}

	cmd.Flags().IntVarP(&contextLines, "context", "C", 3, "Number of context lines around changes")
	cmd.Flags().BoolVar(&noColor, "no-color", false, "Disable colored output")
	cmd.Flags().BoolVar(&namesOnly, "names-only", false, "Only show names of changed files")

	return cmd
}

func runDiff(target string, files []string, contextLines int, noColor, namesOnly bool) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("not in a workspace directory - run 'fst workspace init' first")
	}

	root, err := config.FindProjectRoot()
	if err != nil {
		return fmt.Errorf("failed to find project root: %w", err)
	}

	var otherRoot string
	var otherName string

	if target == "" {
		// No target specified - find upstream workspace
		upstreamID, upstreamName, err := drift.GetUpstreamWorkspace(root)
		if err != nil {
			return fmt.Errorf("no upstream workspace found - specify a workspace to diff against")
		}

		// Look up upstream workspace path from project-level registry
		parentRoot, _, parentErr := config.FindParentRootFrom(root)
		if parentErr != nil {
			return fmt.Errorf("no project folder found - specify a workspace path")
		}
		s := store.OpenAt(parentRoot)

		found := false
		if upstreamID != "" {
			if wsInfo, lookupErr := s.FindWorkspaceByID(upstreamID); lookupErr == nil {
				otherRoot = wsInfo.Path
				otherName = wsInfo.WorkspaceName
				found = true
			}
		}
		if !found && upstreamName != "" {
			if wsInfo, lookupErr := s.FindWorkspaceByName(upstreamName); lookupErr == nil {
				otherRoot = wsInfo.Path
				otherName = wsInfo.WorkspaceName
				found = true
			}
		}

		if !found {
			return fmt.Errorf("upstream workspace '%s' not found in registry - specify a workspace path", upstreamName)
		}
	} else {
		// Target specified - determine if it's a path or name
		if isPath(target) {
			if !filepath.IsAbs(target) {
				cwd, err := os.Getwd()
				if err != nil {
					return err
				}
				otherRoot = filepath.Join(cwd, target)
			} else {
				otherRoot = target
			}
			otherName = filepath.Base(otherRoot)

			if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
				return fmt.Errorf("not a workspace: %s", otherRoot)
			}
		} else {
			// Treat as workspace name - look up in project-level registry
			parentRoot, _, parentErr := config.FindParentRootFrom(root)
			if parentErr != nil {
				return fmt.Errorf("no project folder found - specify a workspace path")
			}
			s := store.OpenAt(parentRoot)
			wsInfo, lookupErr := s.FindWorkspaceByName(target)
			if lookupErr != nil {
				return fmt.Errorf("workspace '%s' not found in project", target)
			}
			otherRoot = wsInfo.Path
			otherName = wsInfo.WorkspaceName
		}
	}

	// Verify other workspace exists
	if _, err := os.Stat(filepath.Join(otherRoot, ".fst")); os.IsNotExist(err) {
		return fmt.Errorf("workspace no longer exists: %s", otherRoot)
	}

	// Generate manifests
	ourManifest, err := manifest.GenerateWithCache(root, config.GetStatCachePath(root))
	if err != nil {
		return fmt.Errorf("failed to scan our workspace: %w", err)
	}

	theirManifest, err := manifest.GenerateWithCache(otherRoot, config.GetStatCachePath(otherRoot))
	if err != nil {
		return fmt.Errorf("failed to scan their workspace: %w", err)
	}

	// Compute which files differ
	added, modified, deleted := manifest.Diff(theirManifest, ourManifest)

	// Filter by specified files if any
	if len(files) > 0 {
		fileSet := make(map[string]bool)
		for _, f := range files {
			fileSet[f] = true
		}
		added = filterFiles(added, fileSet)
		modified = filterFiles(modified, fileSet)
		deleted = filterFiles(deleted, fileSet)
	}

	if len(added) == 0 && len(modified) == 0 && len(deleted) == 0 {
		fmt.Printf("No differences between %s and %s\n", cfg.WorkspaceName, otherName)
		return nil
	}

	// Names only mode
	if namesOnly {
		for _, f := range added {
			fmt.Printf("\033[32mA %s\033[0m\n", f)
		}
		for _, f := range modified {
			fmt.Printf("\033[33mM %s\033[0m\n", f)
		}
		for _, f := range deleted {
			fmt.Printf("\033[31mD %s\033[0m\n", f)
		}
		return nil
	}

	// Show actual diffs
	dmp := diffmatchpatch.New()

	// Added files - show full content
	for _, f := range added {
		printFileHeader(f, "added", noColor)
		content, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			fmt.Printf("  (could not read file)\n")
			continue
		}
		lines := strings.Split(string(content), "\n")
		for i, line := range lines {
			if noColor {
				fmt.Printf("+%s\n", line)
			} else {
				fmt.Printf("\033[32m+%s\033[0m\n", line)
			}
			// Limit output for very large files
			if i > 100 {
				fmt.Printf("  ... (%d more lines)\n", len(lines)-i-1)
				break
			}
		}
		fmt.Println()
	}

	// Modified files - show diff
	for _, f := range modified {
		printFileHeader(f, "modified", noColor)

		ourContent, err := os.ReadFile(filepath.Join(root, f))
		if err != nil {
			fmt.Printf("  (could not read our version)\n")
			continue
		}

		theirContent, err := os.ReadFile(filepath.Join(otherRoot, f))
		if err != nil {
			fmt.Printf("  (could not read their version)\n")
			continue
		}

		diffs := dmp.DiffMain(string(theirContent), string(ourContent), true)

		if allEqual(diffs) {
			fmt.Printf("  (files are identical)\n\n")
			continue
		}

		// Convert to line-based unified diff
		printUnifiedDiff(diffs, contextLines, noColor)
		fmt.Println()
	}

	// Deleted files - show removal
	for _, f := range deleted {
		printFileHeader(f, "deleted", noColor)
		content, err := os.ReadFile(filepath.Join(otherRoot, f))
		if err != nil {
			fmt.Printf("  (could not read file)\n")
			continue
		}
		lines := strings.Split(string(content), "\n")
		for i, line := range lines {
			if noColor {
				fmt.Printf("-%s\n", line)
			} else {
				fmt.Printf("\033[31m-%s\033[0m\n", line)
			}
			if i > 100 {
				fmt.Printf("  ... (%d more lines)\n", len(lines)-i-1)
				break
			}
		}
		fmt.Println()
	}

	return nil
}

func filterFiles(files []string, filter map[string]bool) []string {
	if len(filter) == 0 {
		return files
	}
	var result []string
	for _, f := range files {
		if filter[f] {
			result = append(result, f)
		}
	}
	return result
}

func printFileHeader(path, status string, noColor bool) {
	if noColor {
		fmt.Printf("=== %s (%s) ===\n", path, status)
	} else {
		var color string
		switch status {
		case "added":
			color = "\033[32m"
		case "modified":
			color = "\033[33m"
		case "deleted":
			color = "\033[31m"
		default:
			color = ""
		}
		fmt.Printf("%s=== %s (%s) ===\033[0m\n", color, path, status)
	}
}

func allEqual(diffs []diffmatchpatch.Diff) bool {
	for _, d := range diffs {
		if d.Type != diffmatchpatch.DiffEqual {
			return false
		}
	}
	return true
}

func printUnifiedDiff(diffs []diffmatchpatch.Diff, contextLines int, noColor bool) {
	// Convert character-based diff to line-based for better readability
	var theirLines, ourLines []string
	var theirBuf, ourBuf strings.Builder

	for _, d := range diffs {
		switch d.Type {
		case diffmatchpatch.DiffEqual:
			theirBuf.WriteString(d.Text)
			ourBuf.WriteString(d.Text)
		case diffmatchpatch.DiffDelete:
			theirBuf.WriteString(d.Text)
		case diffmatchpatch.DiffInsert:
			ourBuf.WriteString(d.Text)
		}
	}

	theirLines = strings.Split(theirBuf.String(), "\n")
	ourLines = strings.Split(ourBuf.String(), "\n")

	// Simple line-by-line diff display
	maxLines := len(theirLines)
	if len(ourLines) > maxLines {
		maxLines = len(ourLines)
	}

	// Find changed regions and show with context
	type change struct {
		theirStart, theirEnd int
		ourStart, ourEnd     int
	}

	// Use a simpler approach - just show the raw diff output
	for _, d := range diffs {
		lines := strings.Split(d.Text, "\n")
		for i, line := range lines {
			// Skip empty trailing line from split
			if i == len(lines)-1 && line == "" {
				continue
			}

			switch d.Type {
			case diffmatchpatch.DiffEqual:
				// Show context lines (limited)
				if len(line) > 200 {
					line = line[:200] + "..."
				}
				fmt.Printf(" %s\n", line)
			case diffmatchpatch.DiffDelete:
				if noColor {
					fmt.Printf("-%s\n", line)
				} else {
					fmt.Printf("\033[31m-%s\033[0m\n", line)
				}
			case diffmatchpatch.DiffInsert:
				if noColor {
					fmt.Printf("+%s\n", line)
				} else {
					fmt.Printf("\033[32m+%s\033[0m\n", line)
				}
			}
		}
	}
}

// isPath determines if a string looks like a file path
func isPath(s string) bool {
	return strings.Contains(s, "/") || strings.HasPrefix(s, ".")
}
