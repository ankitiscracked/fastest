# Ignore Patterns

How `fst` decides which files to include in snapshots and manifests. Source: `cli/internal/ignore/ignore.go`, `cli/internal/ignore/default.fstignore`.

## File location

Place a `.fstignore` file at the workspace root (same directory as `.fst/`). It is created automatically by `fst workspace init` if not already present.

## Pattern syntax

Each line is a pattern. Empty lines and lines starting with `#` are ignored.

| Syntax | Meaning | Example |
|--------|---------|---------|
| `name` | Match file or directory by exact name | `Thumbs.db` |
| `!name` | Negate a previous match (re-include) | `!important.log` |
| `name/` | Match directories only | `node_modules/` |
| `*.ext` | Match files ending with `.ext` | `*.pyc` |
| `prefix*` | Match files starting with `prefix` | `build*` |
| `*mid*` | Match files containing `mid` | `*cache*` |

Patterns are matched against both the file's basename and its full relative path. A pattern like `build/` will match a directory named `build` at any depth.

## Matching behavior

- Patterns are evaluated in order; **last match wins**
- Negation (`!`) re-includes a file that was previously excluded
- Default patterns (embedded in the binary) are loaded first, then `.fstignore` patterns are appended
- This means `.fstignore` entries can override defaults using negation

### Example

```gitignore
# These are already excluded by defaults, but you could add more:
*.log
temp/

# Re-include a specific log file excluded above:
!debug.log
```

## Default patterns

Embedded from `cli/internal/ignore/default.fstignore`:

```
.fst/
.fst
.git/
.svn/
.hg/
node_modules/
__pycache__/
.DS_Store
Thumbs.db
*.pyc
*.pyo
*.class
*.o
*.obj
*.exe
*.dll
*.so
*.dylib
```

These are always active. User `.fstignore` patterns are appended after these defaults, so user patterns can negate them with `!`.

## Implementation details

The `Matcher` struct in `cli/internal/ignore/ignore.go` parses patterns into a list of `pattern` structs with fields: `raw`, `negated`, `dirOnly`, `prefix`, `suffix`, `contains`. The `Match(path string, isDir bool)` method iterates all patterns and returns the result of the last matching pattern. Directory-only patterns (trailing `/`) only match when `isDir` is true.
