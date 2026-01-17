/**
 * Manifest generation and manipulation - matching Go implementation
 */

import type { FileEntry, Manifest, ManifestDiff, FileContent, GenerateOptions } from './types';
import { IgnoreMatcher, DEFAULT_PATTERNS } from './ignore';

/**
 * Compute SHA-256 hash of data
 * Works in both Node.js and browser/Cloudflare Workers environments
 */
export async function sha256(data: Uint8Array | string): Promise<string> {
  let buffer: ArrayBuffer;

  if (typeof data === 'string') {
    buffer = new TextEncoder().encode(data).buffer as ArrayBuffer;
  } else {
    // Handle both ArrayBuffer and Uint8Array
    buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
  }

  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = new Uint8Array(hashBuffer);

  return Array.from(hashArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Generate a manifest from a list of files with their content
 * This is the main function for cloud-side manifest generation
 */
export async function generateFromFiles(
  files: FileContent[],
  options: GenerateOptions = {}
): Promise<Manifest> {
  const { includeModTime = false, ignorePatterns } = options;

  // Create matcher with custom patterns if provided
  const patterns = ignorePatterns
    ? [...DEFAULT_PATTERNS, ...ignorePatterns]
    : DEFAULT_PATTERNS;
  const matcher = new IgnoreMatcher(patterns);

  const entries: FileEntry[] = [];

  for (const file of files) {
    // Normalize path
    const path = file.path.replace(/\\/g, '/');

    // Skip ignored files
    if (matcher.match(path, false)) {
      continue;
    }

    // Compute hash
    const content = typeof file.content === 'string'
      ? new TextEncoder().encode(file.content)
      : file.content;
    const hash = await sha256(content);

    const entry: FileEntry = {
      path,
      hash,
      size: content.length,
      mode: file.mode ?? 0o644, // Default to readable file
    };

    if (includeModTime && file.modTime !== undefined) {
      entry.mod_time = file.modTime;
    }

    entries.push(entry);
  }

  // Sort files for reproducibility (matching Go implementation)
  entries.sort((a, b) => a.path.localeCompare(b.path));

  return {
    version: '1',
    files: entries,
  };
}

/**
 * Convert manifest to canonical JSON (matching Go's json.MarshalIndent)
 */
export function toJSON(manifest: Manifest): string {
  return JSON.stringify(manifest, null, '  ');
}

/**
 * Compute the SHA-256 hash of a manifest
 */
export async function hashManifest(manifest: Manifest): Promise<string> {
  const json = toJSON(manifest);
  return sha256(json);
}

/**
 * Parse a manifest from JSON
 */
export function fromJSON(data: string): Manifest {
  const parsed = JSON.parse(data);

  // Validate basic structure
  if (typeof parsed.version !== 'string' || !Array.isArray(parsed.files)) {
    throw new Error('Invalid manifest format');
  }

  return parsed as Manifest;
}

/**
 * Compare two manifests and return the differences
 */
export function diff(base: Manifest, current: Manifest): ManifestDiff {
  const baseMap = new Map<string, FileEntry>();
  for (const f of base.files) {
    baseMap.set(f.path, f);
  }

  const currentMap = new Map<string, FileEntry>();
  for (const f of current.files) {
    currentMap.set(f.path, f);
  }

  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  // Find added and modified files
  for (const f of current.files) {
    const baseFile = baseMap.get(f.path);
    if (!baseFile) {
      added.push(f.path);
    } else if (baseFile.hash !== f.hash) {
      modified.push(f.path);
    }
  }

  // Find deleted files
  for (const f of base.files) {
    if (!currentMap.has(f.path)) {
      deleted.push(f.path);
    }
  }

  // Sort for consistent output
  added.sort();
  modified.sort();
  deleted.sort();

  return { added, modified, deleted };
}

/**
 * Get total size of all files in the manifest
 */
export function totalSize(manifest: Manifest): number {
  return manifest.files.reduce((sum, f) => sum + f.size, 0);
}

/**
 * Get the number of files in the manifest
 */
export function fileCount(manifest: Manifest): number {
  return manifest.files.length;
}

/**
 * Get a file entry by path
 */
export function getFile(manifest: Manifest, path: string): FileEntry | undefined {
  return manifest.files.find(f => f.path === path);
}

/**
 * Get all unique blob hashes from a manifest
 */
export function getBlobHashes(manifest: Manifest): string[] {
  const hashes = new Set<string>();
  for (const f of manifest.files) {
    hashes.add(f.hash);
  }
  return Array.from(hashes).sort();
}

/**
 * Find blobs that exist in current but not in base (for incremental upload)
 */
export function getNewBlobHashes(base: Manifest, current: Manifest): string[] {
  const baseHashes = new Set(base.files.map(f => f.hash));
  const newHashes = new Set<string>();

  for (const f of current.files) {
    if (!baseHashes.has(f.hash)) {
      newHashes.add(f.hash);
    }
  }

  return Array.from(newHashes).sort();
}

/**
 * Create an empty manifest
 */
export function empty(): Manifest {
  return {
    version: '1',
    files: [],
  };
}
