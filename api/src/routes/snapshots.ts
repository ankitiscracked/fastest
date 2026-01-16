import { Hono } from 'hono';
import type { Env } from '../index';
import type { Snapshot, CreateSnapshotRequest } from '@fastest/shared';

export const snapshotRoutes = new Hono<{ Bindings: Env }>();

// Get snapshot by ID
snapshotRoutes.get('/:snapshotId', async (c) => {
  const snapshotId = c.req.param('snapshotId');

  // TODO: Fetch from database
  return c.json({
    error: { code: 'NOT_FOUND', message: 'Snapshot not found' }
  }, 404);
});
