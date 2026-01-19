import { Hono } from 'hono';
import type { Env } from '../index';
import type { BlobExistsRequest, PresignUploadRequest, PresignDownloadRequest } from '@fastest/shared';
import { getAuthUser } from '../middleware/auth';

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
        message: `Manifest hash does not match`
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
    return c.json({ error: { code: 'NOT_FOUND', message: 'Manifest not found' } }, 404);
  }

  return new Response(obj.body, {
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=31536000, immutable',
    }
  });
});

// Helper: Compute SHA-256 hash
async function computeSHA256(data: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}
