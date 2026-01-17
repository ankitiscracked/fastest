/**
 * Manifest types - matching Go implementation in cli/internal/manifest/manifest.go
 */

/**
 * FileEntry represents a single file in the manifest
 */
export interface FileEntry {
  path: string;
  hash: string;     // SHA-256 hex string
  size: number;
  mode: number;     // Unix file permissions
  mod_time?: number; // Unix timestamp, optional for reproducibility
}

/**
 * Manifest represents a complete project snapshot
 */
export interface Manifest {
  version: string;  // Currently "1"
  files: FileEntry[];
}

/**
 * Result of comparing two manifests
 */
export interface ManifestDiff {
  added: string[];
  modified: string[];
  deleted: string[];
}

/**
 * Options for manifest generation
 */
export interface GenerateOptions {
  includeModTime?: boolean;
  ignorePatterns?: string[];
}

/**
 * File content for manifest generation (used when files are in memory)
 */
export interface FileContent {
  path: string;
  content: Uint8Array | string;
  mode?: number;
  modTime?: number;
}
