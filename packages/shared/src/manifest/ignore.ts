/**
 * Ignore pattern matching - matching Go implementation in cli/internal/ignore/ignore.go
 */

/**
 * Default patterns that are always ignored
 */
export const DEFAULT_PATTERNS = [
  '.fst/',
  '.fst',      // For linked workspaces where .fst is a file
  '.git/',
  '.svn/',
  '.hg/',
  'node_modules/',
  '__pycache__/',
  '.DS_Store',
  'Thumbs.db',
  '*.pyc',
  '*.pyo',
  '*.class',
  '*.o',
  '*.obj',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
];

interface Pattern {
  raw: string;
  negated: boolean;
  dirOnly: boolean;
  prefix: string;
  suffix: string;
  contains: string;
}

/**
 * Matcher handles .fstignore pattern matching
 */
export class IgnoreMatcher {
  private patterns: Pattern[] = [];

  constructor(patterns: string[] = DEFAULT_PATTERNS) {
    for (const p of patterns) {
      this.addPattern(p);
    }
  }

  /**
   * Create a matcher from .fstignore file content
   */
  static fromFileContent(content: string): IgnoreMatcher {
    const patterns = [...DEFAULT_PATTERNS];

    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) {
        continue;
      }
      patterns.push(trimmed);
    }

    return new IgnoreMatcher(patterns);
  }

  private addPattern(raw: string): void {
    const p: Pattern = {
      raw,
      negated: false,
      dirOnly: false,
      prefix: '',
      suffix: '',
      contains: '',
    };

    let pattern = raw;

    // Handle negation
    if (pattern.startsWith('!')) {
      p.negated = true;
      pattern = pattern.slice(1);
    }

    // Handle directory-only patterns
    if (pattern.endsWith('/')) {
      p.dirOnly = true;
      pattern = pattern.slice(0, -1);
    }

    // Determine pattern type
    if (pattern.startsWith('*') && pattern.endsWith('*') && pattern.length > 2) {
      // *pattern* - contains
      p.contains = pattern.slice(1, -1);
    } else if (pattern.startsWith('*')) {
      // *pattern - suffix
      p.suffix = pattern.slice(1);
    } else if (pattern.endsWith('*')) {
      // pattern* - prefix
      p.prefix = pattern.slice(0, -1);
    } else {
      // exact match or directory
      p.prefix = pattern;
    }

    this.patterns.push(p);
  }

  /**
   * Check if a path should be ignored
   */
  match(path: string, isDir: boolean): boolean {
    // Normalize path separators
    const normalizedPath = path.replace(/\\/g, '/');

    // Get just the filename for matching
    const parts = normalizedPath.split('/');
    const name = parts[parts.length - 1];

    let ignored = false;

    for (const p of this.patterns) {
      let matched = false;

      // For directory-only patterns, check if this file is inside an ignored directory
      if (p.dirOnly) {
        if (isDir) {
          // Check if this directory matches
          if (p.prefix) {
            matched = name === p.prefix ||
              normalizedPath === p.prefix ||
              normalizedPath.startsWith(p.prefix + '/') ||
              normalizedPath.includes('/' + p.prefix + '/') ||
              normalizedPath.endsWith('/' + p.prefix);
          }
        } else {
          // For files, check if any parent directory matches
          // e.g., ".git/config" should match ".git/" pattern
          if (p.prefix) {
            matched = normalizedPath.startsWith(p.prefix + '/') ||
              normalizedPath.includes('/' + p.prefix + '/');
          }
        }
      } else {
        // Non-directory patterns - match against path and name
        if (p.contains) {
          matched = name.includes(p.contains) || normalizedPath.includes(p.contains);
        } else if (p.suffix) {
          matched = name.endsWith(p.suffix) || normalizedPath.endsWith(p.suffix);
        } else if (p.prefix) {
          // Check if it matches the name, path, or is a path prefix
          matched = name === p.prefix ||
            normalizedPath === p.prefix ||
            normalizedPath.startsWith(p.prefix + '/') ||
            normalizedPath.includes('/' + p.prefix + '/') ||
            normalizedPath.endsWith('/' + p.prefix);
        }
      }

      if (matched) {
        ignored = !p.negated;
      }
    }

    return ignored;
  }

  /**
   * Check if a path should be included (not ignored)
   */
  shouldInclude(path: string, isDir: boolean): boolean {
    return !this.match(path, isDir);
  }
}
