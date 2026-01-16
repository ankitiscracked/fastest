package ignore

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
)

// DefaultPatterns are always ignored
var DefaultPatterns = []string{
	".fst/",
	".git/",
	".svn/",
	".hg/",
	"node_modules/",
	"__pycache__/",
	".DS_Store",
	"Thumbs.db",
	"*.pyc",
	"*.pyo",
	"*.class",
	"*.o",
	"*.obj",
	"*.exe",
	"*.dll",
	"*.so",
	"*.dylib",
}

// Matcher handles .fstignore pattern matching
type Matcher struct {
	patterns []pattern
}

type pattern struct {
	raw      string
	negated  bool
	dirOnly  bool
	prefix   string
	suffix   string
	contains string
}

// NewMatcher creates a new ignore matcher from patterns
func NewMatcher(patterns []string) *Matcher {
	m := &Matcher{}
	for _, p := range patterns {
		m.addPattern(p)
	}
	return m
}

// LoadFromFile loads ignore patterns from a file
func LoadFromFile(path string) (*Matcher, error) {
	file, err := os.Open(path)
	if err != nil {
		if os.IsNotExist(err) {
			return NewMatcher(DefaultPatterns), nil
		}
		return nil, err
	}
	defer file.Close()

	patterns := append([]string{}, DefaultPatterns...)

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		patterns = append(patterns, line)
	}

	return NewMatcher(patterns), scanner.Err()
}

// LoadFromDir loads ignore patterns from .fstignore in the given directory
func LoadFromDir(dir string) (*Matcher, error) {
	return LoadFromFile(filepath.Join(dir, ".fstignore"))
}

func (m *Matcher) addPattern(raw string) {
	p := pattern{raw: raw}

	// Handle negation
	if strings.HasPrefix(raw, "!") {
		p.negated = true
		raw = raw[1:]
	}

	// Handle directory-only patterns
	if strings.HasSuffix(raw, "/") {
		p.dirOnly = true
		raw = strings.TrimSuffix(raw, "/")
	}

	// Determine pattern type
	if strings.HasPrefix(raw, "*") && strings.HasSuffix(raw, "*") {
		// *pattern* - contains
		p.contains = raw[1 : len(raw)-1]
	} else if strings.HasPrefix(raw, "*") {
		// *pattern - suffix
		p.suffix = raw[1:]
	} else if strings.HasSuffix(raw, "*") {
		// pattern* - prefix
		p.prefix = raw[:len(raw)-1]
	} else {
		// exact match or directory
		p.prefix = raw
	}

	m.patterns = append(m.patterns, p)
}

// Match checks if a path should be ignored
func (m *Matcher) Match(path string, isDir bool) bool {
	// Normalize path separators
	path = filepath.ToSlash(path)

	// Get just the filename for matching
	name := filepath.Base(path)

	ignored := false
	for _, p := range m.patterns {
		if p.dirOnly && !isDir {
			continue
		}

		matched := false

		// Try matching against full path and name
		if p.contains != "" {
			matched = strings.Contains(name, p.contains) || strings.Contains(path, p.contains)
		} else if p.suffix != "" {
			matched = strings.HasSuffix(name, p.suffix) || strings.HasSuffix(path, p.suffix)
		} else if p.prefix != "" {
			// Check if it matches the name, path, or is a path prefix
			matched = name == p.prefix ||
				path == p.prefix ||
				strings.HasPrefix(path, p.prefix+"/") ||
				strings.Contains(path, "/"+p.prefix+"/") ||
				strings.HasSuffix(path, "/"+p.prefix)
		}

		if matched {
			ignored = !p.negated
		}
	}

	return ignored
}

// ShouldInclude returns true if the path should be included (not ignored)
func (m *Matcher) ShouldInclude(path string, isDir bool) bool {
	return !m.Match(path, isDir)
}
