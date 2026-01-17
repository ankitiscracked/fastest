/**
 * Manifest module - content-addressed snapshot format
 *
 * This module implements the manifest format used by fst for tracking
 * project snapshots. It matches the Go implementation in cli/internal/manifest.
 *
 * @example
 * ```typescript
 * import { manifest } from '@fastest/shared';
 *
 * // Generate manifest from files
 * const files = [
 *   { path: 'src/index.ts', content: 'console.log("hello")' },
 *   { path: 'package.json', content: '{"name": "test"}' },
 * ];
 * const m = await manifest.generateFromFiles(files);
 *
 * // Get manifest hash
 * const hash = await manifest.hashManifest(m);
 *
 * // Compare manifests
 * const changes = manifest.diff(baseManifest, currentManifest);
 * console.log('Added:', changes.added);
 * console.log('Modified:', changes.modified);
 * console.log('Deleted:', changes.deleted);
 * ```
 */

// Types
export type {
  FileEntry,
  Manifest,
  ManifestDiff,
  GenerateOptions,
  FileContent,
} from './types';

// Ignore patterns
export { IgnoreMatcher, DEFAULT_PATTERNS } from './ignore';

// Manifest functions
export {
  sha256,
  generateFromFiles,
  toJSON,
  fromJSON,
  hashManifest,
  diff,
  totalSize,
  fileCount,
  getFile,
  getBlobHashes,
  getNewBlobHashes,
  empty,
} from './manifest';
