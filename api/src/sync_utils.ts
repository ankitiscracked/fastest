/**
 * File Sync Utilities
 *
 * This module provides utilities for robust file syncing between OpenCode and R2 storage:
 * - Retry logic with exponential backoff for network operations
 * - Parallel processing with concurrency limits
 * - Manifest integrity validation
 * - Rollback support for partial failures
 * - Optimistic locking helpers
 */

import type { Env } from './index';

// ============================================================================
// RETRY LOGIC WITH EXPONENTIAL BACKOFF
// ============================================================================

export interface RetryOptions {
  maxRetries?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  retryOn?: (error: Error, attempt: number) => boolean;
}

const DEFAULT_RETRY_OPTIONS: Required<RetryOptions> = {
  maxRetries: 3,
  initialDelayMs: 1000,
  maxDelayMs: 10000,
  backoffMultiplier: 2,
  retryOn: (error: Error) => {
    // Retry on network errors and 5xx server errors
    const message = error.message.toLowerCase();
    return (
      message.includes('network') ||
      message.includes('timeout') ||
      message.includes('fetch failed') ||
      message.includes('500') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    );
  },
};

/**
 * Execute an async function with retry logic and exponential backoff
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const opts = { ...DEFAULT_RETRY_OPTIONS, ...options };
  let lastError: Error | null = null;
  let delay = opts.initialDelayMs;

  for (let attempt = 1; attempt <= opts.maxRetries + 1; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt > opts.maxRetries || !opts.retryOn(lastError, attempt)) {
        throw lastError;
      }

      // Wait with exponential backoff
      await sleep(delay);
      delay = Math.min(delay * opts.backoffMultiplier, opts.maxDelayMs);
    }
  }

  throw lastError || new Error('Retry failed');
}

/**
 * Fetch with retry support
 */
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  options: RetryOptions = {}
): Promise<Response> {
  return withRetry(async () => {
    const response = await fetch(url, init);

    // Treat 5xx errors as retryable
    if (response.status >= 500) {
      throw new Error(`Server error: ${response.status}`);
    }

    return response;
  }, options);
}

// ============================================================================
// PARALLEL PROCESSING WITH CONCURRENCY LIMIT
// ============================================================================

export interface PMapOptions {
  concurrency?: number;
  stopOnError?: boolean;
}

/**
 * Map over an array with limited concurrency (like p-map)
 */
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  options: PMapOptions = {}
): Promise<R[]> {
  const { concurrency = 10, stopOnError = true } = options;
  const results: R[] = new Array(items.length);
  const errors: Error[] = [];
  let currentIndex = 0;
  let activeCount = 0;
  let resolveAll: () => void;
  let rejectAll: (error: Error) => void;

  const promise = new Promise<R[]>((resolve, reject) => {
    resolveAll = () => resolve(results);
    rejectAll = reject;
  });

  const processNext = async () => {
    while (currentIndex < items.length && activeCount < concurrency) {
      if (stopOnError && errors.length > 0) break;

      const index = currentIndex++;
      activeCount++;

      try {
        results[index] = await mapper(items[index], index);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        errors.push(err);
        if (stopOnError) {
          rejectAll(err);
          return;
        }
      }

      activeCount--;

      if (currentIndex >= items.length && activeCount === 0) {
        if (errors.length > 0 && !stopOnError) {
          rejectAll(new AggregateError(errors, `${errors.length} operations failed`));
        } else {
          resolveAll();
        }
      } else {
        processNext();
      }
    }
  };

  // Start initial batch
  const initialBatch = Math.min(concurrency, items.length);
  for (let i = 0; i < initialBatch; i++) {
    processNext();
  }

  // Handle empty input
  if (items.length === 0) {
    resolveAll!();
  }

  return promise;
}

// ============================================================================
// MANIFEST INTEGRITY VALIDATION
// ============================================================================

export interface ManifestFile {
  path: string;
  hash: string;
  size: number;
  mode?: number;
}

export interface SyncManifest {
  version?: string;
  files: ManifestFile[];
}

export interface ValidationResult {
  valid: boolean;
  missingBlobs: string[];
  errors: string[];
}

/**
 * Validate that all blobs referenced in a manifest exist in R2
 */
export async function validateManifestIntegrity(
  blobs: R2Bucket,
  userId: string,
  manifest: SyncManifest
): Promise<ValidationResult> {
  const files = manifest.files;

  const uniqueHashes = [...new Set(files.map(f => f.hash))];
  const missingBlobs: string[] = [];
  const errors: string[] = [];

  // Check blobs in parallel with limited concurrency
  await pMap(
    uniqueHashes,
    async (hash) => {
      try {
        const key = `${userId}/blobs/${hash}`;
        const obj = await blobs.head(key);
        if (!obj) {
          missingBlobs.push(hash);
        }
      } catch (error) {
        errors.push(`Failed to check blob ${hash}: ${error}`);
      }
    },
    { concurrency: 20, stopOnError: false }
  );

  return {
    valid: missingBlobs.length === 0 && errors.length === 0,
    missingBlobs,
    errors,
  };
}

// ============================================================================
// ROLLBACK SUPPORT
// ============================================================================

export interface RollbackContext {
  uploadedBlobs: string[];
  createdManifests: string[];
}

/**
 * Create a rollback context to track uploaded resources
 */
export function createRollbackContext(): RollbackContext {
  return {
    uploadedBlobs: [],
    createdManifests: [],
  };
}

/**
 * Execute rollback - delete all resources tracked in context
 */
export async function executeRollback(
  blobs: R2Bucket,
  userId: string,
  context: RollbackContext
): Promise<{ deleted: number; errors: string[] }> {
  const errors: string[] = [];
  let deleted = 0;

  // Delete uploaded blobs
  for (const hash of context.uploadedBlobs) {
    try {
      await blobs.delete(`${userId}/blobs/${hash}`);
      deleted++;
    } catch (error) {
      errors.push(`Failed to rollback blob ${hash}: ${error}`);
    }
  }

  // Delete created manifests
  for (const hash of context.createdManifests) {
    try {
      await blobs.delete(`${userId}/manifests/${hash}.json`);
      deleted++;
    } catch (error) {
      errors.push(`Failed to rollback manifest ${hash}: ${error}`);
    }
  }

  return { deleted, errors };
}

/**
 * Upload a blob with rollback tracking
 */
export async function uploadBlobWithRollback(
  blobs: R2Bucket,
  userId: string,
  hash: string,
  content: ArrayBuffer | Uint8Array,
  context: RollbackContext
): Promise<void> {
  const key = `${userId}/blobs/${hash}`;

  // Check if already exists
  const existing = await blobs.head(key);
  if (existing) {
    return; // Already exists, no need to track for rollback
  }

  await blobs.put(key, content);
  context.uploadedBlobs.push(hash);
}

// ============================================================================
// OPTIMISTIC LOCKING HELPERS
// ============================================================================

export interface OptimisticLockError extends Error {
  code: 'OPTIMISTIC_LOCK_FAILED';
  expectedVersion: number;
  actualVersion?: number;
}

/**
 * Create an optimistic lock error
 */
export function createOptimisticLockError(
  expectedVersion: number,
  actualVersion?: number
): OptimisticLockError {
  const error = new Error(
    `Concurrent modification detected. Expected version ${expectedVersion}` +
    (actualVersion !== undefined ? `, but found version ${actualVersion}` : '')
  ) as OptimisticLockError;
  error.code = 'OPTIMISTIC_LOCK_FAILED';
  error.expectedVersion = expectedVersion;
  error.actualVersion = actualVersion;
  return error;
}

// ============================================================================
// FILE UPLOAD TRACKING
// ============================================================================

export interface UploadStats {
  totalFiles: number;
  uploadedFiles: number;
  skippedFiles: SkippedFile[];
  failedFiles: FailedFile[];
  existingFiles: number;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

export interface FailedFile {
  path: string;
  hash: string;
  error: string;
}

/**
 * Create upload stats tracker
 */
export function createUploadStats(): UploadStats {
  return {
    totalFiles: 0,
    uploadedFiles: 0,
    skippedFiles: [],
    failedFiles: [],
    existingFiles: 0,
  };
}

// ============================================================================
// BLOB GARBAGE COLLECTION
// ============================================================================

export interface GarbageCollectionResult {
  scannedBlobs: number;
  deletedBlobs: number;
  freedBytes: number;
  errors: string[];
  dryRun: boolean;
}

/**
 * Find and optionally delete orphaned blobs not referenced by any manifest
 *
 * Note: This is a potentially expensive operation and should be run
 * as a scheduled job, not on every request.
 */
export async function collectGarbage(
  blobs: R2Bucket,
  userId: string,
  options: {
    dryRun?: boolean;
    maxBlobs?: number;
  } = {}
): Promise<GarbageCollectionResult> {
  const { dryRun = true, maxBlobs = 10000 } = options;

  const result: GarbageCollectionResult = {
    scannedBlobs: 0,
    deletedBlobs: 0,
    freedBytes: 0,
    errors: [],
    dryRun,
  };

  // Step 1: Collect all manifest hashes that are referenced
  const referencedHashes = new Set<string>();

  try {
    // List all manifests for this user
    const manifestPrefix = `${userId}/manifests/`;
    let cursor: string | undefined;
    let manifestCount = 0;

    do {
      const manifestList = await blobs.list({
        prefix: manifestPrefix,
        cursor,
        limit: 1000,
      });

      for (const obj of manifestList.objects) {
        if (manifestCount >= maxBlobs) break;
        manifestCount++;

        try {
          const manifestObj = await blobs.get(obj.key);
          if (manifestObj) {
            const manifest = JSON.parse(await manifestObj.text()) as { files: ManifestFile[] };
            for (const file of manifest.files) {
              referencedHashes.add(file.hash);
            }
          }
        } catch (error) {
          result.errors.push(`Failed to parse manifest ${obj.key}: ${error}`);
        }
      }

      cursor = manifestList.truncated ? manifestList.cursor : undefined;
    } while (cursor && manifestCount < maxBlobs);

  } catch (error) {
    result.errors.push(`Failed to list manifests: ${error}`);
    return result;
  }

  // Step 2: Scan blobs and find orphans
  const blobPrefix = `${userId}/blobs/`;
  let cursor: string | undefined;

  try {
    do {
      const blobList = await blobs.list({
        prefix: blobPrefix,
        cursor,
        limit: 1000,
      });

      for (const obj of blobList.objects) {
        if (result.scannedBlobs >= maxBlobs) break;
        result.scannedBlobs++;

        // Extract hash from key (userId/blobs/hash)
        const hash = obj.key.replace(blobPrefix, '');

        if (!referencedHashes.has(hash)) {
          // This blob is orphaned
          if (!dryRun) {
            try {
              await blobs.delete(obj.key);
              result.deletedBlobs++;
              result.freedBytes += obj.size;
            } catch (error) {
              result.errors.push(`Failed to delete orphan ${obj.key}: ${error}`);
            }
          } else {
            result.deletedBlobs++;
            result.freedBytes += obj.size;
          }
        }
      }

      cursor = blobList.truncated ? blobList.cursor : undefined;
    } while (cursor && result.scannedBlobs < maxBlobs);

  } catch (error) {
    result.errors.push(`Failed to list blobs: ${error}`);
  }

  return result;
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Compute SHA256 hash of data
 */
export async function computeSHA256(data: ArrayBuffer | Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute SHA256 hash of text
 */
export async function computeSHA256Text(text: string): Promise<string> {
  const encoder = new TextEncoder();
  return computeSHA256(encoder.encode(text));
}

// AggregateError polyfill for older environments
class AggregateError extends Error {
  errors: Error[];

  constructor(errors: Error[], message: string) {
    super(message);
    this.name = 'AggregateError';
    this.errors = errors;
  }
}
