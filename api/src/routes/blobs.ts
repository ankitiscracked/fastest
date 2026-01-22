import { Hono } from 'hono';
import type { Env } from '../index';
import type { BlobExistsRequest, PresignUploadRequest, PresignDownloadRequest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';
import { collectGarbage } from '../sync_utils';

export const blobRoutes = new Hono<{ Bindings: Env }>();

// Check which blobs exist (user-scoped)
blobRoutes.post('/exists', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<BlobExistsRequest>();

  if (!body.hashes || !Array.isArray(body.hashes)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hashes array is required' } }, 422);
  }

  // Check R2 for existing blobs in user's scope (limit to 100)
  const hashes = body.hashes.slice(0, 100);
  const missing: string[] = [];
  const existing: string[] = [];

  await Promise.all(
    hashes.map(async (hash) => {
      const obj = await c.env.BLOBS.head(`${user.id}/blobs/${hash}`);
      if (!obj) {
        missing.push(hash);
      } else {
        existing.push(hash);
      }
    })
  );

  return c.json({ missing, existing, checked: hashes.length });
});

// Get presigned URLs for uploading blobs
blobRoutes.post('/presign-upload', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<PresignUploadRequest>();

  if (!body.hashes || !Array.isArray(body.hashes)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hashes array is required' } }, 422);
  }

  // For R2, we'll use direct upload through the worker
  const urls: Record<string, string> = {};

  for (const hash of body.hashes.slice(0, 100)) {
    urls[hash] = `/v1/blobs/upload/${hash}`;
  }

  return c.json({ urls });
});

// Get presigned URLs for downloading blobs
blobRoutes.post('/presign-download', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<PresignDownloadRequest>();

  if (!body.hashes || !Array.isArray(body.hashes)) {
    return c.json({ error: { code: 'VALIDATION_ERROR', message: 'hashes array is required' } }, 422);
  }

  const urls: Record<string, string> = {};

  for (const hash of body.hashes.slice(0, 100)) {
    urls[hash] = `/v1/blobs/download/${hash}`;
  }

  return c.json({ urls });
});

// Upload a blob (user-scoped)
blobRoutes.put('/upload/:hash', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const hash = c.req.param('hash');
  const body = await c.req.arrayBuffer();

  // Verify hash matches content
  const computedHash = await computeSHA256(body);
  if (computedHash !== hash) {
    return c.json({
      error: {
        code: 'HASH_MISMATCH',
        message: `Content hash ${computedHash.slice(0, 16)}... does not match requested hash ${hash.slice(0, 16)}...`
      }
    }, 400);
  }

  const key = `${user.id}/blobs/${hash}`;

  // Check if already exists
  const existing = await c.env.BLOBS.head(key);
  if (existing) {
    return c.json({ hash, size: existing.size, created: false });
  }

  await c.env.BLOBS.put(key, body);

  return c.json({ hash, size: body.byteLength, created: true }, 201);
});

// Download a blob (user-scoped)
blobRoutes.get('/download/:hash', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const hash = c.req.param('hash');
  const key = `${user.id}/blobs/${hash}`;

  const obj = await c.env.BLOBS.get(key);

  if (!obj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Blob not found' } }, 404);
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': obj.size.toString(),
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
  });
});

// Manifests (user-scoped)

// Upload a manifest
blobRoutes.put('/manifests/:hash', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const hash = c.req.param('hash');
  const body = await c.req.text();

  // Verify hash matches content
  const encoder = new TextEncoder();
  const data = encoder.encode(body);
  const computedHash = await computeSHA256(data.buffer as ArrayBuffer);
  if (computedHash !== hash) {
    return c.json({
      error: {
        code: 'HASH_MISMATCH',
        message: `Content hash does not match`
      }
    }, 400);
  }

  const key = `${user.id}/manifests/${hash}.json`;

  // Check if already exists
  const existing = await c.env.BLOBS.head(key);
  if (existing) {
    return c.json({ hash, created: false });
  }

  await c.env.BLOBS.put(key, body, {
    httpMetadata: { contentType: 'application/json' }
  });

  return c.json({ hash, created: true }, 201);
});

// Download a manifest
blobRoutes.get('/manifests/:hash', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const hash = c.req.param('hash');
  const key = `${user.id}/manifests/${hash}.json`;

  const obj = await c.env.BLOBS.get(key);

  if (!obj) {
    return c.json({ error: { code: 'NOT_FOUND', message: 'Snapshot data not found' } }, 404);
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
  });
});

// Garbage Collection - Find and optionally delete orphaned blobs
// Note: This is an expensive operation and should be triggered manually or by a scheduled job
blobRoutes.post('/gc', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  const body = await c.req.json<{ dryRun?: boolean; maxBlobs?: number }>().catch(() => ({ dryRun: true, maxBlobs: 10000 }));
  const dryRun = body.dryRun ?? true;
  const maxBlobs = body.maxBlobs ?? 10000;

  try {
    const result = await collectGarbage(c.env.BLOBS, user.id, {
      dryRun,
      maxBlobs,
    });

    return c.json({
      success: true,
      dryRun: result.dryRun,
      scannedBlobs: result.scannedBlobs,
      orphanedBlobs: result.deletedBlobs,
      freedBytes: result.freedBytes,
      freedMB: Math.round(result.freedBytes / 1024 / 1024 * 100) / 100,
      errors: result.errors.length > 0 ? result.errors : undefined,
      message: result.dryRun
        ? `Found ${result.deletedBlobs} orphaned blobs (${Math.round(result.freedBytes / 1024 / 1024 * 100) / 100} MB). Run with dryRun=false to delete.`
        : `Deleted ${result.deletedBlobs} orphaned blobs, freed ${Math.round(result.freedBytes / 1024 / 1024 * 100) / 100} MB`,
    });
  } catch (error) {
    console.error('Garbage collection failed:', error);
    return c.json({
      error: {
        code: 'GC_FAILED',
        message: error instanceof Error ? error.message : 'Garbage collection failed'
      }
    }, 500);
  }
});

// Storage stats for a user
blobRoutes.get('/stats', async (c) => {
  const user = await getAuthUser(c);
  if (!user) {
    return c.json({ error: { code: 'UNAUTHORIZED', message: 'Authentication required' } }, 401);
  }

  try {
    let totalBlobs = 0;
    let totalBlobBytes = 0;
    let totalManifests = 0;
    let totalManifestBytes = 0;

    // Count blobs
    const blobPrefix = `${user.id}/blobs/`;
    let cursor: string | undefined;
    do {
      const list = await c.env.BLOBS.list({ prefix: blobPrefix, cursor, limit: 1000 });
      for (const obj of list.objects) {
        totalBlobs++;
        totalBlobBytes += obj.size;
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);

    // Count manifests
    const manifestPrefix = `${user.id}/manifests/`;
    cursor = undefined;
    do {
      const list = await c.env.BLOBS.list({ prefix: manifestPrefix, cursor, limit: 1000 });
      for (const obj of list.objects) {
        totalManifests++;
        totalManifestBytes += obj.size;
      }
      cursor = list.truncated ? list.cursor : undefined;
    } while (cursor);

    return c.json({
      blobs: {
        count: totalBlobs,
        bytes: totalBlobBytes,
        mb: Math.round(totalBlobBytes / 1024 / 1024 * 100) / 100,
      },
      manifests: {
        count: totalManifests,
        bytes: totalManifestBytes,
        mb: Math.round(totalManifestBytes / 1024 / 1024 * 100) / 100,
      },
      total: {
        bytes: totalBlobBytes + totalManifestBytes,
        mb: Math.round((totalBlobBytes + totalManifestBytes) / 1024 / 1024 * 100) / 100,
      },
    });
  } catch (error) {
    console.error('Failed to compute storage stats:', error);
    return c.json({
      error: {
        code: 'STATS_FAILED',
        message: error instanceof Error ? error.message : 'Failed to compute storage stats'
      }
    }, 500);
  }
});

// Helper: Compute SHA-256 hash
async function computeSHA256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
